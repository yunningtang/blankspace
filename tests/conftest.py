import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))


def pytest_configure(config):
    # Windows 的临时文件夹在 AppData 里，而 AppData 是受保护的程序数据，测试文件会全部被拒绝。
    # 所以在 Windows 上把测试文件放到 AppData 外面。
    if os.name == "nt" and not config.option.basetemp:
        base = os.environ.get("RUNNER_TEMP") or os.path.join(os.environ.get("SystemDrive", "C:") + "\\", "liubai-test")
        config.option.basetemp = os.path.join(base, "pytest-liubai")


def symlink_or_skip(target, link, target_is_directory=False):
    """Windows 上建符号链接要特殊权限；建不了就跳过这个测试。"""
    try:
        os.symlink(target, link, target_is_directory=target_is_directory)
    except (OSError, NotImplementedError):
        pytest.skip("这台电脑不能建符号链接")
