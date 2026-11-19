"""字字动画视频分镜与屿砚网站客户 API 的连接。"""
from __future__ import annotations

import errno
import itertools
import json
import mimetypes
import re
import sys
import time
from contextlib import contextmanager
from hashlib import sha256
from http.client import HTTPException
from os import fstat, fsync
from pathlib import Path
from random import uniform
from tempfile import NamedTemporaryFile
from typing import Any, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4

sys.path.append(str(Path(__file__).resolve().parent.parent.parent))
from plugin_utils import load_plugin_config  # noqa: E402


_API = "https://yuyan-ai.site/api/v1"
_TASK_WAIT = 120 * 60
_POLL_INTERVAL = 12
_DOWNLOAD_ATTEMPTS = 4
_CHUNK_SIZE = 1024 * 1024
_MEDIA_SUFFIX = {"video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-m4v": ".m4v"}
_OPERATIONS = {"text_to_video", "image_to_video", "reference_to_video", "audio_to_video"}
_PARAMS = {"api_key": "", "model": "", "ratio": "", "duration": "", "resolution": ""}
_RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}
_REJECTED_SUBMISSION = {400, 401, 403, 404, 413, 422, 429}


class YuyanError(RuntimeError):
    """向字字动画返回的平台诊断。"""


class RequestFailure(YuyanError):
    def __init__(self, message: str, status: int | None = None, retry_after: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = int(retry_after) if retry_after.isascii() and retry_after.isdigit() else 0

    @property
    def retryable(self) -> bool:
        return self.status is None or self.status in _RETRYABLE_STATUS


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


class Client:
    def __init__(self, key: str) -> None:
        if not key or any(char.isspace() for char in key):
            raise YuyanError("请先在插件设置填入屿砚客户 API Key。")
        self.key = key
        self.opener = build_opener(NoRedirect())

    def request(self, method: str, route: str, *, body: bytes | Iterator[bytes] | None = None,
                headers: dict[str, str] | None = None, timeout: int = 30, media_redirect: bool = False) -> Any:
        req = Request(_API + route, body, {"Authorization": "Bearer " + self.key, **(headers or {})}, method=method)
        try:
            return self.opener.open(req, timeout=timeout)
        except HTTPError as exc:
            with exc:
                if media_redirect and exc.code == 307:
                    return self.open_delivery(exc.headers["Location"], timeout)
                message = ""
                # 限流和网关重启可能只有状态码或 HTML；重试决策由状态码驱动。
                if exc.code not in _RETRYABLE_STATUS and exc.headers.get_content_type() == "application/json":
                    message = str(json.load(exc)["msg"]).replace(self.key, "<已隐藏>")
            raise RequestFailure(f"屿砚接口 {method} {route}（HTTP {exc.code}）{message}", exc.code, exc.headers.get("Retry-After", "")) from exc
        except (URLError, OSError, HTTPException) as exc:
            raise RequestFailure(f"连接屿砚失败：{method} {route}：{exc.reason if isinstance(exc, URLError) else exc}") from exc

    def open_delivery(self, url: str, timeout: int) -> Any:
        # 文件接口的 307 由网站签发。下载走新请求，不复用 Bearer，也不允许再次跳转。
        location = urlsplit(url)
        if location.scheme != "https" or not location.hostname or location.username is not None:
            raise YuyanError("屿砚文件接口未返回安全的 HTTPS 下载地址。")
        try:
            return self.opener.open(Request(url), timeout=timeout)
        except HTTPError as exc:
            with exc:
                # 对象存储拒绝旧签名时，下次从网站文件入口重新取得签名。
                status = 503 if exc.code == 403 else exc.code
                raise RequestFailure(f"屿砚存储下载失败（HTTP {exc.code}）。", status, exc.headers.get("Retry-After", "")) from None
        except (URLError, OSError, HTTPException):
            raise RequestFailure("屿砚存储下载连接失败。") from None

    def json(self, method: str, route: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        with self.request(method, route, body=body, headers=headers, timeout=60) as response:
            try:
                return self.envelope(response)
            except (OSError, HTTPException) as exc:
                raise RequestFailure(f"屿砚响应读取中断：{method} {route}") from exc

    def envelope(self, response: Any) -> dict[str, Any]:
        if response.headers.get_content_type() != "application/json":
            raise YuyanError(f"屿砚未返回 JSON（HTTP {response.status}）。")
        data = json.load(response)
        if data["code"] != 0:
            raise YuyanError(str(data["msg"]).replace(self.key, "<已隐藏>"))
        return data["data"]

    def upload(self, path: Path, kind: str) -> str:
        boundary = uuid4().hex
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        # 客户 API 根据内容识别素材；只提交安全的固定文件名和原扩展名。
        filename = "reference" + re.sub(r"[^a-zA-Z0-9.]", "", path.suffix)
        head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
                f"Content-Type: {mime}\r\n\r\n").encode("ascii")
        end = f"\r\n--{boundary}--\r\n".encode("ascii")
        with path.open("rb") as stream:
            size = fstat(stream.fileno()).st_size
            body = itertools.chain((head,), iter(lambda: stream.read(_CHUNK_SIZE), b""), (end,))
            headers = {"Content-Type": "multipart/form-data; boundary=" + boundary,
                       "Content-Length": str(len(head) + size + len(end)), "Accept": "application/json"}
            with self.request("POST", "/files", body=body, headers=headers, timeout=180) as response:
                file = self.envelope(response)
        if file["kind"] != kind:
            raise YuyanError(f"屿砚识别出参考文件 {path.name} 为 {file['kind']}，预期 {kind}。")
        return file["id"]

    def download(self, file: dict[str, Any], directory: Path, context: dict[str, Any]) -> str:
        route = "/files/" + quote(file["id"], safe="") + "/content"
        if file["contentUrl"] != "/api/v1" + route:
            raise YuyanError("任务返回的视频下载地址不符合屿砚文件合同。")
        media_type = file["contentType"].split(";", 1)[0].lower()
        if media_type not in _MEDIA_SUFFIX or file["bytes"] <= 0:
            raise YuyanError(f"屿砚返回了不支持或为空的视频：{media_type}，{file['bytes']} 字节。")
        name = re.sub(r"[^\w.-]+", "_", str(context.get("unique_name") or "分镜")).strip("._")[:60] or "分镜"
        target = directory / (f"{int(context.get('viewer_index', 0)):04d}_{name}_yuyan_{uuid4().hex[:12]}" + _MEDIA_SUFFIX[media_type])
        partial = target.with_suffix(target.suffix + ".part")
        try:
            with self.request("GET", route, timeout=180, media_redirect=True) as response, partial.open("xb") as output:
                if response.headers.get_content_type() != media_type:
                    raise YuyanError(f"成片类型不一致：文件为 {media_type}，下载响应为 {response.headers.get_content_type()}。")
                total = 0
                last_percent = -1
                while True:
                    try:
                        chunk = response.read(_CHUNK_SIZE)
                    except (OSError, HTTPException) as exc:
                        raise RequestFailure("成片传输中断。") from exc
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > file["bytes"]:
                        raise YuyanError("实际下载超过屿砚记录的成片大小。")
                    output.write(chunk)
                    percent = total * 100 // file["bytes"]
                    if percent != last_percent:
                        emit(context, f"回传 {percent}%", 95 + min(4, percent // 20))
                        last_percent = percent
            if total != file["bytes"]:
                raise RequestFailure(f"成片下载不完整：收到 {total} / {file['bytes']} 字节。")
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)
        return str(target)


def get_info() -> dict[str, Any]:
    return json.loads(Path(__file__).with_name("info.json").read_text(encoding="utf-8"))


def get_params() -> dict[str, Any]:
    return {**_PARAMS, **load_plugin_config(__file__)}


def model_options(client: Client) -> list[dict[str, Any]]:
    catalog = client.json("GET", "/models")
    result = []
    for channel in catalog["channels"]:
        for model in channel["models"]:
            if model["capability"] != "video" or not model["available"] or model["membershipLocked"]:
                continue
            video = model["capabilityConfig"]["video"]
            operations = _OPERATIONS.intersection(video["operations"])
            if not operations:
                continue
            screen = video.get("fixedScreenSpec") or video
            duration = video["duration"]
            durations = []
            if video.get("durationSupported", True):
                durations = duration["values"] if duration["selection"] == "enum" else list(range(duration["min"], duration["max"] + 1, duration["step"]))
            result.append({"id": model["id"], "channelId": channel["id"], "model": model["modelKey"],
                           "label": model["displayName"] or model["modelKey"], "price": model["priceLabel"],
                           "durations": durations, "ratios": screen["ratios"], "resolutions": screen["resolutions"],
                           "operations": sorted(operations), "references": video["references"]})
    return result


def handle_action(action: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    if action != "list_models":
        return {"ok": False, "error": f"不支持的设置动作：{action}"}
    try:
        key = (data or {}).get("api_key", get_params()["api_key"]).strip()
        return {"ok": True, "models": model_options(Client(key))}
    except YuyanError as exc:
        return {"ok": False, "error": str(exc)}


def local_paths(value: Any) -> Iterator[Path]:
    if isinstance(value, (str, Path)) and str(value).strip():
        yield Path(value).expanduser().resolve(strict=True)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from local_paths(item)
    elif isinstance(value, dict):
        for key in ("path", "file", "filePath", "localPath", "src", "value"):
            if key in value:
                yield from local_paths(value[key])
                return
        for item in value.values():
            yield from local_paths(item)


def collect_references(context: dict[str, Any]) -> list[tuple[str, str, Path]]:
    image_map = context.get("reference_images")
    frames = image_map if isinstance(image_map, dict) else {}
    items: list[tuple[str, str, Path]] = []
    with_frames = [("first_frame", context.get("first_frame_path") or frames.get("首帧")),
                   ("last_frame", context.get("end_frame_path") or frames.get("尾帧"))]
    for role, value in with_frames:
        items.extend(("image", role, path) for path in local_paths(value))
    frame_paths = {path for _, _, path in items}
    image_refs = {key: val for key, val in frames.items() if key not in {"首帧", "尾帧"}} if frames else image_map
    for kind, role, values in (("image", "reference_image", (image_refs, context.get("reference_image_paths"))),
                               ("video", "reference_video", (context.get("reference_videos"), context.get("reference_video_paths"))),
                               ("audio", "reference_audio", (context.get("reference_audios"), context.get("reference_audio_paths"), context.get("audio_path")))):
        items.extend((kind, role, path) for path in local_paths(values) if kind != "image" or path not in frame_paths)
    return list(dict.fromkeys(items))


def prepare_video(model: dict[str, Any], params: dict[str, Any], prompt: str,
                  refs: list[tuple[str, str, Path]]) -> tuple[str, dict[str, Any]]:
    options: dict[str, Any] = {}
    for param, field, available in (("ratio", "size", "ratios"), ("duration", "duration", "durations"), ("resolution", "resolution", "resolutions")):
        value = params[param]
        if value != "":
            value = int(value) if param == "duration" else value
            if value not in model[available]:
                raise YuyanError(f"当前模型不支持选定的{ {'ratio': '画幅', 'duration': '时长', 'resolution': '清晰度'}[param] }，请刷新模型后重选。")
            options[field] = value
    roles = [role for _, role, _ in refs]
    if "reference_video" in roles or "reference_image" in roles:
        operation = "reference_to_video"
    elif "first_frame" in roles or "last_frame" in roles:
        operation = "image_to_video"
    elif "reference_audio" in roles:
        operation = "audio_to_video"
    else:
        operation = "text_to_video"
    if operation not in model["operations"]:
        raise YuyanError(f"当前模型不支持这组分镜素材（{operation}）。")
    contract = model["references"]
    if len(prompt) > contract["promptMaxChars"]:
        raise YuyanError(f"提示词超过当前模型的 {contract['promptMaxChars']} 字上限。")
    for kind, limit, limit_bytes in (("image", "maxImages", "maxImageBytes"), ("video", "maxVideos", "maxVideoBytes"), ("audio", "maxAudios", "maxAudioBytes")):
        files = [path for source, _, path in refs if source == kind]
        if len(files) > contract[limit]:
            raise YuyanError(f"当前模型最多接受 {contract[limit]} 个 {kind} 参考文件。")
        for path in files:
            if not path.is_file():
                raise YuyanError(f"参考素材不是本地文件：{path}")
            if contract[limit_bytes] > 0 and path.stat().st_size > contract[limit_bytes]:
                raise YuyanError(f"参考素材超过当前模型的大小上限：{path.name}")
    return operation, options


def emit(context: dict[str, Any], status: str, percent: int) -> None:
    callback = context.get("progress_callback")
    if callback is not None:
        callback(status, percent)


def receipt_path(folder: Path, context: dict[str, Any], prompt: str) -> Path:
    if context.get("viewer_index") is None:
        raise YuyanError("字字动画没有提供分镜编号，无法安全保存续传记录。")
    position = context.get("output_position", 0)
    if isinstance(position, (list, tuple)):
        position = position[0] if position else 0
    # 同一个输出允许跨生成轮次续传；摘要避免分镜换位后把不同提示词的结果填错。
    shot = json.dumps([int(context["viewer_index"]), str(position), prompt], ensure_ascii=False).encode("utf-8")
    root = folder / ".yuyan-video-tasks"
    root.mkdir(exist_ok=True)
    return root / (sha256(shot).hexdigest() + ".json")


@contextmanager
def shot_lock(path: Path) -> Iterator[None]:
    with path.with_suffix(".lock").open("a+b") as lock:
        try:
            if sys.platform == "win32":
                import msvcrt
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                from fcntl import LOCK_EX, LOCK_NB, flock
                flock(lock.fileno(), LOCK_EX | LOCK_NB)
        except OSError as exc:
            if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise
            raise YuyanError("这个分镜正在等待原任务，请勿重复点击。") from exc
        yield  # 宿主退出后操作系统会释放文件锁，已经保存的任务编号保留。


def save_receipt(path: Path, request_id: str, task_id: str | None) -> None:
    stream = NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False)
    temp = Path(stream.name)
    try:
        with stream:
            json.dump({"requestId": request_id, "taskId": task_id}, stream)
            stream.flush()
            fsync(stream.fileno())
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def active_progress(task: dict[str, Any]) -> tuple[str, int]:
    # workbench-gallery.tsx 也把网站进行中进度限制在 4–99%，终态完成单独展示。
    percent = max(4, min(99, task["progress"]))
    stage = "排队" if task["status"] == "queued" else "生成"
    return f"{stage} {percent}%", percent


def read_task(client: Client, route: str, context: dict[str, Any], deadline: float, percent: int) -> dict[str, Any]:
    failures = 0
    while time.monotonic() < deadline:
        try:
            return client.json("GET", route)
        except RequestFailure as exc:
            if not exc.retryable:
                raise
            delay = max(exc.retry_after, min(60, 3 * (2 ** min(failures, 5))))
            failures += 1
            reason = "限流等待" if exc.status == 429 else "重连中"
            emit(context, f"{reason} {percent}%", percent)
            time.sleep(max(0, min(delay, deadline - time.monotonic())))
    raise YuyanError("本次等待超时，任务编号已保留；再次点击可继续查询。")


def return_video(client: Client, file: dict[str, Any], folder: Path, context: dict[str, Any]) -> str:
    for attempt in range(_DOWNLOAD_ATTEMPTS):
        try:
            emit(context, "回传 0%", 95)
            return client.download(file, folder, context)
        except RequestFailure as exc:
            if not exc.retryable or attempt + 1 == _DOWNLOAD_ATTEMPTS:
                raise
            emit(context, "重连回传", 95)
            time.sleep(max(exc.retry_after, min(60, 3 * (2 ** attempt))))
    raise AssertionError("下载重试次数必须大于零")


def submit_task(client: Client, params: dict[str, Any], context: dict[str, Any], prompt: str, receipt: Path) -> dict[str, Any]:
    if not params["model"]:
        raise YuyanError("请先读取网站模型，并在插件设置中选择一个屿砚视频模型。")
    emit(context, "准备素材", 0)
    model = next((item for item in model_options(client) if item["id"] == params["model"]), None)
    if model is None:
        raise YuyanError("所选模型对当前屿砚账号已不可用，请刷新后重选。")
    refs = collect_references(context)
    operation, options = prepare_video(model, params, prompt, refs)
    references = []
    uploaded = {}
    for kind, role, path in refs:
        if path not in uploaded:
            emit(context, "上传素材", 1)
            uploaded[path] = client.upload(path, kind)
        references.append({"fileId": uploaded[path], "role": role})
    request_id = "zizi-video-" + uuid4().hex
    emit(context, "提交任务", 2)
    save_receipt(receipt, request_id, None)
    try:
        task = client.json("POST", "/tasks", {"channelId": model["channelId"], "model": model["model"],
                                               "capability": "video", "operation": operation, "surface": "video-workbench",
                                               "prompt": prompt, "options": options, "references": references,
                                               "idempotencyKey": request_id})
        save_receipt(receipt, request_id, task["id"])
        return task
    except (OSError, ValueError, KeyError, YuyanError) as exc:
        if isinstance(exc, RequestFailure) and exc.status in _REJECTED_SUBMISSION:
            receipt.unlink()
            raise
        raise YuyanError(f"提交未确认，请在屿砚视频作品核对后再试（请求 {request_id}）：{exc}") from exc


def finish_task(client: Client, receipt: Path, folder: Path, context: dict[str, Any],
                task_id: str, task: dict[str, Any] | None) -> list[str]:
    deadline = time.monotonic() + _TASK_WAIT
    route = "/tasks/" + quote(task_id, safe="")
    try:
        if task is None:
            emit(context, "恢复原任务", 0)
            task = read_task(client, route, context, deadline, 0)
        while task["status"] in {"queued", "running"}:
            label, percent = active_progress(task)
            emit(context, label, percent)
            time.sleep(max(0, min(_POLL_INTERVAL * uniform(0.9, 1.1), deadline - time.monotonic())))
            task = read_task(client, route, context, deadline, percent)
        if task["status"] in {"failed", "cancelled"}:
            receipt.unlink()
            raise YuyanError(f"网站{('已取消任务' if task['status'] == 'cancelled' else '生成失败')}：{task['error'] or task['stage']}")
        if task["status"] != "succeeded":
            raise YuyanError(f"无法识别网站任务状态：{task['status']}")
        videos = [file for file in task["files"] if file["kind"] == "video"]
        if len(videos) != 1:
            raise YuyanError(f"任务应返回一个分镜视频，实际返回 {len(videos)} 个。")
        output = return_video(client, videos[0], folder, context)
        emit(context, "回传完成", 100)
        receipt.unlink()
        return [output]
    except (OSError, ValueError, KeyError, YuyanError) as exc:
        raise YuyanError(f"屿砚任务 {task_id}：{exc}。可在网站视频作品核对。") from exc


def generate(context: dict[str, Any]) -> list[str]:
    params = {**get_params(), **context.get("plugin_params", {})}
    prompt = context["prompt"].strip()
    directory = context.get("project_path") or context.get("output_dir")
    if not prompt or not directory:
        raise YuyanError("分镜没有视频提示词或项目保存目录。")
    folder = Path(directory).expanduser().resolve()
    folder.mkdir(parents=True, exist_ok=True)
    receipt = receipt_path(folder, context, prompt)
    client = Client(params["api_key"].strip())
    with shot_lock(receipt):
        if receipt.is_file():
            existing = json.loads(receipt.read_text(encoding="utf-8"))
            task_id = existing["taskId"]
            if task_id is None:
                raise YuyanError(f"原提交结果未确认（请求 {existing['requestId']}），请在网站核对，插件不会再次扣费提交。")
            return finish_task(client, receipt, folder, context, task_id, None)
        task = submit_task(client, params, context, prompt, receipt)
        return finish_task(client, receipt, folder, context, task["id"], task)
