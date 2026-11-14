"""后端接口的完整流程：选地方 → 扫描 → 往里走 → 工具 → 预检 → 执行 → 撤销。全部在临时文件夹里。"""
import os
import shutil
import time

import pytest

from core import recycle, tree
from core.api import Api
from core.oplog import OpLog
from core.prefs import Prefs
from core.safety import SafeCache

MB = 1024 * 1024


def make(path, size=MB, data=None, age_days=0):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        if data is None:
            f.truncate(size)
        else:
            f.write(data * size)
    if age_days:
        t = time.time() - age_days * 86400
        os.utime(path, (t, t))
    return path


@pytest.fixture
def world(tmp_path, monkeypatch):
    home = tmp_path / "home"
    dl = home / "Downloads"
    make(dl / "movie.mkv", 80 * MB, age_days=500)
    make(dl / "AppSetup.exe", 60 * MB, age_days=40)
    make(dl / "photos.zip", 70 * MB, age_days=40)
    (dl / "photos").mkdir()
    make(dl / "a.bin", 55 * MB, b"x", age_days=40)
    make(dl / "b.bin", 55 * MB, b"x", age_days=39)
    make(dl / "Screenshot 2025-01-01.png", 10, b"s", age_days=40)
    make(home / "Pictures" / "IMG_20240301_123045.jpg", 10, b"p")
    make(home / "Documents" / "方案终版.docx", 10, b"1", age_days=3)
    make(home / "Documents" / "方案最终版.docx", 10, b"2", age_days=1)
    make(home / "AppCache" / "Temp" / "old.tmp", 5 * MB, age_days=3)
    (tmp_path / "D").mkdir()
    bin_dir = tmp_path / "_bin"; bin_dir.mkdir()
    moved = []
    def fake(p):
        moved.append(p); shutil.move(p, bin_dir / f"{len(moved)}_{os.path.basename(p)}")
    monkeypatch.setattr(recycle, "_backend", fake)
    prefs = Prefs(tmp_path / "prefs.json")
    api = Api(log=OpLog(tmp_path / "logs"), prefs=prefs, home=str(home), snapshots=str(tmp_path / "snaps"),
              caches=[SafeCache("temp", "临时文件", (str(home / "AppCache" / "Temp"),), min_age_days=1)],
              move_targets=[str(tmp_path / "D")])
    return api, home, moved, tmp_path


def allow(api):
    api.set_consent(True)


def opened(api, path):
    assert api.open_place(str(path))["ok"]
    assert api.wait_idle()


def run(api, plan):
    assert "error" not in plan, plan
    assert api.execute(plan["id"])["started"]
    assert api.wait_idle()
    return api.state()["job"]


def test_nothing_is_read_until_a_place_is_chosen(world):
    api, home, _, _ = world
    s = api.start()
    assert s["drives"] and not s["consented"] and not s["allow_changes"]
    assert api.state()["place"] is None and not api.state()["scan"]["running"]


def test_scan_then_navigate_instantly(world):
    api, home, _, _ = world
    opened(api, home)
    st = api.state()
    assert st["place"]["root"] == str(home) and st["place"]["size"] > 300 * MB
    v = api.view(str(home))
    assert v["items"][0]["name"] == "Downloads" and v["crumbs"][-1]["name"] == "home"
    dl = api.view(str(home / "Downloads"))
    assert "tidy" in dl["tools"] and [c["name"] for c in dl["crumbs"]] == ["home", "Downloads"]
    assert "tidy" not in api.view(str(home / "Documents"))["tools"]


def test_snapshot_used_next_time_without_reading_disk(world):
    api, home, _, tmp = world
    opened(api, home)
    api2 = Api(log=api.log, prefs=api.prefs, home=api.home, snapshots=str(tmp / "snaps"))
    r = api2.open_place(str(home))
    assert r["loaded"] and not r["scanning"]
    assert api2.start()["recent"][0]["root"] == str(home)


def test_changes_are_locked_until_allowed(world):
    api, home, moved, _ = world
    opened(api, home)
    out = api.tool("dupes", str(home / "Downloads"))
    ids = [f["id"] for g in out["dupes"] for f in g["files"] if not f["keeper"]]
    assert "error" in api.plan("dupes", ids)                     # 没打开开关：连预检都不给
    assert not api.execute("whatever")["started"]
    allow(api)
    job = run(api, api.plan("dupes", ids))
    assert job["moved"] == 1 and len(moved) == 1
    assert sum(1 for n in ("a.bin", "b.bin") if (home / "Downloads" / n).exists()) == 1


