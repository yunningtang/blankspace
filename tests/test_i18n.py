"""英文界面：core 里每一句给用户看的中文都有英文；英文下走一遍完整流程，结果里只剩用户自己的文件名是中文。"""
import ast
import glob
import os
import re

import pytest

from core import i18n
from test_api import allow, make, opened, run, world  # noqa: F401  (world 是 fixture)

CJK = re.compile(r"[\u4e00-\u9fff]")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _ui_strings():
    """core/*.py 里的中文字符串和 f-string（{…} 记成 {}），不含文档字符串。"""
    out = []
    for f in sorted(glob.glob(os.path.join(ROOT, "core", "*.py"))):
        if f.endswith("i18n.py"):
            continue
        t = ast.parse(open(f, encoding="utf-8").read())
        doc, inner = set(), set()
        for n in ast.walk(t):
            if isinstance(n, (ast.FunctionDef, ast.ClassDef, ast.Module)) and n.body \
                    and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant):
                doc.add(id(n.body[0].value))
            if isinstance(n, ast.JoinedStr):
                inner.update(id(v) for v in n.values)
        for n in ast.walk(t):
            if isinstance(n, ast.JoinedStr):
                s = "".join(v.value if isinstance(v, ast.Constant) else "{}" for v in n.values)
            elif isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in doc and id(n) not in inner:
                s = n.value
            else:
                continue
            if CJK.search(s) or (isinstance(n, ast.JoinedStr) and re.search(r"[：。，、（）“”]", s)):
                out.append((os.path.basename(f), n.lineno, s))
    return out


def test_every_message_has_english():
    missing = [(f, line, s) for f, line, s in _ui_strings()
               if s not in i18n.EN and s not in i18n.NOT_UI and not s.startswith(("^(", "(最终版"))]
    assert not missing, "这些中文没有英文（加到 core/i18n.py 的 EN）：\n" + "\n".join(f"{f}:{l}  {s}" for f, l, s in missing)


def test_templates_and_folders():
    i18n.set_lang("en")
    try:
        assert i18n.tr("安装文件，2025 年 10 月下载。") == "Installer, downloaded in Oct 2025."
        assert i18n.tr("U 盘或移动硬盘没有回收站，删了就找不回来，留白不处理").startswith("A USB stick or removable drive has no")
        assert i18n.tr("30 天没碰过的东西") == "Things untouched for 30 days"
        assert i18n.tr("C:\\Users\\张三\\下载") == "C:\\Users\\张三\\下载"          # 路径不像任何一句话：原样
        assert i18n.folder("旧版本") == "Old versions"
        assert i18n.translate({"name": "C 盘"}) == {"name": "Drive C"}          # 盘的名字（只在 Windows 上出现）
        assert i18n.translate({"name": "我的 盘"}) == {"name": "我的 盘"}        # 用户的文件夹名不动
        assert i18n.translate({"path": "下载", "name": "临时文件", "why": "文件已经不在了",
                               "failed": [["C:\\文件已经不在了", "文件已经不在了"]]}) == \
            {"path": "下载", "name": "Temporary files", "why": "The file is no longer there",
             "failed": [["C:\\文件已经不在了", "The file is no longer there"]]}
    finally:
        i18n.set_lang("zh")
    assert i18n.folder("旧版本") == "旧版本" and i18n.tr("文件已经不在了") == "文件已经不在了"


def _leftover(obj, allowed, where="", out=None):
    out = [] if out is None else out
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k not in i18n.USER_KEYS:
                _leftover(v, allowed, f"{where}.{k}", out)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            _leftover(v, allowed, where, out)
    elif isinstance(obj, str) and CJK.search(obj) and not any(a in obj for a in allowed):
        out.append(f"{where}: {obj}")
    return out


def test_whole_flow_in_english_leaves_no_chinese(world):  # noqa: F811
    api, home, moved, tmp = world
    allowed = {f for _, _, files in os.walk(home) for f in files} | {d for _, ds, _ in os.walk(home) for d in ds}
    allowed |= {os.path.splitext(f)[0] for f in allowed}
    i18n.set_lang("en")
    try:
        seen = [api.start(), api.state()]
        opened(api, home)
        allow(api)
        dl = str(home / "Downloads")
        seen += [api.view(str(home)), api.view(dl), api.state()]
        for kind in ("inspect", "dupes", "tidy"):
            seen.append(api.tool(kind, dl))
        seen.append(api.tool("rename", str(home / "Pictures")))
        seen.append(api.tool("versions", str(home / "Documents")))
        seen += [api.caches(), api.drives(dl)]
        ins = api.tool("inspect", dl)
        ids = [i["id"] for g in ins["groups"] for i in g["items"]]
        p = api.plan("files", ids)
        seen.append(p)
        if "id" in p and p["count"]:
            seen.append(run(api, p))
        tid = api.tool("tidy", dl)
        p = api.plan("tidy", [x["id"] for x in tid["proposals"]])
        seen.append(p)
        if "id" in p and p["count"]:
            job = run(api, p)
            seen.append(job)
            # 留白建的文件夹用英文名
            assert any("Archive" in dst or "Screenshots" in dst for dst in
                       [r.get("dst", "") for r in api.history()["records"]])
            seen.append(api.undo(job["batch"]))
            api.wait_idle()
        seen += [api.state(), api.history(), api.plan("paths", [str(home / "nope")]),
                 api.plan("caches", ["temp"]), api.open_place(str(tmp / "missing"))]
        api.set_allow_changes(False)
        seen.append(api.plan("caches", ["temp"]))
        left = _leftover(seen, allowed)
        assert not left, "英文界面里还有中文：\n" + "\n".join(left[:40])
    finally:
        i18n.set_lang("zh")


def test_inner_calls_stay_chinese(world):  # noqa: F811
    """方法里互相调用时拿到的是中文原文（核心逻辑按中文判断的地方不能被翻译打乱）。"""
    api, home, moved, tmp = world
    i18n.set_lang("en")
    try:
        opened(api, home)
        out = api.view(str(home / "Downloads"))
        assert not any(CJK.search(x["name"]) for x in out["items"] if x["kind"] == "rest")
        assert api.caches()["items"][0]["name"] == "Temporary files"
    finally:
        i18n.set_lang("zh")
    assert api.caches()["items"][0]["name"] == "临时文件"
