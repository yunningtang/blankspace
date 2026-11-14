"""可以选来看的地方：各个盘、常用文件夹。只读，而且很快（只问系统用量，不扫文件）。"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from . import recycle


def _label(root: str) -> str:
    if sys.platform != "win32":
        return root
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(256)
        if ctypes.windll.kernel32.GetVolumeInformationW(root, buf, 256, None, None, None, None, 0) and buf.value:
            return buf.value
    except Exception:
        pass
    return ""


def drives() -> list[dict]:
    """本地磁盘和移动硬盘（不含光驱、网络盘）。"""
    out = []
    if sys.platform == "win32":
        system = (os.environ.get("SystemDrive") or "C:").upper()
        for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            root = f"{letter}:\\"
            if not os.path.exists(root):
                continue
            t = recycle.drive_type(root)
            if t not in (2, 3):
                continue
            try:
                u = shutil.disk_usage(root)
            except OSError:
                continue
            name = f"{letter} 盘"
            out.append({"path": root, "name": name, "label": _label(root), "total": u.total, "used": u.used,
                        "free": u.free, "system": f"{letter}:" == system, "removable": t == 2})
    else:
        for root in ("/", str(Path.home())):
            try:
                u = shutil.disk_usage(root)
            except OSError:
                continue
            out.append({"path": root, "name": "主目录" if root != "/" else "根目录", "label": "", "total": u.total,
                        "used": u.used, "free": u.free, "system": root == "/", "removable": False})
    return out


def folders(home: str | None = None) -> list[dict]:
    """常用的个人文件夹（存在的才列）。"""
    h = Path(home) if home else Path.home()
    cand = [("下载", h / "Downloads"), ("桌面", h / "Desktop"), ("文档", h / "Documents"),
            ("图片", h / "Pictures"), ("视频", h / "Videos"), ("音乐", h / "Music"),
            ("微信文件", h / "Documents" / "WeChat Files"), ("微信文件", h / "Documents" / "xwechat_files")]
    return [{"path": str(p), "name": name} for name, p in cand if p.is_dir()]
