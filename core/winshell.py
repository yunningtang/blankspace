"""和资源管理器打交道：打开文件夹、在文件夹中选中一个文件。都只是打开窗口，不改任何东西。"""
from __future__ import annotations

import os
import subprocess
import sys


def _select_in_explorer(path: str) -> bool:
    """用 Windows 的 SHOpenFolderAndSelectItems 打开所在文件夹并选中它。
    比 `explorer /select,` 可靠：路径里有空格、中文、逗号都没问题。"""
    try:
        import ctypes
        from ctypes import wintypes
        shell32, ole32 = ctypes.windll.shell32, ctypes.windll.ole32
        ole32.CoInitializeEx(None, 2)                     # 每个线程都要初始化一次 COM
        pidl = ctypes.c_void_p()
        sfgao = wintypes.ULONG()
        hr = shell32.SHParseDisplayName(ctypes.c_wchar_p(path), None, ctypes.byref(pidl), 0, ctypes.byref(sfgao))
        if hr != 0 or not pidl:
            return False
        try:
            return shell32.SHOpenFolderAndSelectItems(pidl, 0, None, 0) == 0
        finally:
            ole32.CoTaskMemFree(pidl)
    except Exception:
        return False


def reveal(path: str) -> bool:
    """在资源管理器里打开它所在的文件夹，并选中它。"""
    path = os.path.normpath(os.path.abspath(path))
    if sys.platform != "win32" or not os.path.lexists(path):
        return False
    if _select_in_explorer(path):
        return True
    try:  # 退一步：注意 /select, 和路径要写在同一个参数里
        subprocess.Popen(f'explorer /select,"{path}"')
        return True
    except OSError:
        return False


def open_folder(path: str) -> bool:
    """打开一个文件夹；如果是文件，就打开它所在的文件夹并选中它。"""
    path = os.path.normpath(os.path.abspath(path))
    if sys.platform != "win32" or not os.path.exists(path):
        return False
    if os.path.isdir(path):
        try:
            os.startfile(path)  # noqa: S606 - 只是打开文件夹
            return True
        except OSError:
            return False
    return reveal(path)


def open_file(path: str) -> bool:
    """用默认程序打开文件（比如图片用照片查看器）。"""
    if sys.platform != "win32" or not os.path.isfile(path):
        return False
    try:
        os.startfile(path)  # noqa: S606
        return True
    except OSError:
        return False


def pick_folder(window) -> str | None:
    """弹出 Windows 的“选择文件夹”对话框（pywebview）。"""
    if window is None:
        return None
    try:
        import webview
        res = window.create_file_dialog(webview.FOLDER_DIALOG)
        return res[0] if res else None
    except Exception:
        return None
