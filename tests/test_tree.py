import os
import threading
import time

from conftest import symlink_or_skip
from core import safety, tree

MB = 1024 * 1024


def make(p, size=1000):
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "wb") as f:
        f.truncate(size)
    return p


def test_sizes_add_up_and_view(tmp_path):
    make(tmp_path / "a" / "x.bin", 3 * MB)
    make(tmp_path / "a" / "b" / "y.bin", 2 * MB)
    make(tmp_path / "top.bin", 1 * MB)
    t = tree.scan(str(tmp_path))
    root = t.node(str(tmp_path))
    assert root.size == 6 * MB and root.files == 3
    assert t.node(str(tmp_path / "a")).size == 5 * MB
    v = tree.view(t, str(tmp_path))
    assert [(x["kind"], x["name"]) for x in v] == [("dir", "a"), ("file", "top.bin")]
    c = tree.crumbs(t, str(tmp_path / "a" / "b"))
    assert [x["name"] for x in c] == [os.path.basename(str(tmp_path)), "a", "b"]


def test_skips_protected_and_links(tmp_path, monkeypatch):
    monkeypatch.setattr(safety, "_EXTRA", [safety._norm(tmp_path / "sys")])
    make(tmp_path / "sys" / "big.dll", 5 * MB)
    make(tmp_path / "real" / "f.bin", MB)
    symlink_or_skip(tmp_path / "real", tmp_path / "link", target_is_directory=True)
    t = tree.scan(str(tmp_path))
    assert t.node(str(tmp_path / "sys")).skipped and t.node(str(tmp_path / "sys")).size == 0
    assert t.node(str(tmp_path / "link")) is None
    assert t.node(str(tmp_path)).size == MB


def test_cancel_and_pause(tmp_path):
    for i in range(30):
        make(tmp_path / f"d{i}" / "f.bin")
    cancel = threading.Event(); cancel.set()
    assert not tree.scan(str(tmp_path), cancel=cancel).complete
    running = threading.Event()                     # 一开始是暂停的
    out = {}
    th = threading.Thread(target=lambda: out.setdefault("t", tree.scan(str(tmp_path), running=running)))
    th.start(); time.sleep(0.2)
    assert th.is_alive()                            # 暂停中，没有扫完
    running.set(); th.join(5)
    assert out["t"].node(str(tmp_path)).files == 30


def test_snapshot_roundtrip(tmp_path):
    make(tmp_path / "data" / "a" / "x.bin", MB)
    t = tree.scan(str(tmp_path / "data"))
    tree.save(t, tmp_path / "snaps")
    t2 = tree.load(str(tmp_path / "data"), tmp_path / "snaps")
    assert t2.node(str(tmp_path / "data")).size == MB
    assert tree.view(t2, str(tmp_path / "data")) == tree.view(t, str(tmp_path / "data"))
    known = tree.known_snapshots(tmp_path / "snaps")
    assert known[0]["root"] == str(tmp_path / "data") and known[0]["size"] == MB


def test_regraft_updates_sizes_upwards(tmp_path):
    make(tmp_path / "a" / "b" / "x.bin", 4 * MB)
    make(tmp_path / "a" / "y.bin", 1 * MB)
    t = tree.scan(str(tmp_path))
    (tmp_path / "a" / "b" / "x.bin").unlink()
    make(tmp_path / "a" / "b" / "new.bin", 2 * MB)
    tree.regraft(t, str(tmp_path / "a" / "b"))
    assert t.node(str(tmp_path / "a" / "b")).size == 2 * MB
    assert t.node(str(tmp_path / "a")).size == 3 * MB
    assert t.node(str(tmp_path)).size == 3 * MB
    assert [x["name"] for x in tree.view(t, str(tmp_path / "a" / "b"))] == ["new.bin"]
