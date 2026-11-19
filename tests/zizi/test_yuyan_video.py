"""使用本机 HTTP 服务验证字字动画插件合同，不连接生产平台。"""
import importlib.util
import io
import json
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from email.message import Message
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import Mock, patch


PLUGIN = Path(__file__).resolve().parents[2] / "integrations/zizi-yuyan/user_resources/plugins/video_plugins/video_plugin_yuyan_cloud/main.py"
SPEC = importlib.util.spec_from_file_location("zizi_yuyan_test", PLUGIN)
plugin = importlib.util.module_from_spec(SPEC)
utils = types.ModuleType("plugin_utils")
utils.load_plugin_config = lambda _: {}
with patch.dict(sys.modules, {"plugin_utils": utils}):
    SPEC.loader.exec_module(plugin)


CATALOG = {"channels": [{"id": "test-channel", "models": [{
    "id": "test-model", "modelKey": "minimax-h3", "displayName": "MiniMax H3", "priceLabel": "测试",
    "capability": "video", "available": True, "membershipLocked": False,
    "capabilityConfig": {"video": {
        "duration": {"selection": "range", "min": 5, "max": 20, "step": 5},
        "ratios": ["16:9", "1:1"], "resolutions": ["768P"],
        "operations": ["text_to_video", "image_to_video", "reference_to_video"],
        "references": {"promptMaxChars": 20000, "maxImages": 9, "maxImageBytes": 4096,
                       "maxVideos": 3, "maxVideoBytes": 4096, "maxAudios": 3, "maxAudioBytes": 4096},
    }},
}]}]}
SAMPLE = b"\x00\x00\x00\x18ftypmp42" + bytes(range(12))


class Endpoint(BaseHTTPRequestHandler):
    def send_json(self, value, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"code": 0, "data": value, "msg": ""}).encode())

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.calls.append((self.command, self.path, self.headers.get("Authorization")))
        if self.path == "/api/v1/models":
            self.send_json(CATALOG)
        elif self.path == "/api/v1/tasks/task-0042":
            if self.server.poll_responses:
                status, value = self.server.poll_responses.pop(0)
                if status == 200:
                    self.send_json({"id": "task-0042", "status": "running", "stage": "长文本任务ID应隐藏", "progress": value})
                else:
                    self.send_response(status)
                    if value:
                        self.send_header("Retry-After", str(value))
                    self.end_headers()
                return
            self.send_json({"id": "task-0042", "status": "succeeded", "stage": "已完成", "progress": 100,
                            "files": [{"id": "video-1", "contentType": "video/mp4", "kind": "video", "bytes": len(SAMPLE),
                                       "contentUrl": ("https://example.invalid/unsafe" if self.server.bad_route else "/api/v1/files/video-1/content")}]})
        elif self.path == "/api/v1/files/video-1/content":
            data = SAMPLE[:-1] if self.server.truncate else SAMPLE
            self.server.truncate = max(0, self.server.truncate - 1)
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_error(404)

    def do_POST(self):
        self.server.calls.append((self.command, self.path, self.headers.get("Authorization")))
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        if self.path == "/api/v1/files":
            self.server.uploaded.append(raw)
            self.send_json({"id": f"ref-{len(self.server.uploaded)}", "kind": "image"})
        elif self.path == "/api/v1/tasks":
            self.server.submitted.append(json.loads(raw))
            if self.server.reject:
                self.send_json(None, self.server.reject)
                return
            self.send_json({"id": "task-0042", "status": "queued", "stage": "等待生成", "progress": 1})
        else:
            self.send_error(404)


