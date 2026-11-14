"""留白：入口。

优先用 pywebview 打开新界面（webui/）；没装 pywebview、或者窗口打不开（比如电脑上没有 WebView2）时，
退回旧的 CustomTkinter 界面。`--tk` 强制用旧界面。
"""
import os
import sys

__version__ = "0.5.0"


def resource(*parts):
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, *parts)


class Bridge:
    """交给网页的对象。pywebview 会把它的公开方法和公开属性都暴露给网页，
    所以这里只放界面需要的方法，内部对象（日志、设置、窗口）都用下划线藏起来。"""

    def __init__(self, api):
        self._api = api
        self._window = None
        self._maxed = False

    # 开始、选地方、扫描
    def start(self): return self._api.start()
    def set_consent(self, allow_changes): return self._api.set_consent(allow_changes)
    def set_allow_changes(self, on): return self._api.set_allow_changes(on)
    def open_place(self, path, rescan=False): return self._api.open_place(path, rescan)
    def scan_control(self, action): return self._api.scan_control(action)
    def close_place(self): return self._api.close_place()
    def cancel(self): return self._api.cancel()
    def state(self): return self._api.state()
    def view(self, path): return self._api.view(path)

    def pick_folder(self):
        from core.winshell import pick_folder
        return {"path": pick_folder(self._window)}

    # 只读的工具
    def tool(self, kind, path): return self._api.tool(kind, path)
    def caches(self): return self._api.caches()
    def processes(self): return self._api.processes()
    def drives(self, exclude=None): return self._api.drives(exclude)
    def history(self): return self._api.history()
    def set_keep(self, item_id, on=True): return self._api.set_keep(item_id, on)
    def set_keeper(self, group_id, file_id): return self._api.set_keeper(group_id, file_id)

    # 动文件（后端还会检查“允许整理和清理”的开关）
    def plan(self, kind, ids, target=None): return self._api.plan(kind, ids, target)
    def execute(self, plan_id): return self._api.execute(plan_id)
    def undo(self, batch): return self._api.undo(batch)
    def clear_job(self): return self._api.clear_job()
    def end_processes(self, pids): return self._api.end_processes(pids)

    # 打开系统窗口
    def reveal(self, path): return self._api.reveal(path)
    def open_folder(self, path): return self._api.open_folder(path)
    def open_file(self, path): return self._api.open_file(path)
    def open_recycle_bin(self): return self._api.open_recycle_bin()
    def open_storage_settings(self): return self._api.open_storage_settings()

    # 窗口
    def win_minimize(self):
        if self._window:
            self._window.minimize()

    def win_toggle_max(self):
        if self._window:
            (self._window.restore if self._maxed else self._window.maximize)()
            self._maxed = not self._maxed
        return {"maxed": self._maxed}

    def win_close(self):
        self._api.cancel()            # 关窗口就停止扫描
        if self._window:
            self._window.destroy()


def start_path_from_args(argv):
    """从资源管理器右键带进来的文件夹（或盘）。"""
    for a in argv[1:]:
        if not a.startswith("--") and os.path.isdir(a):
            return os.path.abspath(a)
    return None


def run_web():
    import webview  # pywebview

    from core.api import Api
    bridge = Bridge(Api(start_path=start_path_from_args(sys.argv)))
    window = webview.create_window(
        "留白", resource("webui", "index.html"), js_api=bridge,
        width=1200, height=760, min_size=(960, 620),
        frameless=True, easy_drag=False, background_color="#FCFBF8",
    )
    bridge._window = window
    webview.start()


def run_tk():
    import ctypes
    if sys.platform == "win32":
        try:  # 高分屏下字体清晰
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
    from ui.app import App
    App().mainloop()


def main():
    if "--version" in sys.argv:
        print(__version__)
        return
    if "--tk" not in sys.argv:
        try:
            run_web()
            return
        except Exception as e:  # noqa: BLE001 - 新界面打不开时退回旧界面，并说明原因
            if sys.platform == "win32":
                try:
                    import ctypes
                    ctypes.windll.user32.MessageBoxW(
                        None, f"新界面打不开（{e.__class__.__name__}），先用简洁界面。\n"
                              "如果电脑上没有 Microsoft Edge WebView2，安装后就能用新界面。", "留白", 0x40)
                except Exception:
                    pass
    run_tk()


if __name__ == "__main__":
    main()
