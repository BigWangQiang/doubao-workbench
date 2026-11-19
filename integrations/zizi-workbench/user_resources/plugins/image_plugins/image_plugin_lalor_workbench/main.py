"""字字动画 -> Lalor 工作台图片账号池插件。

插件仅连接本机 Lalor 工作台的 loopback API，图片任务直接进入工作台既有
豆包/Dola 账号池、调度、下载和失败回传链路；无需 CLI，工作台须已完成会员登录。
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


PLUGIN_DIR = Path(__file__).resolve().parent
_PLUGIN_FILE = __file__
_PLUGIN_VERSION = "2.1.1"

sys.path.append(str(PLUGIN_DIR.parent.parent))
from plugin_utils import load_plugin_config  # noqa: E402


_DEFAULT_PARAMS = {
    "platform": "doubao",
    "count": 1,
    "poll_interval": 3,
    "timeout": 1800,
}
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"}
_TERMINAL_FAILURES = {"fail", "failed", "error"}
_TERMINAL_CANCELLED = {"cancelled", "canceled"}
_TERMINAL_SUCCESS = {"done", "succeeded", "success", "completed"}
_ERROR_MESSAGES = {
    "UNAUTHORIZED": "Lalor 工作台连接认证已失效，请重启工作台后重试。",
    "TOKEN_EXPIRED": "Lalor 工作台本机连接已过期，请重启工作台后重试。",
    "RENDERER_NOT_READY": "Lalor 工作台界面尚未就绪，请打开工作台后重试。",
    "PLUGIN_API_UNAVAILABLE": "当前工作台插件接口不可用，请更新 Lalor 工作台后重试。",
    "PLUGIN_ACCESS_DENIED": "Lalor 会员授权未通过，请在工作台确认会员和网络状态后重试。",
    "ACCOUNT_NOT_FOUND": "选择的账号已不存在，请刷新账号列表后重新选择。",
    "INVALID_ACCOUNT_POOL": "请选择豆包或 Dola 账号池。",
    "ACCOUNT_POOL_EMPTY": "选择的账号池暂无账号，请先在 Lalor 工作台添加账号。",
    "INVALID_LOCAL_MEDIA": "参考图片不是可读取的本机图片文件。",
    "TASK_CREATE_FAILED": "Lalor 工作台没有成功创建图片任务，请检查本地任务队列。",
    "ARTIFACT_NOT_FOUND": "图片任务已完成，但本地产物尚未找到。",
}


class LalorPluginError(RuntimeError):
    """面向字字动画用户的中文错误。"""


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _as_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def _redact(value: Any) -> str:
    text = _text(value)
    text = re.sub(r"(authorization\s*[:=]\s*bearer\s+)[^\s,}]+", r"\1<redacted>", text, flags=re.I)
    text = re.sub(r"([?&](?:token|access_token|api[_-]?key)=)[^&#\s]+", r"\1<redacted>", text, flags=re.I)
    return text[:1200]


def get_params() -> dict[str, Any]:
    params = dict(_DEFAULT_PARAMS)
    try:
        params.update(load_plugin_config(_PLUGIN_FILE))
    except Exception:
        pass
    platform = _text(params.get("platform")).lower()
    if platform not in {"doubao", "dola"}:
        platform = "dola" if _text(params.get("image_model")).lower().startswith("dola") else "doubao"
    params["platform"] = platform
    params["count"] = _as_int(params.get("count"), 1, 1, 15)
    params["poll_interval"] = _as_int(params.get("poll_interval"), 3, 1, 60)
    params["timeout"] = _as_int(params.get("timeout"), 1800, 30, 24 * 60 * 60)
    return params


def _emit(context: dict[str, Any], status: str, percent: int | None = None) -> None:
    callback = context.get("progress_callback")
    if not callable(callback):
        return
    try:
        callback(status) if percent is None else callback(status, max(0, min(100, int(percent))))
    except Exception:
        pass


def _control_dirs() -> list[Path]:
    result: list[Path] = []
    configured = _text(os.environ.get("LALOR_WORKBENCH_CONTROL_DIR"))
    if configured:
        result.append(Path(configured).expanduser())
    result.append(Path(r"D:\doubao-studio-data\doubao-studio-desktop\DoubaoStudioControl"))
    for root_name in ("APPDATA", "LOCALAPPDATA"):
        root = _text(os.environ.get(root_name))
        if not root:
            continue
        base = Path(root)
        for app_dir in ("doubao-studio-desktop", "Lalor工作台", "Lalor Workbench"):
            # 升级保留自定义数据目录；按发现文件的协议连接，不按软件版本号匹配。
            locator = base / app_dir / "data-location.json"
            try:
                saved = json.loads(locator.read_text(encoding="utf-8-sig"))
                selected = Path(saved.get("directory", ""))
                if selected.is_absolute() and selected.is_dir():
                    result.append(selected / "DoubaoStudioControl")
            except (OSError, ValueError, TypeError, AttributeError):
                pass
            result.append(base / app_dir / "DoubaoStudioControl")
    unique: list[Path] = []
    seen: set[str] = set()
    for item in result:
        key = str(item).casefold()
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


class _LocalApi:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self._token = token

    def _request(self, method: str, route: str, payload: dict[str, Any] | None = None, timeout: int = 90):
        body = None if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        # 产物列表返回的 downloadPath 是带 /v1 的绝对 API 路径；
        # 普通接口则使用 /plugin/... 相对于 base_url。两种形式都只能拼一次 /v1。
        url = f"{self.base_url[:-3]}{route}" if route.startswith("/v1/") and self.base_url.endswith("/v1") else f"{self.base_url}{route}"
        request = Request(
            url, data=body, method=method,
            headers={
                "Accept": "application/json", "Authorization": f"Bearer {self._token}",
                **({"Content-Type": "application/json; charset=utf-8"} if body is not None else {}),
            },
        )
        try:
            return urlopen(request, timeout=timeout)
        except HTTPError as exc:
            raw = exc.read(1024 * 1024)
            try:
                error = json.loads(raw.decode("utf-8", errors="replace"))
            except Exception:
                error = {}
            code = _text(error.get("code")) if isinstance(error, dict) else ""
            message = _text(error.get("message")) if isinstance(error, dict) else ""
            raise LalorPluginError(_ERROR_MESSAGES.get(code) or message or f"Lalor 工作台请求失败（HTTP {exc.code}）") from exc
        except (URLError, OSError, TimeoutError) as exc:
            raise LalorPluginError(f"无法连接 Lalor 工作台，请确认工作台正在运行：{_redact(exc)}") from exc

    def json(self, method: str, route: str, payload: dict[str, Any] | None = None, timeout: int = 90) -> dict[str, Any]:
        with self._request(method, route, payload, timeout) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise LalorPluginError("Lalor 工作台返回数据过大，已停止读取。")
        try:
            value = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise LalorPluginError("Lalor 工作台没有返回有效 JSON。") from exc
        if not isinstance(value, dict):
            raise LalorPluginError("Lalor 工作台返回格式无效。")
        return value

    def download(self, route: str, target: Path, max_bytes: int = 512 * 1024 * 1024) -> None:
        try:
            with self._request("GET", route, timeout=300) as response, target.open("wb") as output:
                expected = _as_int(response.headers.get("Content-Length"), 0, 0, max_bytes + 1)
                if expected > max_bytes:
                    raise LalorPluginError("Lalor 图片产物超过 512MB，已停止下载。")
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise LalorPluginError("Lalor 图片产物超过 512MB，已停止下载。")
                    output.write(chunk)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        if not target.is_file() or target.stat().st_size <= 0:
            target.unlink(missing_ok=True)
            raise LalorPluginError("Lalor 返回的图片文件为空。")


def _discover_api() -> _LocalApi:
    failures: list[str] = []
    for control_dir in _control_dirs():
        info_path = control_dir / "control-info.json"
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
            if info.get("protocolVersion") != "v1":
                raise LalorPluginError("工作台连接协议不兼容，请更新插件或工作台。")
            address = _text(info.get("address"))
            port = int(info.get("port"))
            token_name = _text(info.get("tokenFile")) or "control-token"
            token_path = (control_dir / token_name).resolve()
            if address != "127.0.0.1" or not 1 <= port <= 65535 or token_path.parent != control_dir.resolve():
                raise ValueError("发现文件内容无效")
            token = token_path.read_text(encoding="utf-8").strip()
            if not token or len(token) > 4096:
                raise ValueError("认证文件无效")
            api = _LocalApi(f"http://127.0.0.1:{port}/v1", token)
            health = api.json("GET", "/health", timeout=3)
            if health.get("ok") is True and health.get("protocolVersion") == "v1":
                return api
        except Exception as exc:
            if info_path.exists():
                failures.append(_redact(exc))
    detail = f"（{failures[-1]}）" if failures else ""
    raise LalorPluginError(f"未发现可连接的 Lalor 工作台{detail}。请先打开最新版工作台，再点击刷新。")


def _capabilities() -> dict[str, Any]:
    api = _discover_api()
    result = api.json("GET", "/plugin/capabilities", timeout=10)
    accounts = result.get("accounts") if isinstance(result.get("accounts"), list) else []
    valid = [item for item in accounts if isinstance(item, dict) and item.get("platform") in {"doubao", "dola"}]
    raw_capabilities = result.get("imageCapabilities")
    image_capabilities = raw_capabilities if isinstance(raw_capabilities, dict) else {}
    raw_pools = result.get("accountPools")
    account_pools = raw_pools if isinstance(raw_pools, dict) else {}
    if not account_pools:
        account_pools = {
            platform: {"total": sum(1 for item in valid if item.get("platform") == platform)}
            for platform in ("doubao", "dola")
        }
    return {
        "ok": True,
        "ready": result.get("ready") is True,
        "accounts": valid,
        "accountPools": account_pools,
        "imageCapabilities": image_capabilities,
        "message": f"已连接 Lalor 工作台，读取到 {len(valid)} 个豆包/Dola 账号。",
    }


def _path_from_value(value: Any) -> str:
    if isinstance(value, (str, Path)):
        return _text(value)
    if isinstance(value, dict):
        for key in ("path", "file", "filePath", "file_path", "localPath", "local_path", "src", "value"):
            candidate = value.get(key)
            if isinstance(candidate, (str, Path)) and _text(candidate):
                return _text(candidate)
    return ""


def _iter_paths(value: Any) -> Iterable[str]:
    if isinstance(value, (str, Path)):
        if _text(value):
            yield _text(value)
    elif isinstance(value, dict):
        direct = _path_from_value(value)
        if direct:
            yield direct
        else:
            for child in value.values():
                yield from _iter_paths(child)
    elif isinstance(value, (list, tuple, set)):
        for child in value:
            yield from _iter_paths(child)


def _collect_reference_paths(context: dict[str, Any]) -> list[str]:
    candidates: list[str] = []
    for key in ("reference_images", "reference_image_paths", "images"):
        candidates.extend(_iter_paths(context.get(key, [])))
    for key in ("first_frame_path", "end_frame_path"):
        direct = _path_from_value(context.get(key))
        if direct:
            candidates.append(direct)
    result: list[str] = []
    seen: set[str] = set()
    for raw in candidates:
        path = Path(raw).expanduser()
        if not path.is_file() or path.suffix.lower() not in _IMAGE_EXTENSIONS:
            raise LalorPluginError(f"参考图片不存在或格式不支持：{path.name or raw}")
        resolved = str(path.resolve())
        if resolved.casefold() not in seen:
            seen.add(resolved.casefold())
            result.append(resolved)
    if len(result) > 30:
        raise LalorPluginError("参考图片最多 30 张。")
    return result


def _poll_tasks(api: _LocalApi, context: dict[str, Any], task_ids: list[str], params: dict[str, Any]) -> None:
    started = time.monotonic()
    timeout = params["timeout"]
    interval = params["poll_interval"]
    completed: set[str] = set()
    while time.monotonic() - started <= timeout:
        for task_id in task_ids:
            if task_id in completed:
                continue
            payload = api.json("GET", f"/plugin/tasks/{quote(task_id, safe='')}", timeout=30)
            task = payload.get("task") if isinstance(payload.get("task"), dict) else {}
            state = _text(task.get("status")).lower()
            if state in _TERMINAL_FAILURES:
                reason = _text(task.get("error")) or _text(task.get("message")) or "工作台未返回具体原因"
                raise LalorPluginError(f"Lalor 图片生成失败：{reason}")
            if state in _TERMINAL_CANCELLED:
                raise LalorPluginError("Lalor 图片任务已取消。")
            if state in _TERMINAL_SUCCESS:
                completed.add(task_id)
        if len(completed) == len(task_ids):
            return
        elapsed = time.monotonic() - started
        progress = min(94, 35 + int(elapsed / max(timeout, 1) * 55))
        _emit(context, f"Lalor 工作台生图中（{len(completed)}/{len(task_ids)} 完成）", progress)
        time.sleep(interval)
    raise LalorPluginError(f"Lalor 图片任务在 {timeout} 秒内未完成，可在工作台任务中心继续查看。")


def _safe_component(value: Any, fallback: str) -> str:
    text = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff._-]+", "_", _text(value)).strip("._")
    return text[:64] or fallback


def _output_dir(context: dict[str, Any]) -> Path:
    directory = Path(_text(context.get("project_path") or context.get("output_dir")) or ".").expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _artifact_suffix(artifact: dict[str, Any]) -> str:
    name_suffix = Path(_text(artifact.get("name"))).suffix.lower()
    if name_suffix in _IMAGE_EXTENSIONS:
        return name_suffix
    guessed = mimetypes.guess_extension(_text(artifact.get("contentType")).split(";", 1)[0])
    return guessed if guessed in _IMAGE_EXTENSIONS else ".png"


def generate(context: dict[str, Any]) -> list[str]:
    """向本机 Lalor 工作台账号池提交图片任务并回传本地图片路径。"""
    params = get_params()
    if isinstance(context.get("plugin_params"), dict):
        params.update(context["plugin_params"])
        platform = _text(params.get("platform")).lower()
        params["platform"] = platform if platform in {"doubao", "dola"} else "doubao"
        params["count"] = _as_int(params.get("count"), 1, 1, 15)
        params["poll_interval"] = _as_int(params.get("poll_interval"), 3, 1, 60)
        params["timeout"] = _as_int(params.get("timeout"), 1800, 30, 24 * 60 * 60)
    prompt = _text(context.get("prompt"))
    if not prompt:
        raise LalorPluginError("图片提示词不能为空。")
    if params["platform"] not in {"doubao", "dola"}:
        raise LalorPluginError("请先在插件设置中选择豆包或 Dola 账号池。")

    _emit(context, "正在连接 Lalor 工作台图片账号池", 2)
    api = _discover_api()
    capabilities = api.json("GET", "/plugin/capabilities", timeout=10)
    platform = params["platform"]
    raw_pools = capabilities.get("accountPools") if isinstance(capabilities.get("accountPools"), dict) else {}
    pool = raw_pools.get(platform) if isinstance(raw_pools.get(platform), dict) else {}
    if _as_int(pool.get("total"), 0, 0, 100000) < 1:
        raise LalorPluginError(f"Lalor 工作台的{'Dola' if platform == 'dola' else '豆包'}账号池暂无账号。")
    references = _collect_reference_paths(context)
    payload = api.json("POST", "/plugin/tasks", {
        "requestId": f"zizi-image-{uuid.uuid4().hex}", "platform": platform,
        "mode": "image", "prompt": prompt, "count": params["count"], "attachments": references,
    }, timeout=60)
    task_ids = [str(item) for item in payload.get("taskIds", []) if _text(item)]
    if len(task_ids) != params["count"]:
        raise LalorPluginError("Lalor 工作台没有返回完整的图片任务编号。")
    _emit(context, f"已提交 {len(task_ids)} 个图片任务，等待账号池生成", 35)
    _poll_tasks(api, context, task_ids, params)

    output_dir = _output_dir(context)
    stem = _safe_component(context.get("unique_name"), "lalor_image")
    outputs: list[str] = []
    for task_index, task_id in enumerate(task_ids, 1):
        listing = api.json("GET", f"/plugin/tasks/{quote(task_id, safe='')}/artifacts", timeout=30)
        artifacts = [item for item in listing.get("artifacts", []) if isinstance(item, dict) and item.get("kind") == "image"]
        if not artifacts:
            raise LalorPluginError(f"第 {task_index} 个图片任务已完成，但工作台没有可回传的本地图片产物。")
        for artifact_index, artifact in enumerate(artifacts, 1):
            suffix = _artifact_suffix(artifact)
            target = output_dir / f"{stem}_{task_id[:8]}_{artifact_index:02d}{suffix}"
            if target.exists():
                target = output_dir / f"{stem}_{task_id[:8]}_{artifact_index:02d}_{int(time.time() * 1000)}{suffix}"
            _emit(context, f"正在回传图片 {len(outputs) + 1}", 96)
            api.download(_text(artifact.get("downloadPath")), target)
            outputs.append(str(target.resolve()))
    _emit(context, f"Lalor 图片任务完成，共回传 {len(outputs)} 张", 100)
    return outputs


def get_info() -> dict[str, str]:
    return {
        "name": "Lalor 工作台图片插件",
        "description": "直接调用本机 Lalor 工作台的豆包/Dola 图片账号池，无需 CLI 和网站登录。",
        "version": _PLUGIN_VERSION,
        "author": "Lalor",
    }


def handle_action(action: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    """设置页只读取本机工作台账号能力，不接触账号凭据。"""
    del data
    if action in {"test_connection", "list_accounts", "refresh_capabilities"}:
        try:
            return _capabilities()
        except Exception as exc:
            return {"ok": False, "error": _redact(exc)}
    return {"ok": False, "error": f"未知动作：{action}"}
