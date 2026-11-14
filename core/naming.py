"""文件命名：只给建议（只读），执行走 mover，可以撤销。

1. 按拍摄时间重命名：IMG_2034.jpg、DSC0001.JPG、微信图片_20240301123045.jpg、mmexport1700000000000.jpg
   这类看不出内容的名字，改成“2023-05-04 14.22.10.jpg”。时间从哪来，按可靠程度：
   照片里记录的拍摄时间（EXIF） → 文件名里的日期 → 文件的修改时间（会标出来“不太准”）。
2. 版本混乱：“方案终版.pptx”“方案最终版.pptx”“方案(1).pptx”归成一组，留最新的那份在原处，
   其余的挪进同一个文件夹里的“旧版本”。不删除任何东西。
"""
from __future__ import annotations

import datetime as _dt
import os
import re
from dataclasses import dataclass, field

from .fs import is_link_or_junction, stamp
from .safety import is_protected

MEDIA = (".jpg", ".jpeg", ".png", ".heic", ".heif", ".gif", ".webp", ".dng", ".arw", ".cr2", ".cr3", ".nef",
         ".raf", ".rw2", ".mp4", ".mov", ".m4v", ".3gp", ".mkv")
CAMERA = re.compile(
    r"^(img|dsc|dscn|dscf|dji|gopr|pxl|vid|mvimg|mmexport|wp|pano|burst|photo|video|微信图片|微信视频|"
    r"qq图片|screenshot_|screenrecorder|imag|p\d{3})[_\- ]?[\w\-]*$", re.I)
OLD = "旧版本"
MAX_FILES = 5000


@dataclass
class Rename:
    src: str
    dst: str
    when: str           # exif / name / mtime
    stamp: tuple | None = None


@dataclass
class VersionGroup:
    id: str
    folder: str
    title: str          # 给人看的名字
    keep: str           # 留在原处的（最新的）
    older: list[str] = field(default_factory=list)
    sizes: dict = field(default_factory=dict)
    mtimes: dict = field(default_factory=dict)


# ---------------------------------------------------------------- 拍摄时间

def _exif_time(path: str) -> _dt.datetime | None:
    if not path.lower().endswith((".jpg", ".jpeg", ".tif", ".tiff", ".png", ".webp", ".heic")):
        return None
    try:
        from PIL import Image
        with Image.open(path) as im:
            ex = im.getexif()
            raw = None
            try:
                raw = ex.get_ifd(0x8769).get(36867)        # DateTimeOriginal
            except Exception:
                pass
            raw = raw or ex.get(36867) or ex.get(306)      # 306 = DateTime
        if raw:
            return _dt.datetime.strptime(str(raw).strip()[:19], "%Y:%m:%d %H:%M:%S")
    except Exception:
        return None
    return None


_NAME_DT = re.compile(r"(20\d{2}|19\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[-_ T]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})")
_NAME_D = re.compile(r"(20\d{2}|19\d{2})[-_.]?(\d{2})[-_.]?(\d{2})")
_MS = re.compile(r"(1[3-9]\d{11})")          # 13 位毫秒时间戳（mmexport 等）


def _name_time(name: str) -> _dt.datetime | None:
    m = _NAME_DT.search(name)
    if m:
        try:
            return _dt.datetime(*map(int, m.groups()))
        except ValueError:
            pass
    m = _MS.search(name)
    if m:
        try:
            return _dt.datetime.fromtimestamp(int(m.group(1)) / 1000)
        except (ValueError, OSError):
            pass
    m = _NAME_D.search(name)
    if m:
        try:
            return _dt.datetime(*map(int, m.groups()))
        except ValueError:
            pass
    return None


def needs_name(name: str) -> bool:
    stem, ext = os.path.splitext(name)
    return ext.lower() in MEDIA and bool(CAMERA.match(stem))


