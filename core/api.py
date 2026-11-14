"""界面和后端之间唯一的接口。界面通过 main.Bridge（pywebview）或 devserver 调用；这里不依赖 pywebview，可以直接测试。

原则：
- 打开时什么都不扫。用户选了一个盘或文件夹、点了开始，才去读（或者从右键菜单带进来一个文件夹）。
  看过的地方有快照，下次直接显示上次的结果，想更新再重新扫。
- 扫描在后台、低优先级运行，可以暂停、取消；关窗口就停。
- 只读的事（看、找重复、找命名问题）随时可以做；动文件的事（移到回收站、移动、改名、结束程序）
  必须先在设置里打开“允许留白整理和清理文件”，并且每一次都要：只读预检 plan → 用户确认 → execute 逐项再查。
- 返回给界面的都是能转成 JSON 的普通数据。
"""
from __future__ import annotations

import os
import subprocess
import threading
import time
import uuid
from pathlib import Path

from . import cleanables, cleaner, dupes, inspect as insp, mover, naming, places, procs, recycle, tidy, tree, winshell
from .cleaner import Entry
from .oplog import OpLog
from .prefs import Prefs

LOCKED = "要先在设置里打开“允许留白整理和清理文件”。关着的时候，留白只看，不动任何文件。"


def _under(path: str, folder: str) -> bool:
    a, b = os.path.normcase(os.path.abspath(path)), os.path.normcase(os.path.abspath(folder))
    return a == b or a.startswith(b.rstrip(os.sep) + os.sep)


