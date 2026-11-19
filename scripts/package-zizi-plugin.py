"""Package only reviewed plugin code; never include user configs or credentials."""
import ast
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1] / 'integrations' / 'zizi-workbench'
files = ['安装说明.md']
versions = set()
for kind in ('image', 'video'):
    folder = f'user_resources/plugins/{kind}_plugins/{kind}_plugin_lalor_workbench'
    info = json.loads((root / folder / 'info.json').read_text(encoding='utf-8-sig'))
    versions.add(info['version'])
    ast.parse((root / folder / 'main.py').read_text(encoding='utf-8-sig'))
    files.extend(f'{folder}/{name}' for name in ('main.py', 'info.json', 'ui/index.html'))
if len(versions) != 1:
    raise RuntimeError('Image and video plugin versions must match')
target = root / f'Lalor-Zizi-Plugins-{versions.pop()}.zip'
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, name)
with zipfile.ZipFile(target) as archive:
    assert archive.namelist() == files and archive.testzip() is None
print(f'Plugin archive verified: {target.name}; {len(files)} files; {target.stat().st_size} bytes')
