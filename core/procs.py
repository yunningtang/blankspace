"""正在运行的程序：谁占内存、谁占 CPU；清理前查谁在用这些缓存。

- 只看，不自动关任何东西。“关掉”要用户点，并且先确认。
- 系统必需的进程（csrss、lsass、svchost……）和留白自己，不给“关掉”的按钮。
- 关的时候先礼貌地请它退出（terminate）；用户可能有没保存的东西，所以确认时要说清楚。
"""
from __future__ import annotations

import os
import time

try:
    import psutil
except ImportError:  # pragma: no cover - psutil 在 requirements 里
    psutil = None

# 常见程序的中文名（按进程文件名，小写）
FRIENDLY = {
    "chrome.exe": "Chrome 浏览器", "msedge.exe": "Edge 浏览器", "firefox.exe": "Firefox 浏览器",
    "wechat.exe": "微信", "weixin.exe": "微信", "wechatappex.exe": "微信（小程序）", "qq.exe": "QQ",
    "dingtalk.exe": "钉钉", "feishu.exe": "飞书", "lark.exe": "飞书", "teams.exe": "Teams", "ms-teams.exe": "Teams",
    "code.exe": "VS Code", "explorer.exe": "资源管理器", "winword.exe": "Word", "excel.exe": "Excel",
    "powerpnt.exe": "PowerPoint", "outlook.exe": "Outlook", "onedrive.exe": "OneDrive",
    "steam.exe": "Steam", "steamwebhelper.exe": "Steam", "spotify.exe": "Spotify",
    "photoshop.exe": "Photoshop", "acrobat.exe": "Acrobat", "wps.exe": "WPS", "et.exe": "WPS 表格",
    "msmpeng.exe": "Windows 安全中心", "searchindexer.exe": "Windows 搜索", "dwm.exe": "Windows 桌面",
    "python.exe": "Python", "node.exe": "Node.js", "java.exe": "Java", "docker desktop.exe": "Docker",
    "vmmem": "WSL / 虚拟机", "vmmemwsl": "WSL", "liubai.exe": "留白",
}
# 关掉会让系统出问题的：不给关的按钮
CRITICAL = {"system", "system idle process", "registry", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe",
            "services.exe", "lsass.exe", "svchost.exe", "dwm.exe", "fontdrvhost.exe", "memory compression",
            "msmpeng.exe", "sihost.exe", "ctfmon.exe", "audiodg.exe", "spoolsv.exe", "lsaiso.exe",
            "secure system", "vmmem", "vmmemwsl", "searchindexer.exe", "conhost.exe"}
# 哪些程序开着时，它的缓存清不掉（缓存的 key → 进程名）
CACHE_USERS = {
    "chrome": ("chrome.exe",), "edge": ("msedge.exe",), "firefox": ("firefox.exe",),
    "wxcache": ("wechat.exe", "weixin.exe"), "teams": ("teams.exe", "ms-teams.exe"), "vscode": ("code.exe",),
    "thumbs": ("explorer.exe",),
}


def _name(proc_name: str) -> str:
    return FRIENDLY.get(proc_name.lower(), proc_name.rsplit(".", 1)[0] if proc_name.lower().endswith(".exe") else proc_name)


def snapshot(sample: float = 0.3) -> dict:
    """按程序汇总：同一个程序的多个进程（比如 Chrome 的几十个）合成一行。"""
    if psutil is None:
        return {"ok": False, "groups": [], "total": 0, "used": 0}
    procs = []
    for p in psutil.process_iter(["pid", "name", "memory_info", "username"]):
        try:
            p.cpu_percent(None)        # 第一次调用只是开始计时
            procs.append(p)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    time.sleep(sample)
    me = os.getpid()
    groups: dict[str, dict] = {}
    ncpu = psutil.cpu_count() or 1
    for p in procs:
        try:
            info = p.info
            name = (info.get("name") or "").strip()
            if not name:
                continue
            mem = info["memory_info"].rss if info.get("memory_info") else 0
            cpu = p.cpu_percent(None) / ncpu
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        k = _name(name) or name
        g = groups.setdefault(k, {"name": k, "exe": name, "pids": [], "memory": 0, "cpu": 0.0, "count": 0,
                                  "critical": False, "self": False})
        g["pids"].append(info["pid"])
        g["memory"] += mem
        g["cpu"] += cpu
        g["count"] += 1
        g["critical"] = g["critical"] or name.lower() in CRITICAL
        g["self"] = g["self"] or info["pid"] == me
    vm = psutil.virtual_memory()
    out = sorted(groups.values(), key=lambda g: -g["memory"])
    for g in out:
        g["cpu"] = round(g["cpu"], 1)
        g["can_end"] = not g["critical"] and not g["self"] and g["exe"].lower() != "explorer.exe"
    return {"ok": True, "groups": out[:60], "total": vm.total, "used": vm.total - vm.available,
            "percent": vm.percent}


def running(names: tuple[str, ...]) -> bool:
    if psutil is None:
        return False
    want = {n.lower() for n in names}
    for p in psutil.process_iter(["name"]):
        try:
            if (p.info.get("name") or "").lower() in want:
                return True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return False


def busy_caches(keys: list[str]) -> dict[str, str]:
    """这些缓存里，哪些的程序正开着。返回 {缓存 key: 程序名}。"""
    out = {}
    for k in keys:
        names = CACHE_USERS.get(k)
        if names and running(names):
            out[k] = _name(names[0])
    return out


def end(pids: list[int]) -> dict:
    """请这些进程退出。系统进程和留白自己不动。返回成功和失败的个数。"""
    if psutil is None:
        return {"ended": 0, "failed": len(pids)}
    me = os.getpid()
    ended = failed = 0
    targets = []
    for pid in pids:
        try:
            p = psutil.Process(pid)
            n = (p.name() or "").lower()
            if pid == me or n in CRITICAL or n == "explorer.exe":
                failed += 1
                continue
            p.terminate()
            targets.append(p)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            failed += 1
    gone, alive = psutil.wait_procs(targets, timeout=3)
    ended = len(gone)
    failed += len(alive)
    return {"ended": ended, "failed": failed}
