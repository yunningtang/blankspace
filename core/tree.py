"""扫描用户选的一个地方（某个盘或某个文件夹），一次走完，得到一棵“文件夹大小树”。只读。

- 只在用户选了地方、点了开始以后才扫，绝不自动扫。
- 走一遍就够：往下钻、往上退都直接用这棵树，不再读硬盘。
- 在 Windows 上用“后台模式”运行：CPU 和硬盘读写优先级都降低，不拖慢电脑；可以暂停、可以取消。
- 系统目录（Windows、Program Files 等）不进去，只记“没有细看”；整盘的用量减去看过的部分，就是系统和没权限的地方。
- 扫完存一份快照，下次打开直接显示上次的结果，用户想更新再重新扫。
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import shutil
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .fs import is_cloud_placeholder, is_link_or_junction
from .safety import is_hard_protected

TOP_FILES = 12          # 每个文件夹记住最大的几个文件


@dataclass
class Node:
    path: str
    name: str
    parent: str | None = None
    size: int = 0                       # 里面所有东西的总大小
    files: int = 0                      # 里面文件总数
    own: int = 0                        # 直接放在这里的文件的大小
    own_files: int = 0
    dirs: list[str] = field(default_factory=list)
    top: list[tuple[str, int, float]] = field(default_factory=list)   # (文件名, 大小, 修改时间)
    newest: float = 0.0                 # 里面最新的修改时间
    skipped: str = ""                   # 没进去看的原因


@dataclass
class Tree:
    root: str
    nodes: dict[str, Node] = field(default_factory=dict)
    scanned_at: float = 0.0
    seconds: float = 0.0
    total: int = 0                      # 盘的总大小（选的是整个盘时）
    used: int = 0
    free: int = 0
    complete: bool = True

    def node(self, path: str) -> Node | None:
        return self.nodes.get(key(path))


def key(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def is_drive_root(path: str) -> bool:
    p = os.path.abspath(path)
    return os.path.dirname(p) == p


# ---------------------------------------------------------------- 后台模式（Windows）

class _Background:
    """让当前线程以后台优先级运行：CPU 和磁盘 I/O 都让着别的程序。"""
    def __enter__(self):
        self.on = False
        if sys.platform == "win32":
            try:
                import ctypes
                k = ctypes.windll.kernel32
                self.on = bool(k.SetThreadPriority(k.GetCurrentThread(), 0x00010000))  # THREAD_MODE_BACKGROUND_BEGIN
            except Exception:
                pass
        return self

    def __exit__(self, *a):
        if self.on:
            try:
                import ctypes
                k = ctypes.windll.kernel32
                k.SetThreadPriority(k.GetCurrentThread(), 0x00020000)                   # THREAD_MODE_BACKGROUND_END
            except Exception:
                pass


# ---------------------------------------------------------------- 扫描

def scan(root: str, cancel: threading.Event | None = None, running: threading.Event | None = None,
         on_progress: Callable[[int, str], None] | None = None, every: float = 0.2) -> Tree:
    """running 是“没暂停”的开关：清掉它就暂停，设上就继续。"""
    t0 = time.monotonic()
    root = os.path.abspath(root)
    tree = Tree(root)
    if is_drive_root(root):
        try:
            u = shutil.disk_usage(root)
            tree.total, tree.used, tree.free = u.total, u.used, u.free
        except OSError:
            pass
    order: list[Node] = []
    stack = [Node(root, os.path.basename(root.rstrip("\\/")) or root)]
    count, last = 0, time.monotonic()
    with _Background():
        while stack:
            if cancel is not None and cancel.is_set():
                tree.complete = False
                break
            if running is not None and not running.is_set():
                running.wait()
            n = stack.pop()
            tree.nodes[key(n.path)] = n
            order.append(n)
            if n.path != root and is_hard_protected(n.path):
                n.skipped = "系统文件，没有细看"
                continue
            try:
                entries = list(os.scandir(n.path))
            except PermissionError:
                n.skipped = "没有权限查看"
                continue
            except OSError:
                n.skipped = "打不开"
                continue
            tops: list[tuple[str, int, float]] = []
            for e in entries:
                try:
                    if is_link_or_junction(e):
                        continue
                    if e.is_dir(follow_symlinks=False):
                        child = Node(e.path, e.name, parent=key(n.path))
                        n.dirs.append(key(e.path))
                        stack.append(child)
                        continue
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                size = 0 if is_cloud_placeholder(st) else st.st_size
                n.own += size
                n.own_files += 1
                n.newest = max(n.newest, st.st_mtime)
                tops.append((e.name, size, st.st_mtime))
                count += 1
            tops.sort(key=lambda x: -x[1])
            n.top = tops[:TOP_FILES]
            now = time.monotonic()
            if on_progress and now - last >= every:
                last = now
                on_progress(count, n.path)
    # 从下往上把大小加起来
    for n in reversed(order):
        n.size += n.own
        n.files += n.own_files
        if n.parent and n.parent in tree.nodes:
            p = tree.nodes[n.parent]
            p.size += n.size
            p.files += n.files
            p.newest = max(p.newest, n.newest)
    # 被取消时，还没扫到的子文件夹不留空壳
    for n in order:
        n.dirs = [d for d in n.dirs if d in tree.nodes]
    tree.scanned_at = time.time()
    tree.seconds = time.monotonic() - t0
    if on_progress:
        on_progress(count, "")
    return tree


# ---------------------------------------------------------------- 局部更新

def regraft(tree: Tree, path: str) -> None:
    """重新扫这一个文件夹，换掉树里的旧数据，并把大小的变化往上传。清理或移动以后用，不用整盘重扫。"""
    k = key(path)
    while k not in tree.nodes:                     # 找到树里已有的、最近的上级
        parent = key(os.path.dirname(k))
        if parent == k:
            return
        k = parent
    old = tree.nodes[k]
    if not os.path.isdir(old.path):
        return regraft(tree, os.path.dirname(old.path)) if old.parent else None
    sub = scan(old.path)
    new_root = sub.nodes[key(old.path)]
    new_root.parent, new_root.name = old.parent, old.name
    ds, df = new_root.size - old.size, new_root.files - old.files
    # 删掉旧的子树
    stack = [k]
    while stack:
        n = tree.nodes.pop(stack.pop(), None)
        if n:
            stack.extend(n.dirs)
    tree.nodes.update(sub.nodes)
    # 往上传
    p = new_root.parent
    while p and p in tree.nodes:
        a_ = tree.nodes[p]
        a_.size += ds
        a_.files += df
        p = a_.parent
    if is_drive_root(tree.root):
        try:
            u = shutil.disk_usage(tree.root)
            tree.used, tree.free = u.used, u.free
        except OSError:
            pass


# ---------------------------------------------------------------- 给画面用：某个文件夹里的块

def view(tree: Tree, path: str, limit: int = 28) -> list[dict]:
    """当前文件夹里的块：子文件夹、大文件、其余小文件；整盘时再加上“系统和没权限的地方”。"""
    n = tree.node(path)
    if n is None:
        return []
    items = []
    for d in n.dirs:
        c = tree.nodes[d]
        items.append({"kind": "dir", "name": c.name, "path": c.path, "size": c.size, "files": c.files,
                      "skipped": c.skipped, "newest": c.newest})
    shown = 0
    for name, size, mtime in n.top:
        if size <= 0 or (n.size and size < n.size * 0.01 and len(items) >= 8):
            continue
        items.append({"kind": "file", "name": name, "path": os.path.join(n.path, name), "size": size,
                      "files": 1, "newest": mtime})
        shown += size
    items.sort(key=lambda x: -x["size"])
    rest = items[limit:]
    items = items[:limit]
    rest_size = sum(x["size"] for x in rest) + max(0, n.own - shown)
    rest_count = sum(x["files"] for x in rest) + (n.own_files - sum(1 for x in items if x["kind"] == "file"))
    if rest_size > 0:
        items.append({"kind": "rest", "name": "其余的小文件", "path": n.path, "size": rest_size,
                      "files": rest_count, "newest": 0})
    if key(path) == key(tree.root) and is_drive_root(tree.root) and tree.used:
        other = tree.used - n.size
        if other > 0:
            items.append({"kind": "system", "name": "系统和没权限的地方", "path": tree.root, "size": other,
                          "files": 0, "newest": 0})
    return items


def crumbs(tree: Tree, path: str) -> list[dict]:
    """从扫描的根到当前位置，每一层都能点回去。"""
    out = []
    k = key(path)
    while k in tree.nodes:
        n = tree.nodes[k]
        out.append({"name": n.name, "path": n.path, "size": n.size})
        if not n.parent:
            break
        k = n.parent
    return list(reversed(out))


# ---------------------------------------------------------------- 快照

def snapshot_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".cache")
    return Path(base) / "Liubai" / "snapshots"


def _snap_file(root: str, folder: Path | None = None) -> Path:
    h = hashlib.sha1(key(root).encode("utf-8")).hexdigest()[:16]
    return (folder or snapshot_dir()) / f"{h}.json.gz"


def save(tree: Tree, folder: Path | None = None) -> None:
    """存一份快照（压缩的 JSON）。失败不影响使用。"""
    try:
        f = _snap_file(tree.root, folder)
        f.parent.mkdir(parents=True, exist_ok=True)
        data = {"v": 1, "root": tree.root, "at": tree.scanned_at, "s": tree.seconds, "total": tree.total,
                "used": tree.used, "free": tree.free, "complete": tree.complete,
                "n": [[n.path, n.name, n.parent, n.size, n.files, n.own, n.own_files, n.dirs, n.top, n.newest, n.skipped]
                      for n in tree.nodes.values()]}
        tmp = f.with_suffix(".tmp")
        with gzip.open(tmp, "wt", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, f)
        _update_index(tree, folder)
    except OSError:
        pass


def load(root: str, folder: Path | None = None) -> Tree | None:
    try:
        with gzip.open(_snap_file(root, folder), "rt", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if data.get("v") != 1:
        return None
    t = Tree(data["root"], scanned_at=data["at"], seconds=data["s"], total=data["total"], used=data["used"],
             free=data["free"], complete=data["complete"])
    for p, name, parent, size, files, own, own_files, dirs, top, newest, skipped in data["n"]:
        t.nodes[key(p)] = Node(p, name, parent, size, files, own, own_files, dirs, [tuple(x) for x in top], newest, skipped)
    return t


def _index_file(folder: Path | None = None) -> Path:
    return (folder or snapshot_dir()) / "index.json"


def _update_index(tree: Tree, folder: Path | None = None) -> None:
    f = _index_file(folder)
    try:
        idx = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        idx = {}
    root_node = tree.node(tree.root)
    idx[key(tree.root)] = {"root": tree.root, "at": tree.scanned_at, "size": root_node.size if root_node else 0,
                           "complete": tree.complete}
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(idx, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, f)


def known_snapshots(folder: Path | None = None) -> list[dict]:
    """上次看过的地方：只读一个小小的索引文件，打开时不慢。"""
    try:
        idx = json.loads(_index_file(folder).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return sorted(idx.values(), key=lambda x: -x["at"])