def propose_renames(folder: str, recursive: bool = True) -> list[Rename]:
    """看不出内容的照片、视频名字 → 按拍摄时间的新名字。"""
    out: list[Rename] = []
    stack = [folder]
    seen = 0
    while stack and seen < MAX_FILES:
        d = stack.pop()
        if is_protected(d):
            continue
        try:
            entries = list(os.scandir(d))
        except OSError:
            continue
        for e in entries:
            try:
                if is_link_or_junction(e) or e.name.startswith("."):
                    continue
                if e.is_dir(follow_symlinks=False):
                    if recursive:
                        stack.append(e.path)
                    continue
                if not needs_name(e.name):
                    continue
                seen += 1
                ext = os.path.splitext(e.name)[1].lower()
                when, how = _exif_time(e.path), "exif"
                if when is None:
                    when, how = _name_time(e.name), "name"
                if when is None:
                    when, how = _dt.datetime.fromtimestamp(e.stat(follow_symlinks=False).st_mtime), "mtime"
                new = when.strftime("%Y-%m-%d %H.%M.%S") + ext
                if new != e.name:
                    out.append(Rename(e.path, os.path.join(d, new), how, stamp(e.path)))
            except OSError:
                continue
    # 同一秒拍的、或者已经有同名文件的：加 (2)、(3)，让预览里看到的就是最后的名字
    taken: set[str] = set()
    for r in sorted(out, key=lambda r: (r.dst, r.src)):
        stem, ext = os.path.splitext(r.dst)
        cand, n = r.dst, 1
        while os.path.normcase(cand) in taken or (os.path.lexists(cand) and os.path.normcase(cand) != os.path.normcase(r.src)):
            n += 1
            cand = f"{stem} ({n}){ext}"
        r.dst = cand
        taken.add(os.path.normcase(cand))
    out.sort(key=lambda r: r.dst)
    return out


# ---------------------------------------------------------------- 版本混乱

_VER = re.compile(
    r"(最终版|最终|终版|终稿|定稿|确认版|修改版|修订版|修改稿|改稿|最新版|最新|新版|旧版|初稿|二稿|三稿|"
    r"final|draft|latest|new|old|copy|副本|"
    r"v\d+(\.\d+)*|ver\.?\s?\d+|版本\s?\d+|第\s?\d+\s?版|\(\d+\)|（\d+）|\d{8}|\d{4}[-.]\d{1,2}[-.]\d{1,2}|"
    r"改\d*|\d+稿)", re.I)
_SEP = re.compile(r"[\s_\-—–.·]+")


def _base(stem: str) -> str:
    s = _VER.sub(" ", stem)
    return _SEP.sub("", s).lower()


def propose_versions(folder: str) -> list[VersionGroup]:
    """同一个文件夹里，名字去掉“终版、v2、(1)、日期”之后一样、类型也一样的文件。"""
    try:
        entries = [e for e in os.scandir(folder) if not is_link_or_junction(e) and e.is_file(follow_symlinks=False)]
    except OSError:
        return []
    groups: dict[tuple[str, str], list[os.DirEntry]] = {}
    for e in entries:
        stem, ext = os.path.splitext(e.name)
        if needs_name(e.name) or ext.lower() in MEDIA:
            continue                        # 照片视频交给“按拍摄时间重命名”
        b = _base(stem)
        if len(b) < 2:
            continue
        groups.setdefault((b, ext.lower()), []).append(e)
    out = []
    for (b, ext), es in groups.items():
        if len(es) < 2 or not any(_VER.search(os.path.splitext(x.name)[0]) for x in es):
            continue                        # 至少有一个带“版本”字样，才算版本混乱
        info = []
        for x in es:
            try:
                st = x.stat(follow_symlinks=False)
                info.append((st.st_mtime, x.path, st.st_size))
            except OSError:
                continue
        if len(info) < 2:
            continue
        info.sort(reverse=True)             # 最新的在前
        g = VersionGroup(f"ver:{len(out) + 1}", folder, os.path.splitext(os.path.basename(info[0][1]))[0], info[0][1])
        for mtime, p, size in info:
            g.sizes[p] = size
            g.mtimes[p] = mtime
            if p != g.keep:
                g.older.append(p)
        out.append(g)
    return sorted(out, key=lambda g: -len(g.older))


def version_moves(g: VersionGroup) -> list[tuple[str, str]]:
    return [(p, os.path.join(g.folder, OLD, os.path.basename(p))) for p in g.older]
