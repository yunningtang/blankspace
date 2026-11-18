"""在真正的 Windows 上做真正的操作：真的移到回收站、真的问系统有哪些盘。

只在 GitHub Actions 的 Windows 机器上跑（设置了 LIUBAI_REAL_WINDOWS=1）。在你自己的电脑上跑测试时自动跳过，
不会往你的回收站里放东西。用的文件都是测试自己在 C:\\liubai-realtest 里新建的。
"""
import os
import uuid

import pytest

pytestmark = pytest.mark.skipif(not (os.name == "nt" and os.environ.get("LIUBAI_REAL_WINDOWS") == "1"),
                                reason="只在 CI 的 Windows 机器上做真实操作")

MB = 1024 * 1024


@pytest.fixture
def realdir():
    d = os.path.join((os.environ.get("SystemDrive") or "C:") + "\\", "liubai-realtest", uuid.uuid4().hex[:8])
    os.makedirs(d)
    return d


def test_really_goes_to_recycle_bin(realdir):
    from core import cleaner, recycle
    from core.oplog import OpLog
    assert recycle._backend is None                     # 真的回收站，不是测试用的假回收站
    f = os.path.join(realdir, "留白测试.bin")
    with open(f, "wb") as fh:
        fh.write(os.urandom(2 * MB))
    ok, why = recycle.check_recyclable(f, 2 * MB)
    assert ok, why
    before = recycle.bin_used(f)
    rep = cleaner.move_to_trash([f], log=OpLog(os.path.join(realdir, "logs")))
    assert not rep.failed, rep.failed
    assert not os.path.exists(f)                         # 离开了原处
    assert recycle.bin_used(f) - before >= 2 * MB        # 而且确实在回收站里，不是被永久删掉


def test_system_drive_is_listed():
    from core import places
    drives = places.drives()
    sd = (os.environ.get("SystemDrive") or "C:").upper()
    assert any(d["path"].upper().startswith(sd) and d["system"] for d in drives), drives


def test_folder_opening_helpers_exist_and_refuse_missing_paths(realdir):
    """在资源管理器里打开 / 选中文件：路径不存在时不报错、不打开别的地方。"""
    from core import winshell
    missing = os.path.join(realdir, "不存在.txt")
    for fn in (winshell.reveal, winshell.open_folder):
        assert fn(missing) is False