class Api:
    def __init__(self, log: OpLog | None = None, prefs: Prefs | None = None, home: str | None = None,
                 snapshots: str | None = None, caches=None, move_targets: list[str] | None = None,
                 start_path: str | None = None):
        self.log = log or OpLog()
        self.prefs = prefs or Prefs()
        self.home = home or str(Path.home())
        self._snaps = Path(snapshots) if snapshots else None
        self._caches_defs = caches                 # 测试时可以换成假的
        self._move_targets = move_targets
        self.start_path = start_path               # 从资源管理器右键带进来的文件夹
        self._lock = threading.RLock()
        self._cancel = threading.Event()
        self._running = threading.Event()
        self._running.set()
        self._scan_thread: threading.Thread | None = None
        self._job_thread: threading.Thread | None = None
        self._version = 0
        self._tree: tree.Tree | None = None
        self._scan = {"running": False, "paused": False, "count": 0, "current": "", "root": ""}
        self._error = ""
        self._cleanables: list[cleanables.Cleanable] = []
        self._busy: dict[str, str] = {}
        self._inspections: dict[str, insp.Inspection] = {}   # 文件夹 → 建议
        self._dupes: list[dupes.DupeGroup] = []
        self._tidy: list[tidy.Proposal] = []
        self._renames: dict[str, naming.Rename] = {}
        self._versions: list[naming.VersionGroup] = []
        self._plans: dict[str, tuple] = {}
        self._job: dict | None = None
        self._n = 0

    def _bump(self):
        self._version += 1

    # ================================================================ 开始
    def start(self) -> dict:
        """打开时调用。很快：只问系统有哪些盘、读上次看过的列表，不扫任何文件。"""
        return {"consented": self.prefs.consented, "allow_changes": self.prefs.allow_changes,
                "drives": places.drives(), "folders": places.folders(self.home),
                "recent": tree.known_snapshots(self._snaps)[:6], "start_path": self.start_path,
                "home": self.home}

    def set_consent(self, allow_changes: bool) -> dict:
        self.prefs.consented = True
        self.prefs.allow_changes = bool(allow_changes)
        self.prefs.save()
        return {"allow_changes": self.prefs.allow_changes}

    def set_allow_changes(self, on: bool) -> dict:
        self.prefs.allow_changes = bool(on)
        self.prefs.save()
        with self._lock:
            self._bump()
        return {"allow_changes": self.prefs.allow_changes}

    # ================================================================ 扫描一个地方
    def open_place(self, path: str, rescan: bool = False) -> dict:
        """打开一个盘或文件夹。有上次的快照就先显示快照（不读硬盘）；rescan=True 才重新扫。"""
        path = os.path.abspath(path)
        if not os.path.isdir(path):
            return {"ok": False, "why": "找不到这个文件夹"}
        with self._lock:
            if self._scan_thread and self._scan_thread.is_alive():
                return {"ok": False, "why": "正在扫描别的地方，先等它完成或者取消"}
            self._error = ""
            self._inspections.clear()
            self._dupes, self._tidy, self._renames, self._versions = [], [], {}, []
            if not rescan:
                snap = tree.load(path, self._snaps)
                if snap is not None:
                    self._tree = snap
                    self._bump()
                    return {"ok": True, "loaded": True, "scanning": False}
            self._tree = None
            self._cancel.clear()
            self._running.set()
            self._scan = {"running": True, "paused": False, "count": 0, "current": "", "root": path}
            self._scan_thread = threading.Thread(target=self._scan_work, args=(path,), daemon=True)
            self._scan_thread.start()
            self._bump()
            return {"ok": True, "loaded": False, "scanning": True}

    def _scan_work(self, path: str):
        def prog(count, current):
            with self._lock:
                self._scan["count"], self._scan["current"] = count, current
                self._bump()
        try:
            t = tree.scan(path, self._cancel, self._running, prog)
            if t.complete:
                tree.save(t, self._snaps)
            with self._lock:
                self._tree = t
        except Exception as e:  # noqa: BLE001 - 扫描出错要告诉用户，不能悄悄停住
            with self._lock:
                self._error = f"扫描出错：{e}"
        with self._lock:
            self._scan["running"] = False
            self._scan["paused"] = False
            self._bump()

    def scan_control(self, action: str) -> dict:
        """暂停 / 继续 / 取消正在进行的扫描。"""
        if action == "pause":
            self._running.clear()
        elif action == "resume":
            self._running.set()
        elif action == "cancel":
            self._cancel.set()
            self._running.set()
        with self._lock:
            self._scan["paused"] = not self._running.is_set()
            self._bump()
        return {"ok": True}

    def cancel(self) -> dict:
        return self.scan_control("cancel")

    def close_place(self) -> dict:
        with self._lock:
            self._tree = None
            self._bump()
        return {"ok": True}

    # ================================================================ 状态（界面轮询）
    def state(self) -> dict:
        with self._lock:
            t = self._tree
            place = None
            if t is not None:
                rn = t.node(t.root)
                place = {"root": t.root, "name": rn.name if rn else t.root, "size": rn.size if rn else 0,
                         "files": rn.files if rn else 0, "at": t.scanned_at, "seconds": round(t.seconds, 1),
                         "complete": t.complete, "total": t.total, "used": t.used, "free": t.free,
                         "drive": tree.is_drive_root(t.root)}
            return {"version": self._version, "scan": dict(self._scan), "place": place, "error": self._error,
                    "job": dict(self._job) if self._job else None, "allow_changes": self.prefs.allow_changes,
                    "bin": recycle.bin_used(self._tree.root) if (self._tree and os.name == "nt") else 0}

    # ================================================================ 往里走
    def view(self, path: str) -> dict:
        """某个文件夹里的块。直接用扫描得到的树，瞬间返回。"""
        t = self._tree
        if t is None:
            return {"ok": False}
        n = t.node(path)
        if n is None:
            return {"ok": False, "why": "这个文件夹不在这次扫描的范围里"}
        tone = insp.tone_for(n.path, self.home)
        tools = ["inspect", "dupes", "rename", "versions"]
        if any(tree.key(n.path) == tree.key(os.path.join(self.home, d)) for d in ("Downloads", "Desktop")):
            tools.insert(1, "tidy")        # 整理只对“下载”和“桌面”本身有意义
        return {"ok": True, "path": n.path, "name": n.name, "size": n.size, "files": n.files,
                "skipped": n.skipped, "crumbs": tree.crumbs(t, n.path), "items": tree.view(t, n.path),
                "tone": tone, "tools": tools, "is_root": tree.key(n.path) == tree.key(t.root)}

    # ================================================================ 工具（都是只读的分析）
    def tool(self, kind: str, path: str) -> dict:
        """在某个文件夹里做一次分析。可能要几秒到几分钟（找重复文件要读文件内容）。"""
        if not os.path.isdir(path):
            return {"ok": False, "why": "找不到这个文件夹"}
        self._cancel.clear()
        if kind == "inspect":
            return self._tool_inspect(path)
        if kind == "dupes":
            groups = dupes.find([(os.path.basename(path) or path, path)], cancel=self._cancel)
            with self._lock:
                self._dupes = groups
            return {"ok": True, "kind": "dupes", "path": path, "size": sum(g.wasted for g in groups),
                    "dupes": [{"id": g.id, "size": g.size, "name": os.path.basename(g.keeper),
                               "files": [{"id": f.id, "path": f.path, "name": os.path.basename(f.path),
                                          "where": f.where, "keeper": f.path == g.keeper} for f in g.files]}
                              for g in groups]}
        if kind == "tidy":
            h = Path(self.home)
            where = "downloads" if _under(path, str(h / "Downloads")) else "desktop"
            props = tidy.propose(where, path, str(h / "Pictures"), str(h / "Videos"))
            with self._lock:
                self._tidy = props
            return {"ok": True, "kind": "tidy", "path": path,
                    "proposals": [{"id": p.id, "title": p.title, "how": p.how, "count": p.count, "size": p.size,
                                   "samples": p.samples} for p in props]}
        if kind == "rename":
            rs = naming.propose_renames(path)
            with self._lock:
                self._renames = {f"rn:{i}": r for i, r in enumerate(rs)}
            how = {"exif": "照片里记录的拍摄时间", "name": "文件名里的日期", "mtime": "文件的修改时间（不太准）"}
            return {"ok": True, "kind": "rename", "path": path,
                    "renames": [{"id": k, "from": os.path.basename(r.src), "to": os.path.basename(r.dst),
                                 "where": os.path.relpath(os.path.dirname(r.src), path) if os.path.dirname(r.src) != path else "",
                                 "when": r.when, "how": how[r.when]} for k, r in self._renames.items()]}
        if kind == "versions":
            gs = naming.propose_versions(path)
            with self._lock:
                self._versions = gs
            return {"ok": True, "kind": "versions", "path": path,
                    "groups": [{"id": g.id, "title": g.title, "keep": os.path.basename(g.keep),
                                "older": [{"name": os.path.basename(p), "mtime": g.mtimes[p], "size": g.sizes[p]}
                                          for p in g.older]} for g in gs]}
        return {"ok": False, "why": "不认识的工具"}

    def _tool_inspect(self, path: str) -> dict:
        skip = frozenset(p for cl in self._cleanables for p, _ in cl.items)
        self._n += 1
        ins = insp.inspect(f"i{self._n}", [path], self._cancel, keep=frozenset(self.prefs.keep), skip=skip,
                           tone=insp.tone_for(path, self.home), min_file=self._min_file(path))
        with self._lock:
            self._inspections[os.path.normcase(path)] = ins
        return self._inspect_payload(path, ins)

    def _min_file(self, path: str) -> int:
        """逐个看的文件下限：这个地方大小的 1%，在 1 M 到 50 M 之间。"""
        size = 0
        with self._lock:
            t = self._tree
        if t is not None:
            node = t.node(path)
            size = node.size if node else 0
        if not size:
            return insp.MIN_FILE
        return max(1024 * 1024, min(insp.MIN_FILE, size // 100))

    def _inspect_payload(self, path, ins) -> dict:
        titles = {"maybe": "可能不再需要", "mine": "你的文件", "keep": "最近还在用", "lock": "留白不会动"}
        groups = []
        for lvl in ("maybe", "mine", "keep", "lock"):
            items = [s for s in ins.items if s.lvl == lvl]
            if items:
                groups.append({"lvl": lvl, "title": titles[lvl], "size": sum(s.size for s in items),
                               "items": [{"id": s.id, "name": s.name, "path": s.path, "size": s.size,
                                          "why": s.why, "then": s.then, "dir": s.is_dir} for s in items]})
        return {"ok": True, "kind": "inspect", "path": path, "maybe": ins.maybe_size, "groups": groups,
                "rest": {"count": ins.rest_count, "size": ins.rest_size}}

    def set_keep(self, item_id: str, on: bool = True) -> dict:
        s = self._find_suggestion(item_id)
        if not s:
            return {"ok": False}
        self.prefs.set_keep(s.path, on)
        if on:
            s.lvl, s.why, s.then = "keep", "你说过留着。", ""
        return {"ok": True}

    def set_keeper(self, group_id: str, file_id: str) -> dict:
        for g in self._dupes:
            if g.id == group_id:
                f = next((f for f in g.files if f.id == file_id), None)
                if f:
                    g.keeper = f.path
                    return {"ok": True}
        return {"ok": False}

    def _find_suggestion(self, item_id: str):
        for ins in self._inspections.values():
            for s in ins.items:
                if s.id == item_id:
                    return s
        return None

    # ================================================================ 系统和软件缓存（按需）
    def caches(self) -> dict:
        found = cleanables.find_all(self._caches_defs, cancel=self._cancel)
        busy = procs.busy_caches([c.key for c in found])
        with self._lock:
            self._cleanables, self._busy = found, busy
        return {"ok": True, "items": [{"key": c.key, "name": c.name, "size": c.size, "count": len(c.items),
                                       "default": c.default and c.key not in busy, "note": c.cache.note if c.cache else "",
                                       "cost": c.cache.cost if c.cache else "", "group": c.cache.group if c.cache else "",
                                       "busy": busy.get(c.key, "")} for c in found if c.size > 0]}

    # ================================================================ 正在运行的程序
    def processes(self) -> dict:
        return procs.snapshot()

    def end_processes(self, pids: list[int]) -> dict:
        if not self.prefs.allow_changes:
            return {"ok": False, "why": LOCKED}
        return {"ok": True, **procs.end([int(p) for p in pids])}

    # ================================================================ 预检（只读）
    def drives(self, exclude: str | None = None) -> list[dict]:
        """可以“挪过去”的别的盘。"""
        if self._move_targets is not None:
            ds = [{"path": r, "name": os.path.basename(r.rstrip(os.sep)) or r, "free": 0, "removable": False}
                  for r in self._move_targets]
        else:
            ds = [d for d in places.drives() if not d["system"]]
        if exclude:
            ds = [d for d in ds if not _under(exclude, d["path"])]
        return ds

    def plan(self, kind: str, ids: list[str], target: str | None = None) -> dict:
        """只读预检，什么都不动。
        移到回收站：caches 缓存 / files 建议里的文件 / dupes 重复的副本 / paths 右键选的文件或文件夹；
        移动（可撤销）：move 挪到别的盘（ids 是路径或建议 id）/ tidy 整理 / rename 改名 / versions 收起旧版本。"""
        if not self.prefs.allow_changes:
            return {"error": LOCKED}
        then: list[str] = []
        if kind == "caches":
            sel = [c for c in self._cleanables if c.key in set(ids)]
            busy = [c for c in sel if c.key in self._busy]
            sel = [c for c in sel if c.key not in self._busy]
            pl = cleanables.plan(sel)
            pl.refused = [(c.name, f"{self._busy[c.key]}开着，现在清不掉。先关掉它再清") for c in busy] + pl.refused
            then = sorted({c.cache.cost for c in sel if c.cache and c.cache.cost})
        elif kind == "files":
            sugs = [s for s in (self._find_suggestion(i) for i in ids) if s and s.lvl == "maybe"]
            chosen = {s.path for s in sugs}
            twins = [(s.path, "它的另一份也在这次要移走的里面，至少留一份") for s in sugs if s.twin_of in chosen]
            sugs = [s for s in sugs if s.twin_of not in chosen]
            pl = cleaner.preflight([Entry(s.path, s.size, s.stamp) for s in sugs])
            pl.refused = twins + pl.refused
            then = sorted({s.then for s in sugs if s.then})
        elif kind == "dupes":
            want, refused, entries = set(ids), [], []
            for g in self._dupes:
                for f in g.files:
                    if f.id not in want:
                        continue
                    if f.path == g.keeper:
                        refused.append((f.path, "这是这一组留下的那份，不移"))
                    elif not os.path.exists(g.keeper):
                        refused.append((f.path, "留下的那份已经不在了，这一份也先不动"))
                    else:
                        entries.append(Entry(f.path, f.size, f.stamp))
            pl = cleaner.preflight(entries)
            pl.refused = refused + pl.refused
            then = ["每一组都留下一份，内容一模一样。"]
        elif kind == "paths":
            entries = [Entry(p, *self._scanned(p)) for p in ids]
            pl = cleaner.preflight(entries)
        elif kind in ("move", "tidy", "rename", "versions"):
            return self._plan_moves(kind, ids, target)
        else:
            return {"error": "不认识的操作"}
        return self._keep_plan("recycle", pl, then)

    def _scanned(self, path: str) -> tuple[int, tuple | None]:
        """扫描时看到的 (大小, 指纹)。文件用扫描时的大小和修改时间做指纹：之后变了就不动它。"""
        t = self._tree
        if t is None:
            return 0, None
        n = t.node(path)
        if n is not None:
            return n.size, None                     # 文件夹：不用指纹（里面随时可能变）
        parent = t.node(os.path.dirname(path))
        if parent:
            for name, size, mtime in parent.top:
                if os.path.normcase(name) == os.path.normcase(os.path.basename(path)):
                    return size, (size, mtime)
        return 0, None

    def _keep_plan(self, typ, pl, then, label="") -> dict:
        pid = uuid.uuid4().hex[:12]
        with self._lock:
            self._plans = {pid: (typ, pl)}           # 只保留最新的一份，旧的确认作废
        return {"id": pid, "type": typ, "label": label, "count": len(pl.go), "total": pl.total,
                "refused": [[p, why] for p, why in pl.refused[:20]], "refused_count": len(pl.refused),
                "warnings": pl.warnings, "then": then}

    def _plan_moves(self, kind: str, ids: list[str], target: str | None) -> dict:
        pairs, sizes, stamps, then = [], {}, {}, []
        if kind == "tidy":
            for p in (p for p in self._tidy if p.id in set(ids)):
                pairs += p.moves
                sizes.update(p.sizes)
                stamps.update(p.stamps)
                then.append(f"{p.title}：{p.how}。")
            label = "整理"
        elif kind == "rename":
            for i in ids:
                r = self._renames.get(i)
                if r:
                    pairs.append((r.src, r.dst))
                    stamps[r.src] = r.stamp
            then.append("只改名字，不改内容，不换文件夹。同一秒拍的会在后面加 (2)。")
            label = "改名"
        elif kind == "versions":
            for g in (g for g in self._versions if g.id in set(ids)):
                pairs += naming.version_moves(g)
                sizes.update(g.sizes)
            then.append("每组最新的那份留在原处，其余的收进同一个文件夹里的“旧版本”。")
            label = "收起旧版本"
        else:
            ds = {d["path"]: d for d in self.drives()}
            if target not in ds:
                return {"error": "找不到要挪去的盘"}
            base = os.path.join(target, "留白挪出")
            for i in ids:
                s = self._find_suggestion(i)
                src = s.path if s else i
                if not os.path.lexists(src):
                    continue
                # 保留从主目录（或盘根）往下的路径，挪回来时一目了然
                anchor = self.home if _under(src, self.home) else os.path.splitdrive(src)[0] + os.sep
                rel = os.path.relpath(src, anchor)
                pairs.append((src, os.path.join(base, rel)))
                if s:
                    sizes[src], stamps[src] = s.size, s.stamp
                elif self._tree and self._tree.node(src):
                    sizes[src] = self._tree.node(src).size
            then.append(f"挪到 {ds[target]['name']}的“留白挪出”文件夹，保留原来的文件夹结构。")
            if ds[target].get("removable"):
                then.append("这是移动硬盘，拔掉以后就看不到这些文件了。")
            label = "挪走"
        pl = mover.plan_moves(pairs, sizes, stamps, label="move")
        return self._keep_plan("move", pl, then, label)

    # ================================================================ 执行（动文件）
    def execute(self, plan_id: str) -> dict:
        if not self.prefs.allow_changes:
            return {"started": False, "why": LOCKED}
        with self._lock:
            item = self._plans.pop(plan_id, None)
            if item is None:
                return {"started": False, "why": "这次确认已经过期，请重新点一次"}
            if self._job and self._job.get("running"):
                return {"started": False, "why": "上一批还没做完"}
            if self._scan_thread and self._scan_thread.is_alive():
                return {"started": False, "why": "正在扫描，扫描完再做"}
            typ, pl = item
            self._job = {"kind": typ, "running": True, "index": 0, "count": len(pl.go), "total": pl.total,
                         "moved": 0, "trashed": 0, "failed": [], "done": False, "batch": ""}
            work = self._recycle_work if typ == "recycle" else self._move_work
            self._job_thread = threading.Thread(target=work, args=(pl,), daemon=True)
            self._job_thread.start()
            return {"started": True}

    def undo(self, batch: str) -> dict:
        """把一批移动原样挪回去。原处已经有新文件的那一项不挪，不会覆盖任何东西。"""
        if not self.prefs.allow_changes:
            return {"started": False, "why": LOCKED}
        with self._lock:
            if self._job and self._job.get("running"):
                return {"started": False, "why": "上一批还没做完"}
            pl = mover.plan_undo(self.log, batch)
            if not pl.go:
                return {"started": False, "why": (pl.refused[0][1] if pl.refused else "这一批已经撤销过了")}
            self._job = {"kind": "undo", "running": True, "index": 0, "count": len(pl.go), "total": pl.total,
                         "moved": 0, "trashed": 0, "failed": [], "done": False, "batch": batch}
            self._job_thread = threading.Thread(target=self._undo_work, args=(pl, batch), daemon=True)
            self._job_thread.start()
            return {"started": True}

    def _on_item(self, i, path):
        with self._lock:
            self._job["index"] = i
            self._bump()

    def _recycle_work(self, pl: cleaner.Plan):
        rep = cleaner.execute(pl, log=self.log, on_item=self._on_item)
        moved = set(rep.moved)
        self._refresh([p for p in rep.moved])
        with self._lock:
            for c in self._cleanables:
                c.items = [(p, s) for p, s in c.items if p not in moved]
            for ins in self._inspections.values():
                ins.items = [s for s in ins.items if s.path not in moved]
            for g in self._dupes:
                g.files = [f for f in g.files if f.path not in moved]
            self._dupes = [g for g in self._dupes if len(g.files) > 1]
            self._job.update(running=False, done=True, moved=len(rep.moved), trashed=rep.trashed,
                             failed=[[p, why] for p, why in (pl.refused + rep.failed)][:50],
                             log_unsaved=len(self.log.unsaved))
            self._bump()

    def _move_work(self, pl):
        rep = mover.execute_moves(pl, self.log, on_item=self._on_item)
        self._after_moves(rep, pl)

    def _undo_work(self, pl, batch):
        rep = mover.execute_undo(pl, batch, self.log, on_item=self._on_item)
        self._after_moves(rep, pl)

    def _after_moves(self, rep: mover.MoveReport, pl: mover.MovePlan):
        gone = {src for src, _ in rep.moved}
        self._refresh([p for pair in rep.moved for p in pair])
        with self._lock:
            for ins in self._inspections.values():
                ins.items = [s for s in ins.items if s.path not in gone]
            self._job.update(running=False, done=True, moved=len(rep.moved), trashed=rep.size,
                             failed=[[p, why] for p, why in (list(pl.refused) + rep.failed)][:50],
                             batch=rep.batch, log_unsaved=len(self.log.unsaved),
                             undoable=bool(rep.moved) and self._job.get("kind") != "undo")
            self._bump()

    def _refresh(self, paths: list[str]):
        """动过的文件所在的文件夹，在树里重新读一下（只读这几个文件夹，不整盘重扫）。"""
        t = self._tree
        if t is None:
            return
        folders = sorted({os.path.dirname(p) for p in paths if _under(p, t.root)}, key=len)
        done: list[str] = []
        for f in folders:
            if any(_under(f, d) for d in done):
                continue
            try:
                tree.regraft(t, f)
            except OSError:
                continue
            done.append(f)
        if done and t.complete:
            tree.save(t, self._snaps)

    def clear_job(self) -> dict:
        with self._lock:
            if self._job and not self._job.get("running"):
                self._job = None
                self._bump()
        return {"ok": True}

    def history(self, limit: int = 300) -> dict:
        """最近的记录，新的在前；另外列出最近几批移动，能撤销的标出来。"""
        recs = self.log.read_all()
        batches: dict[str, dict] = {}
        for r in recs:
            b = r.get("batch")
            if b and r.get("action") == "move" and r.get("ok"):
                x = batches.setdefault(b, {"batch": b, "time": r.get("time"), "count": 0, "size": 0})
                x["count"] += 1
                x["size"] += r.get("size") or 0
        recent = sorted(batches.values(), key=lambda x: x["time"] or "", reverse=True)[:10]
        for x in recent:
            x["undoable"] = mover.undoable(self.log, x["batch"])
        return {"records": list(reversed(recs[-limit:])), "batches": recent}

    # ================================================================ 打开系统窗口（只是打开，不改任何东西）
    def reveal(self, path: str) -> dict:
        return {"ok": winshell.reveal(path)}

    def open_folder(self, path: str) -> dict:
        return {"ok": winshell.open_folder(path)}

    def open_file(self, path: str) -> dict:
        return {"ok": winshell.open_file(path)}

    def open_recycle_bin(self) -> dict:
        if os.name == "nt":
            subprocess.Popen(["explorer", "shell:RecycleBinFolder"])
        return {"ok": os.name == "nt"}

    def open_storage_settings(self) -> dict:
        if os.name == "nt":
            os.startfile("ms-settings:storagesense")  # noqa: S606
        return {"ok": os.name == "nt"}

    def wait_idle(self, timeout: float = 30) -> bool:
        """测试用：等扫描和清理都结束。"""
        end = time.monotonic() + timeout
        for t in (self._scan_thread, self._job_thread):
            if t is not None:
                t.join(max(0, end - time.monotonic()))
        return not any(t is not None and t.is_alive() for t in (self._scan_thread, self._job_thread))



