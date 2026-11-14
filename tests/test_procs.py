import os
import subprocess
import sys

from core import procs


def test_snapshot_lists_groups_and_protects_self():
    s = procs.snapshot(sample=0.05)
    assert s["ok"] and s["groups"] and s["total"] > 0
    me = next(g for g in s["groups"] if os.getpid() in g["pids"])
    assert me["self"] and not me["can_end"]


def test_end_refuses_self_and_ends_child():
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        r = procs.end([os.getpid(), child.pid])
        assert r["ended"] == 1 and r["failed"] == 1
        assert child.wait(5) is not None
    finally:
        if child.poll() is None:
            child.kill()


def test_busy_caches(monkeypatch):
    monkeypatch.setattr(procs, "running", lambda names: "chrome.exe" in names)
    assert procs.busy_caches(["chrome", "edge", "npm"]) == {"chrome": "Chrome 浏览器"}
