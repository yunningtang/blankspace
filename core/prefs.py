"""用户的设置和选择。存在 %LOCALAPPDATA%\\Liubai\\prefs.json。

- consented：看过“开始之前”的说明。
- allow_changes：允许留白整理和清理文件。默认关着——关着时留白只看，不移动、不删除任何东西。
  打开后，每一次动手前仍然会先告诉用户要动什么、等用户确认。
- keep：说过“留着”的文件，以后不再提醒。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def default_path() -> Path:
    if getattr(sys, "frozen", False) or os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
        return Path(base) / "Liubai" / "prefs.json"
    return Path(__file__).resolve().parent.parent / "logs" / "prefs.json"


class Prefs:
    def __init__(self, path: Path | str | None = None):
        self.path = Path(path) if path else default_path()
        self.keep: set[str] = set()
        self.consented = False
        self.allow_changes = False
        self.lang = "auto"              # auto（跟系统）/ zh / en
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            self.keep = set(data.get("keep", []))
            self.consented = bool(data.get("consented", False))
            self.allow_changes = bool(data.get("allow_changes", False))
            self.lang = data.get("lang", "auto") if data.get("lang") in ("auto", "zh", "en") else "auto"
        except (OSError, ValueError):
            pass

    def save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"keep": sorted(self.keep), "consented": self.consented,
                                       "allow_changes": self.allow_changes, "lang": self.lang}, ensure_ascii=False, indent=1),
                           encoding="utf-8")
            os.replace(tmp, self.path)   # 先写临时文件再替换，断电也不会写坏
        except OSError:
            pass

    def set_keep(self, path: str, on: bool) -> None:
        (self.keep.add if on else self.keep.discard)(path)
        self.save()
