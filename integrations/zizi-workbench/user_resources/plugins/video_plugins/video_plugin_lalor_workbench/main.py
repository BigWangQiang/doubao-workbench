"""字字动画 -> Lalor 工作台视频账号池插件。

2.0 运行时仅连接本机 Lalor 工作台 loopback API，不依赖 CLI、
网站登录或远程任务桥。视频任务复用工作台既有账号池、调度、
下载和中文失败回传链路。
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import urljoin, urlsplit, urlunsplit

try:
    import requests
except Exception as exc:  # pragma: no cover - 字字动画运行包通常已带 requests
    requests = None
    _REQUESTS_IMPORT_ERROR = exc
else:
    _REQUESTS_IMPORT_ERROR = None


PLUGIN_DIR = Path(__file__).resolve().parent
_PLUGIN_FILE = __file__
_PLUGIN_VERSION = "2.1.1"

sys.path.append(str(PLUGIN_DIR.parent.parent))
from plugin_utils import load_plugin_config  # noqa: E402


_DEFAULT_PARAMS = {
    "cli_path": "",
    # 留空时沿用 Lalor CLI 当前工作区，避免旧配置把用户锁在 default。
    "workspace": "",
    "project_id": "",
    "model": "",
    "ratio": "16:9",
    "duration": 5,
    "resolution": "720p",
    "operation": "text_to_video",
    "generate_audio": False,
    "watermark": False,
    "poll_interval": 3,
    "timeout": 1800,
}

_TERMINAL_STATES = {"succeeded", "success", "completed", "failed", "error", "cancelled", "canceled"}
_VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}
_AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}
_URL_KEYS = ("dataUrl", "url", "resultUrl", "outputUrl", "downloadUrl", "videoUrl", "video_url")
_PATH_KEYS = ("path", "file", "filePath", "localPath")
_MEDIA_CONTAINER_KEYS = ("video", "videos", "media", "output", "outputs", "result", "data", "content")
_RESOURCE_ID_KEYS = ("resourceId", "resource_id", "resourceKey", "resource_key")


class LalorPluginError(RuntimeError):
    """面向字字动画用户的可读错误。"""


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _as_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on", "是", "有声"}:
            return True
        if lowered in {"0", "false", "no", "off", "否", "无声"}:
            return False
    return default


def _current_cli_workspace_name() -> str:
    """读取 CLI 当前工作区名称，不读取或输出会话凭据。"""
    appdata = _text(os.environ.get("APPDATA"))
    config_path = Path(appdata) / "lalor-cli" / "config.json" if appdata else Path.home() / ".config" / "lalor-cli" / "config.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        return ""
    return _text(config.get("currentWorkspace"))


def _effective_workspace(params: dict[str, Any]) -> str:
    """尊重插件中明确选择的工作区；留空时才沿用 CLI 当前工作区。"""
    configured = _text(params.get("workspace"))
    return configured or _current_cli_workspace_name()


def get_params() -> dict[str, Any]:
    params = dict(_DEFAULT_PARAMS)
    try:
        params.update(load_plugin_config(_PLUGIN_FILE))
    except Exception:
        pass
    params["workspace"] = _text(params.get("workspace"))
    params["model"] = _text(params.get("model"))
    params["cli_path"] = _text(params.get("cli_path"))
    params["project_id"] = _text(params.get("project_id"))
    params["ratio"] = _text(params.get("ratio")) or _DEFAULT_PARAMS["ratio"]
    params["resolution"] = _text(params.get("resolution")) or _DEFAULT_PARAMS["resolution"]
    params["operation"] = _text(params.get("operation")) or _DEFAULT_PARAMS["operation"]
    params["duration"] = _as_int(params.get("duration"), 5, 1, 600)
    params["poll_interval"] = _as_int(params.get("poll_interval"), 3, 1, 60)
    params["timeout"] = _as_int(params.get("timeout"), 1800, 30, 24 * 60 * 60)
    params["generate_audio"] = _as_bool(params.get("generate_audio"), False)
    params["watermark"] = _as_bool(params.get("watermark"), False)
    return params


def _emit(context: dict[str, Any], status: str, percent: int | None = None) -> None:
    callback = context.get("progress_callback")
    if not callable(callback):
        return
    try:
        if percent is None:
            callback(status)
        else:
            callback(status, max(0, min(100, int(percent))))
    except Exception:
        # 进度回调异常不能掩盖生成任务本身的结果。
        pass


def _redact(text: Any) -> str:
    value = _text(text)
    value = re.sub(r"(open_ai_canvas_session=)[^;\s]+", r"\1<redacted>", value, flags=re.I)
    value = re.sub(r"(authorization\s*[:=]\s*bearer\s+)[^\s,}]+", r"\1<redacted>", value, flags=re.I)
    value = re.sub(r"([?&](?:token|access_token|api[_-]?key)=)[^&#\s]+", r"\1<redacted>", value, flags=re.I)
    return value[:2000]


def _json_from_output(stdout: str) -> Any:
    text = stdout.strip()
    if not text:
        return None
    candidates = [text]
    candidates.extend(line.strip() for line in reversed(text.splitlines()) if line.strip())
    decoder = json.JSONDecoder()
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except Exception:
            pass
    for index, char in enumerate(text):
        if char not in "[{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
            return value
        except Exception:
            continue
    return None


def _node_executable() -> str:
    for candidate in (
        shutil.which("node"),
        shutil.which("node.exe"),
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ):
        if candidate and Path(candidate).exists():
            return candidate
    return "node"


def _append_unique_path(environment: dict[str, str], *directories: Path) -> None:
    """让插件宿主即使没有继承用户 PATH，也能找到 npm 全局命令。"""
    existing = [item for item in environment.get("PATH", "").split(os.pathsep) if item]
    known = {item.casefold() for item in existing}
    for directory in directories:
        if not directory:
            continue
        value = str(directory)
        if value.casefold() not in known and directory.is_dir():
            existing.append(value)
            known.add(value.casefold())
    environment["PATH"] = os.pathsep.join(existing)


def _cli_prefix(cli_path: str) -> list[str]:
    raw = _text(cli_path)
    candidates: list[str] = [raw] if raw else []
    if not raw:
        configured = _text(os.environ.get("LALOR_CLI_PATH"))
        if configured:
            candidates.append(configured)
        for command in ("lalor", "lalor.cmd", "lalor.exe"):
            found = shutil.which(command)
            if found:
                candidates.append(found)
        appdata = _text(os.environ.get("APPDATA"))
        local_appdata = _text(os.environ.get("LOCALAPPDATA"))
        npm_roots = [
            Path(appdata) / "npm" if appdata else Path(),
            Path(local_appdata) / "npm" if local_appdata else Path(),
            Path.home() / "AppData" / "Roaming" / "npm",
        ]
        for root in npm_roots:
            if root:
                candidates.extend(str(root / name) for name in ("lalor.cmd", "lalor.exe", "lalor"))
        candidates.append(r"C:\Users\Administrator\Documents\ChatGPT\lalor\.tmp\full-src\lalor-cli\src\cli.mjs")
    for candidate in candidates:
        path = Path(candidate).expanduser()
        suffix = path.suffix.lower()
        if suffix == ".ps1" and path.exists():
            return ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(path)]
        if suffix in {".mjs", ".js"} and path.exists():
            return [_node_executable(), str(path)]
        if path.exists() or (not path.is_absolute() and shutil.which(str(path))):
            return [str(path)]
    shown = raw or "自动查找路径"
    raise LalorPluginError(
        f"找不到 Lalor CLI（{shown}）。请先安装 Lalor CLI 并重启字字动画；"
        "如果已经安装，可在“高级设置”填写完整路径。"
    )


def _run_cli(params: dict[str, Any], arguments: list[str], timeout: int = 120) -> Any:
    command = _cli_prefix(params.get("cli_path", ""))
    command.extend(arguments)
    workspace = _effective_workspace(params)
    if workspace and "--workspace" not in arguments:
        command.extend(["--workspace", workspace])
    if "--json" not in arguments:
        command.append("--json")
    environment = os.environ.copy()
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["NO_COLOR"] = "1"
    appdata = _text(environment.get("APPDATA"))
    local_appdata = _text(environment.get("LOCALAPPDATA"))
    _append_unique_path(
        environment,
        Path(appdata) / "npm" if appdata else Path(),
        Path(local_appdata) / "npm" if local_appdata else Path(),
    )
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=max(10, int(timeout)),
            env=environment,
            creationflags=creationflags,
            shell=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise LalorPluginError(f"Lalor CLI 请求超时：{_redact(exc)}") from exc
    except OSError as exc:
        raise LalorPluginError(f"无法启动 Lalor CLI：{_redact(exc)}") from exc
    if completed.returncode != 0:
        detail = _redact(completed.stderr or completed.stdout or f"退出码 {completed.returncode}")
        raise LalorPluginError(f"Lalor CLI 请求失败：{detail}")
    parsed = _json_from_output(completed.stdout)
    if parsed is None:
        raise LalorPluginError("Lalor CLI 没有返回有效 JSON，请检查 CLI 路径和登录状态。")
    return parsed


def _open_login_window(params: dict[str, Any]) -> dict[str, Any]:
    """打开独立登录窗口，账号密码只在用户本机输入，不经过插件。"""
    command = _cli_prefix(params.get("cli_path", ""))
    workspace_name = _effective_workspace(params) or "default"
    command.extend(["auth", "login", "--workspace", workspace_name])
    environment = os.environ.copy()
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["NO_COLOR"] = "1"
    appdata = _text(environment.get("APPDATA"))
    local_appdata = _text(environment.get("LOCALAPPDATA"))
    _append_unique_path(
        environment,
        Path(appdata) / "npm" if appdata else Path(),
        Path(local_appdata) / "npm" if local_appdata else Path(),
    )
    creationflags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
    launch_kwargs: dict[str, Any] = {
        "env": environment,
        "shell": False,
        "stdin": None,
        "stdout": None,
        "stderr": None,
    }
    if creationflags:
        launch_kwargs["creationflags"] = creationflags
    else:  # pragma: no cover - 仅为非 Windows 开发环境保留
        launch_kwargs["start_new_session"] = True
    try:
        process = subprocess.Popen(command, **launch_kwargs)
    except OSError as exc:
        raise LalorPluginError(f"无法打开 Lalor 登录窗口：{_redact(exc)}") from exc
    return {
        "ok": True,
        "workspace": workspace_name,
        "pid": process.pid,
        "message": f"已打开 Lalor 登录窗口，请在新窗口完成“{workspace_name}”工作区登录。",
    }


def _load_cli_workspace(params: dict[str, Any]) -> tuple[str, str]:
    """读取 CLI 的本地工作区配置，仅用于下载受保护的 Lalor 资源。"""
    appdata = _text(os.environ.get("APPDATA"))
    if appdata:
        config_path = Path(appdata) / "lalor-cli" / "config.json"
    else:
        config_path = Path.home() / ".config" / "lalor-cli" / "config.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        config = {}
    workspace_name = _effective_workspace(params) or _text(config.get("currentWorkspace")) or "default"
    workspace = (config.get("workspaces") or {}).get(workspace_name) or (config.get("workspaces") or {}).get("default") or {}
    base_url = _text(params.get("base_url")) or _text(workspace.get("baseUrl"))
    if not base_url:
        base_url = "http://127.0.0.1:3000/api"
    parsed = urlsplit(base_url if "://" in base_url else f"http://{base_url}")
    path = parsed.path.rstrip("/")
    if not path.endswith("/api"):
        path = f"{path}/api" if path else "/api"
    api_url = urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))
    cookie = _text(os.environ.get("LALOR_SESSION_COOKIE")) or _text(workspace.get("sessionCookie"))
    if cookie and "=" not in cookie:
        cookie = f"open_ai_canvas_session={cookie}"
    return api_url.rstrip("/"), cookie


_CAPABILITY_ALIASES = {
    "image": "image", "images": "image", "canvas-image": "image", "image-generation": "image", "图片": "image",
    "video": "video", "videos": "video", "canvas-video": "video", "video-generation": "video", "视频": "video",
    "audio": "audio", "speech": "audio", "tts": "audio", "canvas-audio": "audio", "音频": "audio",
    "text": "text", "chat": "text", "canvas-text": "text", "文本": "text",
}
_PROTOCOL_CAPABILITIES = {
    "chat-completion": "text", "openai-response": "text",
    "openai-image": "image", "gemini-image": "image", "grok-image": "image",
    "volcengine-ark-image": "image", "volcengine-jimeng-image": "image",
    "openai-audio": "audio", "async-audio": "audio", "index-tts-v2": "audio",
    "newapi": "video", "aione-video": "video", "newapi-channel-1": "video",
    "newapi-channel-2": "video", "mddkeji-video": "video", "moziaverse-hailuo-video": "video",
    "minimax-v2-video": "video", "xai-video": "video", "volcengine-ark-video": "video",
    "volcengine-jimeng-video": "video", "gemini-veo": "video",
}
_VIDEO_MODEL_HINTS = (
    "seedance", "video", "sora", "veo", "kling", "wan", "hailuo", "pika", "runway", "gen-3", "gen3",
    "hunyuan-video", "hunyuanvideo", "cogvideo", "mochi", "latte", "stable-video", "animatediff",
    "ltx-video", "ltxvideo", "minimax-h3", "abab-video",
)
_IMAGE_MODEL_HINTS = (
    "seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl",
    "stable-diffusion", "midjourney", "nano-banana", "nanobanana", "ideogram", "recraft",
    "playground", "leonardo",
)
_AUDIO_MODEL_HINTS = ("audio", "tts", "speech", "voice", "music", "sound")


def _normalized_token(value: Any) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", _text(value).lower()).strip("-")


def _normalized_capability(value: Any) -> str:
    return _CAPABILITY_ALIASES.get(_normalized_token(value), "")


def _protocol_capability(value: Any) -> str:
    token = _normalized_token(value)
    if token in _PROTOCOL_CAPABILITIES:
        return _PROTOCOL_CAPABILITIES[token]
    if "video" in token or token in {"veo", "seedance"}:
        return "video"
    if "image" in token:
        return "image"
    if "audio" in token or "speech" in token or "tts" in token:
        return "audio"
    if "chat" in token or "response" in token:
        return "text"
    return ""


def _model_name_capability(value: Any) -> str:
    raw = _text(value).lower().replace("\\", "/")
    token = _normalized_token(raw)
    leaf = _normalized_token(raw.rsplit("/", 1)[-1])
    if any(hint in token for hint in _VIDEO_MODEL_HINTS) or leaf in {"h3", "h3-max", "h3max"}:
        return "video"
    if any(hint in token for hint in _AUDIO_MODEL_HINTS):
        return "audio"
    if any(hint in token for hint in _IMAGE_MODEL_HINTS):
        return "image"
    return ""


def _capability_from_config(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    for capability in ("image", "video", "audio", "text"):
        if capability in value:
            return capability
    return ""


def _model_capability(item: dict[str, Any], channel: dict[str, Any]) -> str:
    # 后台目录中的单模型能力是权威值；协议和模型名只用于缺少能力字段时推断。
    for value in (item.get("capability"), item.get("capabilityType"), item.get("type")):
        capability = _normalized_capability(value)
        if capability:
            return capability
    capability = _capability_from_config(item.get("capabilityConfig") or item.get("capability_config"))
    if capability:
        return capability
    for value in (item.get("protocol"), item.get("interfaceType")):
        capability = _protocol_capability(value)
        if capability:
            return capability
    for value in (channel.get("interfaceType"), channel.get("protocol")):
        capability = _protocol_capability(value)
        if capability:
            return capability
    endpoint_types = item.get("endpointTypes") or item.get("endpoint_types") or []
    if isinstance(endpoint_types, (list, tuple)):
        for value in endpoint_types:
            capability = _protocol_capability(value)
            if capability:
                return capability
    return _model_name_capability(
        item.get("model") or item.get("modelKey") or item.get("model_key") or item.get("id")
    )


def _normalized_model_key(value: Any) -> str:
    key = _text(value)
    if key.lower().startswith("models/"):
        key = key[len("models/"):]
    return key.split("::", 1)[-1].strip()


def _unwrap_api_payload(value: Any) -> Any:
    if isinstance(value, dict) and "code" in value and "data" in value:
        if str(value.get("code")) not in {"0", "0.0"}:
            raise LalorPluginError(_text(value.get("msg")) or "Lalor 模型目录请求失败")
        return value.get("data")
    return value


def _channels_from_payload(value: Any) -> list[dict[str, Any]]:
    payload = _unwrap_api_payload(value)
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("channels", "systemChannels", "system_channels"):
        channels = payload.get(key)
        if isinstance(channels, list):
            return [item for item in channels if isinstance(item, dict)]
    nested = payload.get("data")
    return _channels_from_payload(nested) if nested is not payload else []


def _raw_model_item(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    key = _text(value)
    return {"model": key} if key else {}


def _merge_nonempty(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in patch.items():
        if value not in (None, "", [], {}):
            merged[key] = value
    return merged


def _compatible_models_from_payload(value: Any, capability: str) -> list[dict[str, Any]]:
    models: list[dict[str, Any]] = []
    seen_refs: set[str] = set()
    for channel in _channels_from_payload(value):
        if channel.get("enabled") is False:
            continue
        channel_id = _text(channel.get("id") or channel.get("channelId") or channel.get("channel_id"))
        if not channel_id:
            continue
        merged_by_key: dict[str, dict[str, Any]] = {}
        order: list[str] = []
        raw_models = channel.get("models") if isinstance(channel.get("models"), list) else []
        raw_costs = channel.get("modelCosts") or channel.get("model_costs") or []
        for raw in list(raw_models) + (list(raw_costs) if isinstance(raw_costs, list) else []):
            item = _raw_model_item(raw)
            key = _normalized_model_key(item.get("model") or item.get("modelKey") or item.get("model_key") or item.get("id"))
            if not key:
                continue
            if key not in merged_by_key:
                order.append(key)
                merged_by_key[key] = {"model": key}
            merged_by_key[key] = _merge_nonempty(merged_by_key[key], item)
        for key in order:
            item = merged_by_key[key]
            if item.get("enabled") is False or _model_capability(item, channel) != capability:
                continue
            ref = f"{channel_id}::{key}"
            if ref in seen_refs:
                continue
            seen_refs.add(ref)
            channel_name = _text(channel.get("name")) or channel_id
            models.append({
                "ref": ref,
                "channelId": channel_id,
                "channelName": channel_name,
                "channel": {"id": channel_id, "name": channel_name, "type": _text(channel.get("type"))},
                "model": key,
                "displayName": _text(item.get("displayName") or item.get("display_name") or item.get("name")) or key,
                "description": _text(item.get("description")),
                "capability": capability,
                "protocol": _text(item.get("protocol") or channel.get("interfaceType") or channel.get("protocol")),
                "capabilityConfig": item.get("capabilityConfig") or item.get("capability_config"),
            })
    return sorted(models, key=lambda item: (item["channelName"].casefold(), item["displayName"].casefold()))


def _catalog_diagnostics(value: Any, capability: str, source: str) -> dict[str, Any]:
    """只统计模型目录结构，不返回模型名称、渠道标识或凭据。"""
    channels = _channels_from_payload(value)
    enabled_channels = 0
    usable_channels = 0
    model_entries = 0
    enabled_models = 0
    matching_models = 0
    other_capability_models = 0
    unclassified_models = 0

    for channel in channels:
        raw_models = channel.get("models") if isinstance(channel.get("models"), list) else []
        raw_costs = channel.get("modelCosts") or channel.get("model_costs") or []
        cost_items = raw_costs if isinstance(raw_costs, list) else []
        model_entries += len(raw_models) + len(cost_items)
        if channel.get("enabled") is False:
            continue
        enabled_channels += 1
        channel_id = _text(channel.get("id") or channel.get("channelId") or channel.get("channel_id"))
        if not channel_id:
            continue
        usable_channels += 1

        merged_by_key: dict[str, dict[str, Any]] = {}
        for raw in list(raw_models) + list(cost_items):
            item = _raw_model_item(raw)
            key = _normalized_model_key(item.get("model") or item.get("modelKey") or item.get("model_key") or item.get("id"))
            if not key:
                continue
            merged_by_key[key] = _merge_nonempty(merged_by_key.get(key, {"model": key}), item)

        for item in merged_by_key.values():
            if item.get("enabled") is False:
                continue
            enabled_models += 1
            model_capability = _model_capability(item, channel)
            if model_capability == capability:
                matching_models += 1
            elif model_capability:
                other_capability_models += 1
            else:
                unclassified_models += 1

    return {
        "source": source,
        "channels": len(channels),
        "enabled_channels": enabled_channels,
        "usable_channels": usable_channels,
        "model_entries": model_entries,
        "enabled_models": enabled_models,
        "matching_models": matching_models,
        "other_capability_models": other_capability_models,
        "unclassified_models": unclassified_models,
    }


def _request_catalog_payload(params: dict[str, Any], route: str) -> Any:
    if requests is None:
        raise LalorPluginError(f"运行环境缺少 requests，无法读取 Lalor 模型目录：{_redact(_REQUESTS_IMPORT_ERROR)}")
    api_url, cookie = _load_cli_workspace(params)
    if not cookie:
        raise LalorPluginError("Lalor CLI 已通过登录检测，但插件进程没有读取到当前工作区会话。")
    try:
        response = requests.get(
            f"{api_url}{route}",
            headers={"Accept": "application/json", "Cookie": cookie},
            timeout=(15, 60),
        )
        payload = response.json()
    except Exception as exc:
        raise LalorPluginError(f"读取 Lalor 模型目录失败：{_redact(exc)}") from exc
    if not response.ok:
        message = _text(payload.get("msg")) if isinstance(payload, dict) else ""
        raise LalorPluginError(message or f"读取 Lalor 模型目录失败（HTTP {response.status_code}）")
    return _unwrap_api_payload(payload)


def _available_models(params: dict[str, Any], capability: str) -> tuple[list[Any], str, dict[str, Any]]:
    result = _run_cli(params, ["model", "list", "--capability", capability, "--json"], timeout=90)
    models = result.get("models", []) if isinstance(result, dict) else (result if isinstance(result, list) else [])
    if isinstance(models, list) and models:
        return models, "cli", {
            "sources": [{
                "source": "Lalor CLI",
                "channels": None,
                "enabled_channels": None,
                "usable_channels": None,
                "model_entries": len(models),
                "enabled_models": len(models),
                "matching_models": len(models),
                "other_capability_models": 0,
                "unclassified_models": 0,
            }]
        }
    payload = _request_catalog_payload(params, "/channels/system")
    compatible = _compatible_models_from_payload(payload, capability)
    diagnostics = [_catalog_diagnostics(payload, capability, "系统渠道目录")]
    if compatible:
        return compatible, "compatible-catalog", {"sources": diagnostics}
    session_payload = _request_catalog_payload(params, "/auth/session")
    compatible = _compatible_models_from_payload(session_payload, capability)
    diagnostics.append(_catalog_diagnostics(session_payload, capability, "当前会话目录"))
    return compatible, "compatible-session", {"sources": diagnostics}


def _compatible_model_for_reference(params: dict[str, Any], reference: str, capability: str) -> dict[str, Any]:
    """从同一登录会话的后台目录解析 CLI 旧版遗漏的模型。"""
    for route in ("/channels/system", "/auth/session"):
        for item in _compatible_models_from_payload(_request_catalog_payload(params, route), capability):
            if _text(item.get("ref")) == reference:
                return item
    raise LalorPluginError(f"后台模型目录中找不到已选择的模型：{reference}，请重新读取模型后再试。")


def _post_task_payload(params: dict[str, Any], body: dict[str, Any]) -> Any:
    """使用 CLI 保存的同一会话提交任务，不读取或回显账号凭据。"""
    if requests is None:
        raise LalorPluginError(f"运行环境缺少 requests，无法提交 Lalor 任务：{_redact(_REQUESTS_IMPORT_ERROR)}")
    api_url, cookie = _load_cli_workspace(params)
    if not cookie:
        raise LalorPluginError("Lalor CLI 已通过登录检测，但插件进程没有读取到当前工作区会话。")
    try:
        response = requests.post(
            f"{api_url}/tasks",
            headers={"Accept": "application/json", "Cookie": cookie},
            json=body,
            timeout=(20, 180),
        )
        payload = response.json()
    except Exception as exc:
        raise LalorPluginError(f"提交 Lalor 任务失败：{_redact(exc)}") from exc
    if not response.ok:
        message = _text(payload.get("msg")) if isinstance(payload, dict) else ""
        raise LalorPluginError(message or f"提交 Lalor 任务失败（HTTP {response.status_code}）")
    return _unwrap_api_payload(payload)


def _create_compatible_task(
    params: dict[str, Any],
    context: dict[str, Any],
    task_input: dict[str, Any],
    model_reference: str,
    operation: str,
) -> dict[str, Any]:
    item = _compatible_model_for_reference(params, model_reference, "video")
    prepared_input = dict(task_input)
    config = dict(prepared_input.get("config") or {})
    config["channelId"] = _text(item.get("channelId"))
    config["model"] = _text(item.get("model"))
    protocol = _text(item.get("protocol"))
    if protocol:
        config["interfaceType"] = protocol
    capability_config = item.get("capabilityConfig")
    if isinstance(capability_config, dict):
        config["capabilityConfig"] = capability_config
    prepared_input["mode"] = "video"
    prepared_input["prompt"] = _text(context.get("prompt"))
    prepared_input["config"] = config
    metadata = dict(prepared_input.get("metadata") or {})
    metadata["videoEditOperation"] = _text(metadata.get("videoEditOperation")) or operation
    prepared_input["metadata"] = metadata
    body: dict[str, Any] = {
        "type": "canvas_video",
        "operation": operation,
        "prompt": _text(context.get("prompt")),
        "provider": "",
        "model": config["model"],
        "input": prepared_input,
    }
    project_id = _text(params.get("project_id")) or _text(context.get("project_id"))
    if project_id:
        body["projectId"] = project_id
    return _unwrap_task(_post_task_payload(params, body))


def _is_cli_model_catalog_miss(error: Exception) -> bool:
    return "未找到模型：" in _text(error) or "未找到模型:" in _text(error)


def _public_base_url(api_url: str) -> str:
    parsed = urlsplit(api_url)
    path = parsed.path.rstrip("/")
    if path.endswith("/api"):
        path = path[:-4] or "/"
    return urlunsplit((parsed.scheme, parsed.netloc, path.rstrip("/"), "", ""))


def _absolute_media_url(value: str, api_url: str) -> str:
    value = _text(value)
    if value.startswith("resource:"):
        value = f"/api/resources/{value.split(':', 1)[1]}/file"
    if value.startswith("/"):
        return f"{_public_base_url(api_url)}{value}"
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return urljoin(f"{_public_base_url(api_url)}/", value)


def _path_from_value(value: Any) -> str:
    if isinstance(value, (str, Path)):
        return _text(value)
    if isinstance(value, dict):
        for key in _PATH_KEYS + ("src", "value"):
            candidate = value.get(key)
            if isinstance(candidate, (str, Path)) and _text(candidate):
                return _text(candidate)
    return ""


def _iter_paths(value: Any) -> Iterable[str]:
    if isinstance(value, (str, Path)):
        candidate = _text(value)
        if candidate:
            yield candidate
        return
    if isinstance(value, dict):
        for key in ("首帧", "尾帧", "参考图片MAP", "images", "items", "files", "paths"):
            if key in value:
                yield from _iter_paths(value[key])
        direct = _path_from_value(value)
        if direct:
            yield direct
        for key, child in value.items():
            if key not in {"首帧", "尾帧", "参考图片MAP", "images", "items", "files", "paths"}:
                yield from _iter_paths(child)
        return
    if isinstance(value, (list, tuple, set)):
        for child in value:
            yield from _iter_paths(child)


def _existing_local_paths(values: Iterable[str], label: str) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        candidate = _text(raw)
        if not candidate or candidate.startswith("http://") or candidate.startswith("https://") or candidate.startswith("data:"):
            raise LalorPluginError(f"{label}必须是本机文件，当前路径无法交给 Lalor 工作台下载：{candidate[:160]}")
        path = Path(candidate).expanduser()
        if not path.is_file():
            raise LalorPluginError(f"{label}不存在：{path}")
        resolved = path.resolve()
        # Windows 去重不区分大小写，但保留原始解析路径供上传和错误信息使用。
        key = str(resolved).lower()
        if key not in seen:
            seen.add(key)
            result.append(str(resolved))
    return result


def _kind_for_path(path: str, default: str = "image") -> str:
    suffix = Path(path).suffix.lower()
    if suffix in _VIDEO_EXTENSIONS:
        return "video"
    if suffix in _AUDIO_EXTENSIONS:
        return "audio"
    return default


def _resource_id(value: Any) -> str:
    if isinstance(value, dict):
        for key in ("id", "resourceId", "resource_id"):
            candidate = _text(value.get(key))
            if candidate:
                return candidate
        resource = value.get("resource")
        if resource is not value:
            return _resource_id(resource)
    return ""


def _upload_resource(params: dict[str, Any], path: str, kind: str) -> dict[str, Any]:
    _emit(_UPLOAD_CONTEXT, f"正在上传{kind_label(kind)}")
    result = _run_cli(params, ["asset", "upload", path, "--kind", kind, "--json"], timeout=600)
    resource = result.get("resource", result) if isinstance(result, dict) else result
    resource_id = _resource_id(resource)
    if not resource_id:
        raise LalorPluginError(f"Lalor 资源上传成功但没有返回资源 ID：{_redact(result)}")
    file_path = Path(path)
    mime_type = _text(resource.get("mimeType")) if isinstance(resource, dict) else ""
    mime_type = mime_type or mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    size = file_path.stat().st_size
    return {
        "id": resource_id,
        "name": file_path.name,
        "type": kind,
        "mimeType": mime_type,
        "bytes": size,
        "storageKey": f"resource:{resource_id}",
    }


_UPLOAD_CONTEXT: dict[str, Any] = {}


def kind_label(kind: str) -> str:
    return {"image": "参考图片", "video": "参考视频", "audio": "参考音频"}.get(kind, "参考素材")


def _collect_media(context: dict[str, Any]) -> dict[str, list[str]]:
    images: list[str] = []
    videos: list[str] = []
    audios: list[str] = []

    first = _path_from_value(context.get("first_frame_path"))
    end = _path_from_value(context.get("end_frame_path"))
    if first:
        images.append(first)
    if end:
        images.append(end)

    raw_images = context.get("reference_images", {})
    images.extend(_iter_paths(raw_images))
    images.extend(_iter_paths(context.get("reference_image_paths", [])))
    raw_videos = context.get("reference_videos", context.get("reference_video_paths", []))
    videos.extend(_iter_paths(raw_videos))
    raw_audios = context.get("reference_audios", context.get("reference_audio_paths", []))
    audios.extend(_iter_paths(raw_audios))
    audio = _path_from_value(context.get("audio_path"))
    if audio:
        audios.append(audio)

    # 明确字段优先；扩展名只作为兜底，不会改变显式图片/视频/音频数组的归类。
    return {
        "images": _existing_local_paths(images, "参考图片") if images else [],
        "videos": _existing_local_paths(videos, "参考视频") if videos else [],
        "audios": _existing_local_paths(audios, "参考音频") if audios else [],
    }


def _build_task_input(params: dict[str, Any], media: dict[str, list[dict[str, Any]]], context: dict[str, Any]) -> dict[str, Any]:
    ratio = _text(params.get("ratio")) or _text(context.get("aspect_ratio")) or _text(context.get("ratio")) or "16:9"
    duration = _as_int(params.get("duration") or context.get("scene_duration") or 5, 5, 1, 600)
    resolution = _text(params.get("resolution")) or "720p"
    config: dict[str, Any] = {
        "size": ratio,
        "videoSeconds": str(duration),
        "vquality": resolution,
        "videoGenerateAudio": str(_as_bool(params.get("generate_audio"), False)).lower(),
        "videoWatermark": str(_as_bool(params.get("watermark"), False)).lower(),
    }
    task_input: dict[str, Any] = {
        "mode": "video",
        "config": config,
        "metadata": {
            "source": "zizi-animation-plugin",
            "plugin": "video_plugin_lalor_workbench",
        },
    }
    if media["images"]:
        task_input["referenceImages"] = media["images"]
    if media["videos"]:
        task_input["referenceVideos"] = media["videos"]
    if media["audios"]:
        task_input["referenceAudios"] = media["audios"]
    return task_input


def _unwrap_task(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        nested = value.get("task")
        if isinstance(nested, dict):
            return nested
        return value
    return {}


def _task_state(task: dict[str, Any]) -> str:
    return _text(task.get("status")).lower().replace(" ", "_")


def _nested_error_text(value: Any, seen: set[int] | None = None) -> str:
    """从服务端错误对象中提取第一条可读原因，不回显整个响应。"""
    if isinstance(value, str):
        return _text(value)
    if not isinstance(value, (dict, list, tuple)):
        return _text(value)
    if seen is None:
        seen = set()
    marker = id(value)
    if marker in seen:
        return ""
    seen.add(marker)
    if isinstance(value, (list, tuple)):
        for child in value:
            found = _nested_error_text(child, seen)
            if found:
                return found
        return ""
    for key in (
        "message",
        "detail",
        "reason",
        "failureReason",
        "failReason",
        "providerMessage",
        "errorMessage",
        "errorCode",
    ):
        found = _nested_error_text(value.get(key), seen)
        if found:
            return found
    for key in ("error", "providerError", "details"):
        found = _nested_error_text(value.get(key), seen)
        if found:
            return found
    return ""


def _task_error(task: dict[str, Any]) -> str:
    for key in (
        "error",
        "errorMessage",
        "errorCode",
        "failureReason",
        "failReason",
        "reason",
        "providerError",
        "providerMessage",
        "message",
    ):
        value = _nested_error_text(task.get(key))
        if value:
            stage = _text(task.get("stage"))
            if stage and stage.lower() not in value.lower():
                value = f"{value}（阶段：{stage}）"
            return _redact(value)
    stage = _text(task.get("stage"))
    if stage:
        return _redact(f"任务在“{stage}”阶段失败")
    return "Lalor 工作台任务失败，但服务端没有返回具体原因。"


def _parse_result_json(task: dict[str, Any]) -> Any:
    raw = task.get("resultJson", task.get("result"))
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except Exception:
            return raw
    return raw


def _find_media(value: Any, hint: str = "video") -> str:
    if isinstance(value, str):
        candidate = value.strip()
        if candidate.startswith(("http://", "https://", "/", "resource:", "data:")):
            return candidate
        return ""
    if isinstance(value, list):
        for child in value:
            found = _find_media(child, hint)
            if found:
                return found
        return ""
    if not isinstance(value, dict):
        return ""
    # 优先视频字段，避免把提示词或元数据中的普通 URL 当成结果。
    for key in _MEDIA_CONTAINER_KEYS:
        if key in value:
            found = _find_media(value[key], "video")
            if found:
                return found
    for key in _URL_KEYS:
        candidate = value.get(key)
        if isinstance(candidate, str) and _find_media(candidate, hint):
            return candidate.strip()
    for key in _PATH_KEYS:
        candidate = value.get(key)
        if isinstance(candidate, str) and Path(candidate).is_file():
            return candidate.strip()
    for key in _RESOURCE_ID_KEYS:
        candidate = _text(value.get(key))
        if candidate:
            return candidate if candidate.startswith("resource:") else f"resource:{candidate}"
    storage = _text(value.get("storageKey"))
    if storage.startswith("resource:"):
        return storage
    for child in value.values():
        found = _find_media(child, hint)
        if found:
            return found
    return ""


def _result_media_reference(task: dict[str, Any]) -> str:
    result = _parse_result_json(task)
    found = _find_media(result)
    if found:
        return found
    for key in ("previewUrl", "videoUrl", "url", "outputUrl"):
        found = _find_media(task.get(key))
        if found:
            return found
    return ""


def _safe_component(value: Any, fallback: str) -> str:
    text = _text(value)
    text = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff._-]+", "_", text).strip("._")
    return text[:80] or fallback


def _output_path(context: dict[str, Any]) -> Path:
    directory = Path(_text(context.get("project_path") or context.get("output_dir")) or ".").expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)
    viewer_index = _as_int(context.get("viewer_index"), 0, 0, 999999)
    generation_round = _as_int(context.get("generation_round"), 1, 0, 999999)
    position = context.get("output_position", 0)
    if isinstance(position, (list, tuple)):
        position = position[0] if position else 0
    name = _safe_component(context.get("unique_name"), "lalor_video")
    position_text = _safe_component(position, "0")
    target = directory / f"{viewer_index:04d}_{name}_{generation_round}_{position_text}.mp4"
    if target.exists():
        target = directory / f"{viewer_index:04d}_{name}_{generation_round}_{position_text}_{int(time.time())}.mp4"
    return target


def _write_data_url(data_url: str, target: Path) -> None:
    header, encoded = data_url.split(",", 1)
    if ";base64" not in header.lower():
        target.write_bytes(encoded.encode("utf-8"))
        return
    target.write_bytes(base64.b64decode(encoded))


def _download_media(reference: str, target: Path, api_url: str, cookie: str) -> None:
    if reference.startswith("data:"):
        try:
            _write_data_url(reference, target)
            return
        except Exception as exc:
            raise LalorPluginError(f"解析 Lalor 返回的视频数据失败：{_redact(exc)}") from exc
    if requests is None:
        raise LalorPluginError(f"字字动画运行环境缺少 requests，无法下载 Lalor 视频：{_redact(_REQUESTS_IMPORT_ERROR)}")
    url = _absolute_media_url(reference, api_url)
    headers = {"Accept": "video/*,application/octet-stream"}
    parsed_url = urlsplit(url)
    parsed_api = urlsplit(api_url)
    if cookie and parsed_url.netloc == parsed_api.netloc:
        headers["Cookie"] = cookie
    try:
        response = requests.get(url, headers=headers, timeout=(20, 300), stream=True)
        response.raise_for_status()
        with target.open("wb") as output:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    output.write(chunk)
    except Exception as exc:
        raise LalorPluginError(f"下载 Lalor 生成视频失败：{_redact(exc)}") from exc
    if not target.exists() or target.stat().st_size <= 0:
        raise LalorPluginError("Lalor 返回的视频文件为空")


def _upload_and_build_media(params: dict[str, Any], context: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    global _UPLOAD_CONTEXT
    _UPLOAD_CONTEXT = context
    paths = _collect_media(context)
    total = sum(len(items) for items in paths.values())
    uploaded = 0
    result: dict[str, list[dict[str, Any]]] = {"images": [], "videos": [], "audios": []}
    for field, kind in (("images", "image"), ("videos", "video"), ("audios", "audio")):
        for path in paths[field]:
            uploaded += 1
            _emit(context, f"上传{kind_label(kind)} {uploaded}/{total}", min(28, 8 + uploaded * 20 // max(total, 1)))
            result[field].append(_upload_resource(params, path, kind))
    return result


def _create_task(params: dict[str, Any], context: dict[str, Any], task_input: dict[str, Any]) -> dict[str, Any]:
    prompt = _text(context.get("prompt"))
    if not prompt:
        raise LalorPluginError("提示词不能为空")
    model = _text(params.get("model")) or _text(context.get("model"))
    if not model:
        raise LalorPluginError("尚未配置 Lalor 视频模型，请在插件设置中填写 channelId::model，或先运行 lalor model list --capability video。")
    operation = _text(params.get("operation")) or ("image_to_video" if task_input.get("referenceImages") else "text_to_video")
    arguments = [
        "task", "create",
        "--model", model,
        "--type", "canvas_video",
        "--operation", operation,
        "--prompt", prompt,
        "--input", json.dumps(task_input, ensure_ascii=False, separators=(",", ":")),
        "--confirm",
        "--json",
    ]
    project_id = _text(params.get("project_id")) or _text(context.get("project_id"))
    if project_id:
        arguments.extend(["--project", project_id])
    try:
        task = _unwrap_task(_run_cli(params, arguments, timeout=180))
    except LalorPluginError as exc:
        # CLI 在该错误处尚未调用 POST /tasks，因此这里回退不会重复创建计费任务。
        if not _is_cli_model_catalog_miss(exc):
            raise
        task = _create_compatible_task(params, context, task_input, model, operation)
    if not _text(task.get("id")):
        raise LalorPluginError(f"Lalor 没有返回任务 ID：{_redact(task)}")
    return task


def _poll_task(params: dict[str, Any], context: dict[str, Any], task_id: str) -> dict[str, Any]:
    started = time.monotonic()
    timeout = _as_int(params.get("timeout"), 1800, 30, 24 * 60 * 60)
    interval = _as_int(params.get("poll_interval"), 3, 1, 60)
    last_signature = ""
    while time.monotonic() - started <= timeout:
        task = _unwrap_task(_run_cli(params, ["task", "status", task_id, "--json"], timeout=90))
        state = _task_state(task)
        progress = task.get("progress")
        try:
            percent = max(30, min(95, int(float(progress))))
        except (TypeError, ValueError):
            percent = 45 if state in {"queued", "pending"} else 70
        stage = _text(task.get("stage"))
        signature = f"{state}:{percent}:{stage}"
        if signature != last_signature:
            last_signature = signature
            if state in {"queued", "pending"}:
                _emit(context, "Lalor 工作台排队中", percent)
            elif state in {"running", "processing", "started"}:
                _emit(context, f"Lalor 工作台生成中{('：' + stage) if stage else ''}", percent)
            else:
                _emit(context, stage or "正在查询 Lalor 任务", percent)
        if state in {"failed", "error"}:
            raise LalorPluginError(f"Lalor 工作台生成失败：{_task_error(task)}")
        if state in {"cancelled", "canceled"}:
            raise LalorPluginError("Lalor 工作台任务已取消")
        if state in {"succeeded", "success", "completed"}:
            return task
        time.sleep(interval)
    raise LalorPluginError(f"Lalor 工作台任务在 {timeout} 秒内未完成，任务 ID：{task_id}；可在 Lalor 任务中心继续查看。")


def generate(context: dict[str, Any]) -> list[str]:
    """提交到 Lalor 工作台并返回字字动画可导入的本地视频路径。"""
    params = get_params()
    plugin_params = context.get("plugin_params")
    if isinstance(plugin_params, dict):
        merged = dict(params)
        merged.update(plugin_params)
        params = merged
    _emit(context, "准备连接 Lalor 工作台", 2)
    media = _upload_and_build_media(params, context)
    task_input = _build_task_input(params, media, context)
    _emit(context, "正在提交 Lalor 工作台任务", 30)
    task = _create_task(params, context, task_input)
    task_id = _text(task.get("id"))
    _emit(context, f"任务已提交（{task_id}），等待工作台处理", 35)
    completed = _poll_task(params, context, task_id)
    reference = _result_media_reference(completed)
    if not reference:
        raise LalorPluginError("Lalor 任务已完成，但返回结果中没有视频地址或资源 ID。请在 Lalor 任务中心检查该任务。")
    api_url, cookie = _load_cli_workspace(params)
    target = _output_path(context)
    _emit(context, "正在下载 Lalor 生成视频", 96)
    _download_media(reference, target, api_url, cookie)
    _emit(context, "Lalor 视频已下载", 100)
    return [str(target)]


def get_info() -> dict[str, str]:
    return {
        "name": "Lalor 工作台插件",
        "description": "字字动画通过本机 Lalor CLI 提交视频任务到 Lalor 工作台账号池，自动回传视频和中文失败原因。",
        "version": _PLUGIN_VERSION,
        "author": "Lalor",
    }


def handle_action(action: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    """设置页的连接、登录和模型读取动作。"""
    data = data if isinstance(data, dict) else {}
    params = get_params()
    params.update({key: value for key, value in data.items() if key in {"cli_path", "workspace"}})
    if action == "open_login":
        try:
            return _open_login_window(params)
        except Exception as exc:
            return {"ok": False, "error": _redact(exc)}
    if action == "test_connection":
        try:
            result = _run_cli(params, ["auth", "whoami", "--json"], timeout=60)
            user = result.get("user") if isinstance(result, dict) else None
            return {"ok": True, "message": f"Lalor CLI 已登录{('：' + _text(user.get('username') or user.get('displayName'))) if isinstance(user, dict) else ''}"}
        except Exception as exc:
            message = _redact(exc)
            if "尚未登录" in message or "登录状态已失效" in message:
                workspace_name = _effective_workspace(params) or "当前工作区"
                return {
                    "ok": False,
                    "needs_login": True,
                    "workspace": workspace_name,
                    "error": f"{message}\n请点击“打开登录窗口”，完成 {workspace_name} 工作区登录后再检测。",
                }
            return {"ok": False, "error": message}
    if action == "list_models":
        try:
            identity = _run_cli(params, ["auth", "whoami", "--json"], timeout=60)
            user = identity.get("user") if isinstance(identity, dict) else None
            account = _text(user.get("username") or user.get("displayName")) if isinstance(user, dict) else ""
            models, catalog_source, diagnostics = _available_models(params, "video")
            return {
                "ok": True,
                "models": models,
                "catalogSource": catalog_source,
                "diagnostics": diagnostics,
                "workspace": _effective_workspace(params) or "当前工作区",
                "account": account,
            }
        except Exception as exc:
            message = _redact(exc)
            if "尚未登录" in message or "登录状态已失效" in message:
                workspace_name = _effective_workspace(params) or "当前工作区"
                return {
                    "ok": False,
                    "needs_login": True,
                    "workspace": workspace_name,
                    "error": f"{message}\n请先点击“打开登录窗口”，完成 {workspace_name} 工作区登录。",
                }
            return {"ok": False, "error": message}
    return {"ok": False, "error": f"未知动作：{action}"}


# ==================== 2.0 本机工作台运行时 ====================
# 下方定义是插件对外导出的最终实现。保留上方 1.x 解析辅助函数，
# 但 generate/get_params/handle_action 均不再执行 CLI 或网站登录流程。
import importlib.util as _importlib_util
import uuid as _uuid
from urllib.parse import quote as _quote


_IMAGE_PLUGIN_MAIN = (
    PLUGIN_DIR.parent.parent
    / "image_plugins"
    / "image_plugin_lalor_workbench"
    / "main.py"
)
_IMAGE_PLUGIN_SPEC = _importlib_util.spec_from_file_location(
    "_lalor_workbench_local_client",
    _IMAGE_PLUGIN_MAIN,
)
if _IMAGE_PLUGIN_SPEC is None or _IMAGE_PLUGIN_SPEC.loader is None:
    raise RuntimeError("无法加载 Lalor 工作台本机连接组件")
_IMAGE_LOCAL = _importlib_util.module_from_spec(_IMAGE_PLUGIN_SPEC)
_IMAGE_PLUGIN_SPEC.loader.exec_module(_IMAGE_LOCAL)

_LOCAL_DEFAULT_PARAMS = {
    "platform": "doubao",
    "model": "",
    "ratio": "16:9",
    "duration": 5,
    "poll_interval": 3,
    "timeout": 1800,
}
_LOCAL_ALLOWED_RATIOS = {"1:1", "3:4", "4:3", "9:16", "16:9", "21:9"}
_LOCAL_ALLOWED_DURATIONS = {f"{value}s" for value in range(4, 16)} | {"30s"}
_LOCAL_MODEL_LABELS = {
    "seedance-2.5": "Seedance 2.5",
    "seedance-2.0": "Seedance 2.0",
    "seedance-2.0-fast": "Seedance 2.0 Fast",
    "seedance-2.0-mini": "Seedance 2.0 Mini",
}


def _local_normalize_params(value: dict[str, Any]) -> dict[str, Any]:
    params = dict(value)
    platform = _text(params.get("platform")).lower()
    params["platform"] = platform if platform in {"doubao", "dola"} else "doubao"
    params["model"] = _text(params.get("model"))
    params["ratio"] = _text(params.get("ratio")) or "16:9"
    params["duration"] = _as_int(params.get("duration"), 5, 1, 600)
    params["poll_interval"] = _as_int(params.get("poll_interval"), 3, 1, 60)
    params["timeout"] = _as_int(params.get("timeout"), 1800, 30, 24 * 60 * 60)
    return params


def get_params() -> dict[str, Any]:
    params = dict(_LOCAL_DEFAULT_PARAMS)
    try:
        params.update(load_plugin_config(_PLUGIN_FILE))
    except Exception:
        pass
    return _local_normalize_params(params)


def _local_capabilities(api: Any | None = None) -> dict[str, Any]:
    local_api = api or _IMAGE_LOCAL._discover_api()
    result = local_api.json("GET", "/plugin/capabilities", timeout=10)
    raw_accounts = result.get("accounts")
    accounts = [
        item for item in raw_accounts
        if isinstance(item, dict) and item.get("platform") in {"doubao", "dola"}
    ] if isinstance(raw_accounts, list) else []
    raw_models = result.get("videoModels")
    raw_models = raw_models if isinstance(raw_models, dict) else {}
    video_models: dict[str, list[str]] = {}
    for platform in ("doubao", "dola"):
        values = raw_models.get(platform)
        video_models[platform] = [
            _text(item) for item in values if _text(item)
        ] if isinstance(values, list) else []
    models = [
        {"id": model, "name": _LOCAL_MODEL_LABELS.get(model, model), "platform": platform}
        for platform, values in video_models.items()
        for model in values
    ]
    raw_pools = result.get("accountPools")
    account_pools = raw_pools if isinstance(raw_pools, dict) else {}
    if not account_pools:
        account_pools = {
            platform: {"total": sum(1 for item in accounts if item.get("platform") == platform)}
            for platform in ("doubao", "dola")
        }
    return {
        "ok": True,
        "ready": result.get("ready") is True,
        "accounts": accounts,
        "accountPools": account_pools,
        "videoModels": video_models,
        "models": models,
        "message": f"已连接 Lalor 工作台，读取到 {len(accounts)} 个豆包/Dola 账号。",
    }


def _local_poll_task(
    api: Any,
    context: dict[str, Any],
    task_id: str,
    params: dict[str, Any],
) -> None:
    started = time.monotonic()
    last_signature = ""
    while time.monotonic() - started <= params["timeout"]:
        payload = api.json("GET", f"/plugin/tasks/{_quote(task_id, safe='')}", timeout=30)
        task = payload.get("task") if isinstance(payload.get("task"), dict) else {}
        state = _text(task.get("status")).lower()
        try:
            percent = max(35, min(95, int(float(task.get("progress", 50)))))
        except (TypeError, ValueError):
            percent = 50
        stage = _text(task.get("message") or task.get("stage"))
        signature = f"{state}:{percent}:{stage}"
        if signature != last_signature:
            last_signature = signature
            fallback = "Lalor 工作台排队中" if state == "queued" else "Lalor 工作台视频生成中"
            _emit(context, stage or fallback, percent)
        if state in {"fail", "failed", "error"}:
            reason = _text(task.get("error")) or stage or "工作台未返回具体原因"
            raise LalorPluginError(f"Lalor 视频生成失败：{reason}")
        if state in {"cancelled", "canceled"}:
            raise LalorPluginError("Lalor 视频任务已取消。")
        if state in {"done", "succeeded", "success", "completed"}:
            return
        time.sleep(params["poll_interval"])
    raise LalorPluginError(
        f"Lalor 视频任务在 {params['timeout']} 秒内未完成，可在工作台任务中心继续查看。"
    )


def _local_video_suffix(artifact: dict[str, Any]) -> str:
    suffix = Path(_text(artifact.get("name"))).suffix.lower()
    if suffix in _VIDEO_EXTENSIONS:
        return suffix
    guessed = mimetypes.guess_extension(_text(artifact.get("contentType")).split(";", 1)[0])
    return guessed if guessed in _VIDEO_EXTENSIONS else ".mp4"


def _local_download_video(api: Any, route: str, target: Path) -> None:
    if not route.startswith("/v1/plugin/tasks/") or ".." in route:
        raise LalorPluginError("Lalor 工作台返回的视频下载路径无效。")
    max_bytes = 2 * 1024 * 1024 * 1024
    try:
        with api._request("GET", route, timeout=300) as response, target.open("wb") as output:
            expected = _as_int(response.headers.get("Content-Length"), 0, 0, max_bytes + 1)
            if expected > max_bytes:
                raise LalorPluginError("Lalor 视频产物超过 2GB，已停止下载。")
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise LalorPluginError("Lalor 视频产物超过 2GB，已停止下载。")
                output.write(chunk)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    if not target.is_file() or target.stat().st_size <= 0:
        target.unlink(missing_ok=True)
        raise LalorPluginError("Lalor 返回的视频文件为空。")


def generate(context: dict[str, Any]) -> list[str]:
    """向本机 Lalor 工作台账号池提交视频任务并回传本地视频。"""
    params = get_params()
    if isinstance(context.get("plugin_params"), dict):
        params.update(context["plugin_params"])
        params = _local_normalize_params(params)
    prompt = _text(context.get("prompt"))
    if not prompt:
        raise LalorPluginError("视频提示词不能为空。")
    if params["platform"] not in {"doubao", "dola"}:
        raise LalorPluginError("请先在插件设置中选择豆包或 Dola 账号池。")
    if not params["model"]:
        raise LalorPluginError("请先在插件设置中选择视频模型。")
    ratio = params["ratio"]
    duration = f"{params['duration']}s"
    if ratio not in _LOCAL_ALLOWED_RATIOS:
        raise LalorPluginError(f"画面比例「{ratio}」不受支持。")
    if duration not in _LOCAL_ALLOWED_DURATIONS:
        raise LalorPluginError(f"视频时长「{duration}」不受支持，请选择 4-15 秒或 30 秒。")

    _emit(context, "正在连接 Lalor 工作台视频账号池", 2)
    api = _IMAGE_LOCAL._discover_api()
    capabilities = _local_capabilities(api)
    platform = params["platform"]
    raw_pools = capabilities.get("accountPools") if isinstance(capabilities.get("accountPools"), dict) else {}
    pool = raw_pools.get(platform) if isinstance(raw_pools.get(platform), dict) else {}
    if _as_int(pool.get("total"), 0, 0, 100000) < 1:
        raise LalorPluginError(f"Lalor 工作台的{'Dola' if platform == 'dola' else '豆包'}账号池暂无账号。")
    if params["model"] not in capabilities["videoModels"].get(platform, []):
        raise LalorPluginError("选择的视频模型与账号池不匹配，请刷新后重新选择。")

    media = _collect_media(context)
    _emit(context, "正在提交 Lalor 工作台视频任务", 25)
    payload = api.json("POST", "/plugin/tasks", {
        "requestId": f"zizi-video-{_uuid.uuid4().hex}",
        "platform": platform,
        "mode": "video",
        "prompt": prompt,
        "attachments": media["images"],
        "referenceVideos": media["videos"],
        "audioAttachments": media["audios"],
        "videoConfig": {
            "model": params["model"],
            "duration": duration,
            "aspectRatio": ratio,
        },
    }, timeout=60)
    task_ids = [str(item) for item in payload.get("taskIds", []) if _text(item)]
    if len(task_ids) != 1:
        raise LalorPluginError("Lalor 工作台没有返回完整的视频任务编号。")
    task_id = task_ids[0]
    _emit(context, "任务已提交，等待工作台账号池生成", 35)
    _local_poll_task(api, context, task_id, params)

    listing = api.json("GET", f"/plugin/tasks/{_quote(task_id, safe='')}/artifacts", timeout=30)
    artifacts = [
        item for item in listing.get("artifacts", [])
        if isinstance(item, dict)
        and (item.get("kind") == "video" or Path(_text(item.get("name"))).suffix.lower() in _VIDEO_EXTENSIONS)
    ]
    if not artifacts:
        raise LalorPluginError("视频任务已完成，但工作台没有可回传的本地视频产物。")
    base_target = _output_path(context)
    outputs: list[str] = []
    for index, artifact in enumerate(artifacts, 1):
        suffix = _local_video_suffix(artifact)
        target = base_target.with_suffix(suffix)
        if index > 1:
            target = target.with_name(f"{target.stem}_{index:02d}{target.suffix}")
        if target.exists():
            target = target.with_name(f"{target.stem}_{int(time.time() * 1000)}{target.suffix}")
        _emit(context, f"正在回传视频 {index}/{len(artifacts)}", 96)
        _local_download_video(api, _text(artifact.get("downloadPath")), target)
        outputs.append(str(target.resolve()))
    _emit(context, f"Lalor 视频任务完成，已回传 {len(outputs)} 个视频", 100)
    return outputs


def get_info() -> dict[str, str]:
    return {
        "name": "Lalor 工作台视频插件",
        "description": "直接调用本机 Lalor 工作台的豆包/Dola 视频账号池，支持参考图、视频和音频。",
        "version": _PLUGIN_VERSION,
        "author": "Lalor",
    }


def handle_action(action: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    """设置页只读取本机工作台账号与模型能力，不接触凭据。"""
    del data
    if action in {"test_connection", "list_accounts", "list_models", "refresh_capabilities"}:
        try:
            return _local_capabilities()
        except Exception as exc:
            return {"ok": False, "error": _redact(exc)}
    return {"ok": False, "error": f"未知动作：{action}"}