class YuyanPluginTest(unittest.TestCase):
    def setUp(self):
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), Endpoint)
        self.srv.calls, self.srv.uploaded, self.srv.submitted = [], [], []
        self.srv.truncate = self.srv.reject = 0
        self.srv.bad_route = False
        self.srv.poll_responses = []
        thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        self.addCleanup(patch.stopall)
        patch.object(plugin, "_API", f"http://127.0.0.1:{self.srv.server_port}/api/v1").start()
        self.elapsed = 0
        self.delays = []
        def sleep(seconds):
            self.elapsed += seconds
            self.delays.append(seconds)
        patch.object(plugin, "time", types.SimpleNamespace(monotonic=lambda: self.elapsed, sleep=sleep)).start()
        patch.object(plugin, "uniform", return_value=1).start()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.directory = Path(tmp.name)
        self.progress = []
        self.context = {"prompt": "分镜一：两只狗跑步。\n镜头向前。", "project_path": tmp.name, "viewer_index": 7,
                        "unique_name": "原分镜", "plugin_params": {"api_key": "mock-only-key", "model": "test-model",
                                                                   "duration": "20", "ratio": "1:1", "resolution": "768P"},
                        "progress_callback": lambda text, percent: self.progress.append((text, percent))}

    def test_catalog_does_not_create_tasks(self):
        reply = plugin.handle_action("list_models", {"api_key": "mock-only-key"})
        self.assertTrue(reply["ok"])
        self.assertIn(20, reply["models"][0]["durations"])
        self.assertEqual(self.srv.calls, [("GET", "/api/v1/models", "Bearer mock-only-key")])

    def test_prompt_frames_submit_once_and_return_video_to_same_shot(self):
        first, last = self.directory / "首帧.png", self.directory / "尾帧.png"
        first.write_bytes(b"first-ref")
        last.write_bytes(b"last-ref")
        self.context.update({"first_frame_path": str(first), "end_frame_path": str(last), "reference_images": {"首帧": str(first)}})
        files = plugin.generate(self.context)
        self.assertEqual(len(files), 1)
        result = Path(files[0])
        self.assertEqual(result.parent, self.directory.resolve())
        self.assertTrue(result.name.startswith("0007_原分镜_"))
        self.assertEqual(result.read_bytes(), SAMPLE)
        self.assertEqual(len(self.srv.submitted), 1)
        task = self.srv.submitted[0]
        self.assertEqual(task["prompt"], self.context["prompt"])
        self.assertEqual(task["surface"], "video-workbench")
        self.assertEqual(task["options"], {"duration": 20, "size": "1:1", "resolution": "768P"})
        self.assertEqual(task["operation"], "image_to_video")
        self.assertEqual(task["references"], [{"fileId": "ref-1", "role": "first_frame"}, {"fileId": "ref-2", "role": "last_frame"}])
        self.assertIn(b"first-ref", self.srv.uploaded[0])
        self.assertIn(b"last-ref", self.srv.uploaded[1])
        self.assertEqual(self.progress[-1], ("回传完成", 100))

    def test_timeout_or_http_failure_does_not_retry_submission(self):
        self.srv.reject = 503
        with self.assertRaisesRegex(plugin.YuyanError, "提交未确认"):
            plugin.generate(self.context)
        with self.assertRaisesRegex(plugin.YuyanError, "原提交结果未确认"):
            plugin.generate(self.context)
        self.assertEqual(len(self.srv.submitted), 1)

    def test_incomplete_download_never_returns_a_local_video(self):
        self.srv.truncate = plugin._DOWNLOAD_ATTEMPTS
        with self.assertRaisesRegex(plugin.YuyanError, "task-0042.*下载不完整"):
            plugin.generate(self.context)
        self.assertEqual(list(self.directory.glob("*.part")), [])
        self.assertEqual(list(self.directory.glob("*.mp4")), [])
        self.assertEqual(len(list(self.directory.glob(".yuyan-video-tasks/*.json"))), 1)

    def test_long_website_progress_recovers_rate_limit_and_gateway_error(self):
        self.srv.poll_responses = [(200, 24), (429, 47), (503, 0)] + [(200, 42)] * 76
        result, = plugin.generate(self.context)
        self.assertGreater(self.elapsed, 15 * 60)
        self.assertIn(47, self.delays)
        self.assertIn(("排队 4%", 4), self.progress)
        self.assertIn(("生成 24%", 24), self.progress)
        self.assertIn(("限流等待 24%", 24), self.progress)
        self.assertIn(("生成 42%", 42), self.progress)
        self.assertTrue(all("task-0042" not in text for text, _ in self.progress))
        self.assertEqual(Path(result).read_bytes(), SAMPLE)
        self.assertEqual(len(self.srv.submitted), 1)

    def test_same_shot_resumes_original_job_after_host_ends_waiting(self):
        self.srv.poll_responses = [(200, 24)]
        with patch.object(plugin, "_TASK_WAIT", 18):
            with self.assertRaisesRegex(plugin.YuyanError, "等待超时"):
                plugin.generate(self.context)
        receipt, = self.directory.glob(".yuyan-video-tasks/*.json")
        saved = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual(saved["taskId"], "task-0042")
        self.assertEqual(set(saved), {"requestId", "taskId"})
        self.context["generation_round"] = 2
        self.context["plugin_params"]["model"] = "no-longer-listed"
        result, = plugin.generate(self.context)
        self.assertEqual(Path(result).read_bytes(), SAMPLE)
        self.assertEqual(len(self.srv.submitted), 1)
        self.assertFalse(receipt.exists())

    def test_download_retries_from_same_task_without_resubmitting(self):
        self.srv.truncate = 1
        result, = plugin.generate(self.context)
        self.assertEqual(Path(result).read_bytes(), SAMPLE)
        self.assertIn(("重连回传", 95), self.progress)
        download_calls = [call for _, call, _ in self.srv.calls if call.endswith("/content")]
        self.assertEqual(len(download_calls), 2)
        self.assertEqual(len(self.srv.submitted), 1)

    def test_explicit_rate_rejection_clears_unaccepted_submission_without_retry(self):
        self.srv.reject = 429
        with self.assertRaisesRegex(plugin.YuyanError, "HTTP 429"):
            plugin.generate(self.context)
        self.assertEqual(len(self.srv.submitted), 1)
        self.assertEqual(list(self.directory.glob(".yuyan-video-tasks/*.json")), [])

    def test_concurrent_click_cannot_submit_in_the_same_shot(self):
        receipt = plugin.receipt_path(self.directory, self.context, self.context["prompt"])
        with plugin.shot_lock(receipt):
            with self.assertRaisesRegex(plugin.YuyanError, "正在等待原任务"):
                plugin.generate(self.context)
        self.assertEqual(self.srv.submitted, [])

    def test_invalid_model_options_reject_before_submission(self):
        self.context["plugin_params"]["duration"] = "19"
        with self.assertRaisesRegex(plugin.YuyanError, "时长"):
            plugin.generate(self.context)
        self.assertEqual(self.srv.submitted, [])

    def test_download_route_cannot_send_the_key_off_site(self):
        self.srv.bad_route = True
        with self.assertRaisesRegex(plugin.YuyanError, "地址不符合"):
            plugin.generate(self.context)
        self.assertNotIn(("GET", "/api/v1/files/video-1/content", "Bearer mock-only-key"), self.srv.calls)

    def test_site_redirect_downloads_without_bearer(self):
        client = plugin.Client("mock-only-key")
        response = io.BytesIO(SAMPLE)
        response.headers = Message()
        response.headers["Content-Type"] = "video/mp4"
        redirect = Message()
        redirect["Location"] = "https://storage.example.invalid/signed-video?ticket=test"
        client.opener = Mock()
        client.opener.open.side_effect = [HTTPError("https://yuyan-ai.site/file", 307, "redirect", redirect, io.BytesIO()), response]
        file = {"id": "video-1", "kind": "video", "contentType": "video/mp4", "bytes": len(SAMPLE), "contentUrl": "/api/v1/files/video-1/content"}
        self.assertEqual(Path(client.download(file, self.directory, self.context)).read_bytes(), SAMPLE)
        original, storage = [call.args[0] for call in client.opener.open.call_args_list]
        self.assertEqual(original.get_header("Authorization"), "Bearer mock-only-key")
        self.assertEqual(storage.full_url, redirect["Location"])
        self.assertIsNone(storage.get_header("Authorization"))
