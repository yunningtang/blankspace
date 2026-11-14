# PyInstaller 配置：在 Windows 上运行 `pyinstaller --noconfirm packaging/liubai.spec`
# 生成 dist/Liubai/Liubai.exe（文件夹形式，启动快）。
import os
from PyInstaller.utils.hooks import collect_data_files

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))

a = Analysis(
    [os.path.join(ROOT, "main.py")],
    pathex=[ROOT],
    datas=[(os.path.join(ROOT, "webui"), "webui")] + collect_data_files("customtkinter"),
    excludes=["pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="Liubai",
    icon=os.path.join(SPECPATH, "liubai.ico"),
    console=False,
    version=os.path.join(SPECPATH, "version.txt") if os.path.exists(os.path.join(SPECPATH, "version.txt")) else None,
)
coll = COLLECT(exe, a.binaries, a.datas, name="Liubai")
