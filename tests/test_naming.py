import os
import time

from core import mover, naming
from core.oplog import OpLog


def make(p, data=b"x", mtime=None):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    if mtime:
        os.utime(p, (mtime, mtime))
    return p


def test_camera_names_get_dates(tmp_path):
    from PIL import Image
    im = Image.new("RGB", (4, 4))
    ex = im.getexif()
    ex[306] = "2023:05:04 14:22:10"
    im.save(tmp_path / "IMG_2034.jpg", exif=ex)
    make(tmp_path / "微信图片_20240301123045.jpg")
    make(tmp_path / "mmexport1700000000000.jpg")
    make(tmp_path / "DSC0001.MOV", mtime=time.mktime((2022, 8, 1, 9, 30, 0, 0, 0, -1)))
    make(tmp_path / "海边日落.jpg")                       # 已经有意义的名字，不动
    make(tmp_path / "报告.pdf")
    rs = {os.path.basename(r.src): (os.path.basename(r.dst), r.when) for r in naming.propose_renames(str(tmp_path))}
    assert rs["IMG_2034.jpg"] == ("2023-05-04 14.22.10.jpg", "exif")
    assert rs["微信图片_20240301123045.jpg"] == ("2024-03-01 12.30.45.jpg", "name")
    assert rs["mmexport1700000000000.jpg"][1] == "name"
    assert rs["DSC0001.MOV"] == ("2022-08-01 09.30.00.mov", "mtime")
    assert "海边日落.jpg" not in rs and "报告.pdf" not in rs


def test_same_second_gets_unique_name_and_undo(tmp_path):
    a = make(tmp_path / "IMG_20240301_123045.jpg", b"1")
    b = make(tmp_path / "PXL_20240301_123045.jpg", b"2")
    rs = naming.propose_renames(str(tmp_path))
    log = OpLog(tmp_path / "logs")
    rep = mover.execute_moves(mover.plan_moves([(r.src, r.dst) for r in rs]), log)
    names = sorted(os.listdir(tmp_path))
    assert "2024-03-01 12.30.45.jpg" in names and "2024-03-01 12.30.45 (2).jpg" in names
    mover.execute_undo(mover.plan_undo(log, rep.batch), rep.batch, log)
    assert a.exists() and b.exists()


def test_version_groups(tmp_path):
    t = time.time()
    make(tmp_path / "方案终版.pptx", mtime=t - 300)
    make(tmp_path / "方案最终版.pptx", mtime=t - 100)
    make(tmp_path / "方案(1).pptx", mtime=t - 500)
    make(tmp_path / "方案v3.pptx", mtime=t - 10)            # 最新的
    make(tmp_path / "方案.pdf", mtime=t)                     # 类型不同，不算
    make(tmp_path / "预算.xlsx"); make(tmp_path / "会议纪要.docx")
    gs = naming.propose_versions(str(tmp_path))
    assert len(gs) == 1
    g = gs[0]
    assert os.path.basename(g.keep) == "方案v3.pptx" and len(g.older) == 3
    dsts = naming.version_moves(g)
    assert all(os.sep + "旧版本" + os.sep in d for _, d in dsts)


def test_similar_names_without_version_words_are_not_grouped(tmp_path):
    make(tmp_path / "report.docx"); make(tmp_path / "report_.docx")
    assert naming.propose_versions(str(tmp_path)) == []


def test_same_second_gets_unique_names(tmp_path):
    import os, time
    from core.naming import propose_renames
    t = time.mktime((2023, 5, 4, 14, 22, 10, 0, 0, -1))
    for n in ("IMG_1.jpg", "IMG_2.jpg"):
        p = tmp_path / n
        p.write_bytes(b"x")
        os.utime(p, (t, t))
    (tmp_path / "2023-05-04 14.22.10.jpg").write_bytes(b"y")     # 已经有这个名字
    names = sorted(os.path.basename(r.dst) for r in propose_renames(str(tmp_path)))
    assert names == ["2023-05-04 14.22.10 (2).jpg", "2023-05-04 14.22.10 (3).jpg"]
