"""把介绍页拼成一个可以直接发布的文件夹：python site/build.py _site

site/ 里是页面本身；截图、图标和水墨的 ink.js 从仓库其他地方拷过来（和程序、README 用的是同一份）。
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "_site").resolve()
# 不删除任何东西（项目规则）：已经有的文件直接覆盖
shutil.copytree(ROOT / "site", out, ignore=shutil.ignore_patterns("build.py", "__pycache__"), dirs_exist_ok=True)
shutil.copy(ROOT / "webui" / "ink.js", out / "ink.js")
img = out / "img"
img.mkdir(exist_ok=True)
shutil.copy(ROOT / "packaging" / "liubai.png", img / "logo.png")
for f in (ROOT / "docs" / "images").glob("*.jpg"):
    shutil.copy(f, img / f.name)
(img / "en").mkdir(exist_ok=True)
for f in (ROOT / "docs" / "images" / "en").glob("*.jpg"):
    shutil.copy(f, img / "en" / f.name)
(out / ".nojekyll").write_text("")
print(out)
