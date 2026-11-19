"""打包独立的屿砚视频插件，明确列出文件，排除宿主配置与 Key。"""
import ast
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

repo = Path(__file__).resolve().parents[1]
root = repo / "integrations" / "zizi-yuyan"
plugin = Path("user_resources/plugins/video_plugins/video_plugin_yuyan_cloud")
files = [Path("安装说明.md"), *(plugin / name for name in ("main.py", "info.json", "ui/index.html"))]
info = json.loads((root / plugin / "info.json").read_text(encoding="utf-8"))
ast.parse((root / plugin / "main.py").read_text(encoding="utf-8"))
target = repo / "release" / f"Yuyan-Zizi-Video-Plugin-{info['version']}.zip"
target.parent.mkdir(exist_ok=True)
with ZipFile(target, "w", ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, name.as_posix())
with ZipFile(target) as archive:
    assert archive.namelist() == [name.as_posix() for name in files] and archive.testzip() is None
print(target)