def test_inspect_tool_and_recycle_updates_tree(world):
    api, home, moved, _ = world
    opened(api, home); allow(api)
    out = api.tool("inspect", str(home / "Downloads"))
    items = {i["name"]: g["lvl"] for g in out["groups"] for i in g["items"]}
    assert items["AppSetup.exe"] == "maybe" and items["photos.zip"] == "maybe"
    before = api.view(str(home / "Downloads"))["size"]
    ids = [i["id"] for g in out["groups"] if g["lvl"] == "maybe" for i in g["items"] if i["name"] == "AppSetup.exe"]
    job = run(api, api.plan("files", ids))
    assert job["moved"] == 1
    assert api.view(str(home / "Downloads"))["size"] == before - 60 * MB   # 树里的大小跟着变了


def test_right_click_recycle_uses_scan_fingerprint(world, monkeypatch):
    from core import safety
    api, home, moved, _ = world
    monkeypatch.setattr(safety, "_KEEP", safety._KEEP + [safety._norm(home / "Downloads")])  # 假的主目录
    opened(api, home); allow(api)
    f = home / "Downloads" / "movie.mkv"
    with open(f, "ab") as h:
        h.write(b"changed after scan")
    pl = api.plan("paths", [str(f)])
    assert pl["count"] == 0 and "改动过" in pl["refused"][0][1]
    assert api.plan("paths", [str(home / "Downloads")])["count"] == 0   # 个人文件夹本身不能删


def test_rename_and_undo(world):
    api, home, _, _ = world
    opened(api, home); allow(api)
    out = api.tool("rename", str(home / "Pictures"))
    assert out["renames"][0]["to"] == "2024-03-01 12.30.45.jpg" and out["renames"][0]["when"] == "name"
    job = run(api, api.plan("rename", [r["id"] for r in out["renames"]]))
    assert (home / "Pictures" / "2024-03-01 12.30.45.jpg").exists()
    assert [x["name"] for x in api.view(str(home / "Pictures"))["items"]] == ["2024-03-01 12.30.45.jpg"]
    api.undo(job["batch"]); api.wait_idle()
    assert (home / "Pictures" / "IMG_20240301_123045.jpg").exists()


def test_versions_tool(world):
    api, home, _, _ = world
    opened(api, home); allow(api)
    out = api.tool("versions", str(home / "Documents"))
    g = out["groups"][0]
    assert g["keep"] == "方案最终版.docx" and [o["name"] for o in g["older"]] == ["方案终版.docx"]
    run(api, api.plan("versions", [g["id"]]))
    assert (home / "Documents" / "旧版本" / "方案终版.docx").exists()


def test_tidy_tool(world):
    api, home, _, _ = world
    opened(api, home); allow(api)
    out = api.tool("tidy", str(home / "Downloads"))
    assert any(p["title"] == "截图和录屏" for p in out["proposals"])
    run(api, api.plan("tidy", [p["id"] for p in out["proposals"] if p["title"] == "截图和录屏"]))
    assert list((home / "Pictures" / "截图").rglob("Screenshot 2025-01-01.png"))


def test_move_to_other_drive_keeps_structure(world):
    api, home, _, tmp = world
    opened(api, home); allow(api)
    src = home / "Downloads" / "movie.mkv"
    job = run(api, api.plan("move", [str(src)], str(tmp / "D")))
    assert (tmp / "D" / "留白挪出" / "Downloads" / "movie.mkv").exists() and not src.exists()
    api.undo(job["batch"]); api.wait_idle()
    assert src.exists()


def test_caches_on_demand_and_busy_apps(world, monkeypatch):
    api, home, moved, _ = world
    from core import procs
    monkeypatch.setattr(procs, "busy_caches", lambda keys: {"temp": "某个程序"})
    out = api.caches()
    assert out["items"][0]["busy"] == "某个程序" and not out["items"][0]["default"]
    allow(api)
    pl = api.plan("caches", ["temp"])
    assert pl["count"] == 0 and "开着" in pl["refused"][0][1]


def test_scan_pause_and_cancel(world):
    api, home, _, _ = world
    api.scan_control("pause")
    api.open_place(str(home), rescan=True)
    api.scan_control("cancel")
    assert api.wait_idle(10)
    assert not api.state()["scan"]["running"]


def test_end_processes_needs_permission(world):
    api, *_ = world
    assert not api.end_processes([123456])["ok"]


def test_history_lists_batches(world):
    api, home, _, _ = world
    opened(api, home); allow(api)
    out = api.tool("rename", str(home / "Pictures"))
    run(api, api.plan("rename", [r["id"] for r in out["renames"]]))
    h = api.history()
    assert h["batches"] and h["batches"][0]["undoable"]


def test_inspect_small_folder_sees_smaller_installers(world):
    """看一个小文件夹时，几 M 的旧安装包也要能看到（不能只看 50 M 以上的）。"""
    api, home, moved, tmp = world
    small = home / "Small"
    make(small / "setup_tool.exe", 3 * MB, age_days=400)
    make(small / "notes.txt", 10, b"n")
    opened(api, small)
    out = api.tool("inspect", str(small))
    names = [i["name"] for g in out["groups"] if g["lvl"] == "maybe" for i in g["items"]]
    assert "setup_tool.exe" in names
