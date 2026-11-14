"""留白：入口。

优先用 pywebview 打开新界面（webui/）；没装 pywebview、或者窗口打不开（比如电脑上没有 WebView2）时，
退回旧的 CustomTkinter 界面。`--tk` 强制用旧界面。
"""
import os
import sys

__version__ = "0.4.0"


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

    # 后端
    def state(self): return self._api.state()
    def scan(self): return self._api.scan()
    def cancel(self): return self._api.cancel()
    def inspect(self, key): return self._api.inspect(key)
    def set_keep(self, item_id, on=True): return self._api.set_keep(item_id, on)
    def set_keeper(self, group_id, file_id): return self._api.set_keeper(group_id, file_id)
    def plan(self, kind, ids, target=None): return self._api.plan(kind, ids, target)
    def execute(self, plan_id): return self._api.execute(plan_id)
    def undo(self, batch): return self._api.undo(batch)
    def clear_job(self): return self._api.clear_job()
    def history(self): return self._api.history()
    def open_recycle_bin(self): return self._api.open_recycle_bin()
    def reveal(self, path): return self._api.reveal(path)
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
        self._api.cancel()
        if self._window:
            self._window.destroy()


def run_web():
    import webview  # pywebview

    from core.api import Api
    bridge = Bridge(Api())
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
