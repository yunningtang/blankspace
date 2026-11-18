"""界面语言：中文（默认）和英文。

核心代码里的文字都是中文。英文界面时，`core/api.py` 在把结果交给界面之前统一翻译一遍（`translate`），
核心的安全逻辑一行都不用改。带变量的句子（大小、日期、名字）用模板匹配：模板里的 {} 是变量，
英文里用 {0}、{1}… 引用，变量本身也会再翻译一次（比如“2025 年 10 月”）。

文件名、路径是用户自己的东西，永远不翻译（见 USER_KEYS）。
留白在磁盘上新建的文件夹（旧版本、归档、截图、录屏、留白挪出）按当前语言起名（见 folder）。

`tests/test_i18n.py` 会检查：core 里每一句给用户看的中文都有英文；英文界面走一遍完整流程，结果里不剩中文。
"""
from __future__ import annotations

import os
import re
import sys

LANG = "zh"          # "zh" / "en"，由 Api 根据设置改


def system_lang() -> str:
    """Windows 显示语言是中文就用中文，否则英文。"""
    if sys.platform == "win32":
        try:
            import ctypes
            return "zh" if (ctypes.windll.kernel32.GetUserDefaultUILanguage() & 0x3FF) == 0x04 else "en"
        except Exception:
            return "zh"
    loc = (os.environ.get("LANG") or os.environ.get("LC_ALL") or "zh").lower()
    return "zh" if loc.startswith("zh") or loc in ("c", "c.utf-8", "posix") else "en"


def set_lang(lang: str) -> str:
    global LANG
    LANG = "en" if lang == "en" else "zh"
    return LANG


# ---------------------------------------------------------------- 留白在磁盘上建的文件夹

FOLDERS = {"旧版本": "Old versions", "归档": "Archive", "截图": "Screenshots", "录屏": "Screen recordings",
           "留白挪出": "Moved by Blankspace"}


def folder(zh: str) -> str:
    return FOLDERS.get(zh, zh) if LANG == "en" else zh


def folder_names(zh: str) -> tuple[str, ...]:
    """两种语言下的名字都算（换过语言以后，以前建的“归档”不能被当成普通文件夹再挪一次）。"""
    return (zh, FOLDERS.get(zh, zh))


# ---------------------------------------------------------------- 月份

_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _month(g):
    try:
        return f"{_MONTHS[int(g[1]) - 1]} {g[0]}"
    except (ValueError, IndexError):
        return f"{g[1]}/{g[0]}"


# ---------------------------------------------------------------- 英文

EN: dict[str, object] = {
    # ---- api.py
    "要先在设置里打开“允许留白整理和清理文件”。关着的时候，留白只看，不动任何文件。":
        "First turn on “Allow Blankspace to tidy and clean files” in Settings. While it is off, Blankspace only looks and never touches a file.",
    "不认识的工具": "Unknown tool",
    "可能不再需要": "Probably not needed any more",
    "你的文件": "Your files",
    "最近还在用": "Still in use",
    "留白不会动": "Blankspace won’t touch these",
    "整理": "Tidy up",
    "找不到这个文件夹": "This folder can’t be found",
    "这个文件夹不在这次扫描的范围里": "This folder isn’t part of this scan",
    "照片里记录的拍摄时间": "the time recorded in the photo",
    "文件名里的日期": "the date in the file name",
    "文件的修改时间（不太准）": "the file’s modified time (less reliable)",
    "你说过留着。": "You said to keep this.",
    "改名": "Rename",
    "正在扫描别的地方，先等它完成或者取消": "Another place is being scanned. Wait for it to finish, or cancel it",
    "扫描出错：{}": "The scan failed: {0}",
    "只改名字，不改内容，不换文件夹。同一秒拍的会在后面加 (2)。":
        "Only the names change, not the contents or the folders. Photos taken in the same second get (2) added.",
    "收起旧版本": "Put away old versions",
    "挪走": "Move",
    "这次确认已经过期，请重新点一次": "This confirmation has expired. Please click again",
    "上一批还没做完": "The previous batch isn’t finished yet",
    "正在扫描，扫描完再做": "A scan is running. Try again when it’s done",
    "{}开着，现在清不掉。先关掉它再清": "{0} is open, so this can’t be cleaned now. Close it first",
    "它的另一份也在这次要移走的里面，至少留一份": "Its twin is also in this batch. At least one copy must stay",
    "每一组都留下一份，内容一模一样。": "One copy of each group stays. The contents are identical.",
    "每组最新的那份留在原处，其余的收进同一个文件夹里的“旧版本”。":
        "The newest file in each group stays where it is. The others go into “Old versions” in the same folder.",
    "挪到 {}的“留白挪出”文件夹，保留原来的文件夹结构。":
        "Moved into the “Moved by Blankspace” folder on {0}, keeping the original folder structure.",
    "这一批已经撤销过了": "This batch has already been undone",
    "找不到要挪去的盘": "The drive to move to can’t be found",
    "这是移动硬盘，拔掉以后就看不到这些文件了。": "This is a removable drive. Unplug it and these files are gone from view.",
    "不认识的操作": "Unknown action",
    "这是这一组留下的那份，不移": "This is the copy this group keeps, so it stays",
    "留下的那份已经不在了，这一份也先不动": "The copy that was meant to stay is gone, so this one stays too",
    # ---- cleanables.py / cleaner.py
    "扫描之后有变化（被用过或已经没了），这次不动它": "Changed since the scan (used again, or gone), so it’s left alone this time",
    "文件已经不在了": "The file is no longer there",
    "扫描之后这个文件被改动过，为了稳妥这次不动它，请重新扫描":
        "This file changed after the scan. To be safe it’s left alone. Please scan again",
    "移到回收站后空间还不会变多，清空回收站以后才会真正空出来。":
        "Moving to the Recycle Bin doesn’t free space yet. The space comes back when you empty the Recycle Bin.",
    "回收站快满了。放进这些以后，Windows 会把回收站里最早删的一些文件永久清掉来腾地方。如果回收站里有想找回的，先去恢复。":
        "The Recycle Bin is nearly full. To make room, Windows will permanently remove the oldest items in it. If there’s anything in the Recycle Bin you want back, restore it first.",
    # ---- dupes.py
    "图片": "Pictures", "文档": "Documents", "视频": "Videos", "音乐": "Music", "桌面": "Desktop",
    "下载": "Downloads", "微信": "WeChat",
    # ---- inspect.py
    "{} 年 {} 月": _month,
    "项目的依赖包": "project dependencies",
    "下次打开项目时运行 npm install，会自动装回来。": "Run npm install next time you open the project and they come back.",
    "需要时重新安装依赖即可。": "Reinstall the dependencies when you need them.",
    "网站构建缓存": "site build cache",
    "重新运行就会生成。": "It’s rebuilt when you run it again.",
    "构建出来的文件": "build output",
    "重新构建就会生成，不影响源代码。": "It’s rebuilt when you build again. Your source code isn’t affected.",
    "编译出来的文件": "compiled output",
    "重新编译就会生成，不影响源代码。": "It’s rebuilt when you compile again. Your source code isn’t affected.",
    "Python 缓存": "Python cache",
    "运行时会自动重新生成。": "It’s recreated automatically when the code runs.",
    "测试缓存": "test cache",
    "运行测试时会重新生成。": "It’s recreated when the tests run.",
    "删了以后，需要时得重新下载。": "Once removed, you’ll have to download it again if you need it.",
    "删了以后，在聊天里点开会提示文件已过期或被清理。": "Once removed, opening it in the chat says the file has expired or was cleaned up.",
    "删了以后，在聊天里就打不开这个文件了。": "Once removed, this file can’t be opened from the chat any more.",
    "“{}”的{}，可以重新生成。": "The {1} of “{0}”. It can be regenerated.",
    "和“{}”一模一样，留一份就够。": "Identical to “{0}”. One copy is enough.",
    "另一份还在，不会丢东西。": "The other copy stays, so nothing is lost.",
    "有一模一样的副本，这一份留着。": "There’s an identical copy. This one stays.",
    "（这个位置留白不会动。）": " (Blankspace won’t touch this location.)",
    "安装文件，{}下载。": "Installer, downloaded in {0}.",
    "不影响已经装好的程序。": "Programs you’ve already installed aren’t affected.",
    "系统或软件的安装镜像，一般只在重装时用得上。": "A system or software install image. Usually only needed when reinstalling.",
    "需要时可以从官网重新下载。": "You can download it again from the official site if you need it.",
    "已经解压过了，旁边有同名的文件夹。": "Already extracted: there’s a folder with the same name next to it.",
    "解压出来的文件还在。": "The extracted files stay.",
    "最近改动过（{}）。": "Changed recently ({0}).",
    "{}以后没有改动过。": "Not changed since {0}.",
    "你的文件，{}以后没有改动过。": "Your file. Not changed since {0}.",
    "如果 C 盘紧，可以挪到别的盘，不用删。": "If drive C is tight, move it to another drive instead of removing it.",
    # ---- mover.py
    "程序数据，留白不移动它": "Program data. Blankspace doesn’t move it",
    "目标位置是系统或程序目录": "The destination is a system or program folder",
    "目标位置在 OneDrive 里，会上传到云端，留白不这样做": "The destination is in OneDrive and would be uploaded to the cloud. Blankspace doesn’t do that",
    "目标位置已经有同名的文件": "There’s already a file with this name at the destination",
    "目标位置是一个快捷链接": "The destination is a link",
    "目标是网络盘，断网就打不开，留白不往那里挪": "The destination is a network drive that goes away offline. Blankspace doesn’t move files there",
    "挪到别的盘要复制一遍，大文件会慢一些。复制完核对无误，才会删掉原来那份。":
        "Moving to another drive means copying first, so large files take a while. The original is removed only after the copy is checked.",
    "复制后核对不一致": "The copy didn’t match the original",
    "目标位置有一份没复制完的临时文件，请先检查": "There’s an unfinished temporary copy at the destination. Please check it first",
    "移到回收站": "Move to Recycle Bin",
    "移动": "Move",
    "目标盘不存在": "The destination drive doesn’t exist",
    "扫描之后这个文件被改动过，为了稳妥这次不动它": "This file changed after the scan. To be safe it’s left alone",
    "不能把文件夹挪进它自己里面": "A folder can’t be moved into itself",
    "确认之后这个文件被改动过，这次不动它": "This file changed after you confirmed, so it’s left alone",
    "原来的位置现在有了别的文件，不覆盖": "Something else is now in the original place. Nothing is overwritten",
    "这是一个快捷链接": "This is a link",
    "已取消": "Cancelled",
    "文件夹里有快捷链接，留白不跨盘移动这种文件夹": "The folder contains links. Blankspace doesn’t move such folders across drives",
    "已经不在挪过去的位置了": "It’s no longer where it was moved to",
    "目标盘的空间不够了": "Not enough space on the destination drive",
    # ---- naming.py
    "旧版本": "Old versions",
    # ---- places.py
    "{} 盘": "Drive {0}",
    "微信文件": "WeChat Files",
    "主目录": "Home",
    "根目录": "Root",
    # ---- procs.py
    "Chrome 浏览器": "Chrome", "Edge 浏览器": "Edge", "Firefox 浏览器": "Firefox", "微信（小程序）": "WeChat (mini programs)",
    "钉钉": "DingTalk", "飞书": "Feishu / Lark", "Brave 浏览器": "Brave", "Opera 浏览器": "Opera",
    "资源管理器": "File Explorer", "WPS 表格": "WPS Spreadsheets", "Windows 安全中心": "Windows Security",
    "Windows 搜索": "Windows Search", "Windows 桌面": "Windows desktop", "WSL / 虚拟机": "WSL / virtual machines",
    "留白": "Blankspace",
    # ---- recycle.py
    "这种盘": "This kind of drive",
    "{}没有回收站，删了就找不回来，留白不处理": "{0} has no Recycle Bin. Anything removed there can’t be recovered, so Blankspace leaves it alone",
    "这个盘的回收站被关掉了，删了就找不回来，留白不处理":
        "The Recycle Bin is turned off on this drive. Anything removed can’t be recovered, so Blankspace leaves it alone",
    "比回收站的容量还大，放不进回收站，留白不处理": "It’s bigger than the Recycle Bin can hold, so Blankspace leaves it alone",
    "Windows 返回错误 0x{}（文件可能正在使用）": "Windows returned error 0x{0} (the file may be in use)",
    "操作被取消": "The operation was cancelled",
    "移动后文件还在原处，可能有部分文件正在使用": "The file is still in its original place. Some of it may be in use",
    "U 盘或移动硬盘": "A USB stick or removable drive",
    "网络盘": "A network drive",
    "光盘": "A disc",
    # ---- safety.py
    "系统": "System",
    "浏览器": "Browsers",
    "聊天和办公": "Chat and office",
    "开发工具": "Developer tools",
    "下载里的旧安装包": "Old installers in Downloads",
    "这是一个快捷链接，不是真正的文件": "This is a link, not a real file",
    "不能删除整个磁盘": "A whole drive can’t be removed",
    "系统文件，留白不会动它": "A system file. Blankspace won’t touch it",
    "这是你的个人文件夹本身，只能删里面的文件": "This is one of your personal folders itself. Only the files inside can be removed",
    "OneDrive 里的文件删了会同步删掉云端的那份，留白不处理": "Removing a file in OneDrive also removes it from the cloud, so Blankspace leaves it alone",
    "程序数据，不在可放心清理的名单里": "Program data that isn’t on the safe-to-clean list",
    "临时文件": "Temporary files",
    "崩溃转储": "Crash dumps",
    "错误报告": "Error reports",
    "缩略图缓存": "Thumbnail cache",
    "Chrome 缓存": "Chrome cache",
    "Edge 缓存": "Edge cache",
    "Firefox 缓存": "Firefox cache",
    "Brave 缓存": "Brave cache",
    "Opera 缓存": "Opera cache",
    "系统网页缓存": "Windows internet cache",
    "显卡着色器缓存": "Graphics shader cache",
    "微信缓存": "WeChat cache",
    "Teams 缓存": "Teams cache",
    "Discord 缓存": "Discord cache",
    "Slack 缓存": "Slack cache",
    "Steam 网页缓存": "Steam web cache",
    "VS Code 一类编辑器的缓存": "VS Code-style editor caches",
    "npm 缓存": "npm cache",
    "pip 缓存": "pip cache",
    "uv 缓存": "uv cache",
    "Yarn 缓存": "Yarn cache",
    "NuGet 缓存": "NuGet cache",
    "Go 编译缓存": "Go build cache",
    "Cargo 下载缓存": "Cargo download cache",
    "Gradle 缓存": "Gradle cache",
    "留白自己的旧记录": "Blankspace’s own old records",
    "以后要重装这些程序，得重新下载安装包": "To reinstall these programs later, you’ll need to download the installers again",
    "下载文件夹里 30 天前、名字像安装包的文件（setup、install、.msi）。程序装好以后就用不到了":
        "Files in Downloads older than 30 days whose names look like installers (setup, install, .msi). Not needed once the program is installed",
    "程序运行时留下的临时文件，只清一天以上没动过的": "Temporary files left by programs. Only those untouched for more than a day",
    "程序崩溃时留下的内存记录，已经没用了": "Memory records left when programs crashed. No longer useful",
    "发给微软的错误报告的本地副本": "Local copies of error reports sent to Microsoft",
    "图片的小预览图，会自动重新生成。资源管理器开着时大多会跳过":
        "Small picture previews. They’re recreated automatically. Mostly skipped while File Explorer is open",
    "清了以后，常去的网页第一次打开会慢一些，要重新下载图片和脚本":
        "Afterwards, sites you visit often load more slowly the first time, as pictures and scripts are downloaded again",
    "网页图片和脚本的缓存。不影响登录、书签和历史记录": "Cached pictures and scripts from websites. Sign-ins, bookmarks and history aren’t affected",
    "网页缓存。不影响登录、收藏夹和历史记录": "Website cache. Sign-ins, favorites and history aren’t affected",
    "网页缓存。不影响登录、书签和历史记录": "Website cache. Sign-ins, bookmarks and history aren’t affected",
    "Windows 和一些老程序（Office 帮助、旧版网页控件）下载的网页文件。Windows 自带的磁盘清理也会清这一项":
        "Web files downloaded by Windows and some older programs (Office help, legacy web controls). Windows Disk Cleanup clears this too",
    "清了以后，游戏和 3D 程序第一次打开时会卡一会儿，等它重新生成":
        "Afterwards, games and 3D programs stutter briefly the first time while it’s rebuilt",
    "DirectX、NVIDIA、AMD 为游戏和 3D 程序编译好的显卡程序，会自动重新生成":
        "Graphics programs compiled by DirectX, NVIDIA and AMD for games and 3D apps. Rebuilt automatically",
    "清了以后，聊天里看过的图片和视频要重新加载，过期的可能看不了":
        "Afterwards, pictures and videos you’ve seen in chats load again, and expired ones may not open",
    "看过的图片和视频的缓存，不含聊天记录和收到的文件": "Cache of pictures and videos you’ve viewed. Chat history and received files aren’t included",
    "经典版 Teams 的网页缓存。不含聊天记录": "Web cache of classic Teams. Chat history isn’t included",
    "清了以后，Teams 第一次打开会慢一些": "Afterwards, Teams opens more slowly the first time",
    "清了以后，聊天里的图片和表情要重新加载": "Afterwards, pictures and emoji in chats load again",
    "看过的图片、表情的缓存。不含聊天记录和登录": "Cache of pictures and emoji you’ve viewed. Chat history and sign-in aren’t included",
    "清了以后，Slack 第一次打开会慢一些": "Afterwards, Slack opens more slowly the first time",
    "网页缓存。不含消息和登录": "Web cache. Messages and sign-in aren’t included",
    "清了以后，Steam 商店页面第一次打开会慢一些": "Afterwards, Steam store pages load more slowly the first time",
    "Steam 商店和社区页面的缓存。不影响游戏和存档": "Cache of Steam store and community pages. Games and saves aren’t affected",
    "VS Code、Cursor、Windsurf 的缓存、下载过的插件安装包和旧日志。不影响设置、插件和编辑记录":
        "Caches, downloaded extension packages and old logs of VS Code, Cursor and Windsurf. Settings, extensions and edit history aren’t affected",
    "清了以后，VS Code 第一次打开会慢一些": "Afterwards, VS Code opens more slowly the first time",
    "清了以后，下次安装依赖要重新下载，可能要很久": "Afterwards, dependencies are downloaded again next time, which can take a long time",
    "下载过的 JavaScript 包，需要时会重新下载": "Downloaded JavaScript packages. Downloaded again when needed",
    "下载过的 Python 包，需要时会重新下载": "Downloaded Python packages. Downloaded again when needed",
    "清了以后，下次编译 .NET 项目要重新下载依赖": "Afterwards, .NET projects download their dependencies again on the next build",
    "下载过的 .NET 包索引和插件缓存。不含已经解压的包": "Downloaded .NET package indexes and plugin cache. Extracted packages aren’t included",
    "清了以后，下次编译 Go 项目会慢一些": "Afterwards, the next Go build is slower",
    "Go 编译过程的中间结果，会自动重新生成": "Intermediate Go build results. Rebuilt automatically",
    "清了以后，下次编译 Rust 项目要重新下载依赖": "Afterwards, Rust projects download their dependencies again on the next build",
    "下载过的 Rust 包的压缩文件。已经解压的源码不动": "Compressed Rust packages that were downloaded. Extracted sources stay",
    "安卓和 Java 项目的依赖": "Dependencies of Android and Java projects",
    "清了以后，下次编译要重新下载全部依赖，可能要很久": "Afterwards, every dependency is downloaded again on the next build, which can take a long time",
    "90 天前的清理记录，和 90 天没再看过的地方的扫描结果。清掉以后，那些更早的挪动就不能在留白里撤销了":
        "Cleaning records older than 90 days, and scan results for places not looked at in 90 days. Afterwards, those older moves can’t be undone in Blankspace",
    # ---- space.py
    "微信聊天文件": "WeChat chat files", "QQ 聊天文件": "QQ chat files", "代码项目": "Code projects",
    "开发工具缓存": "Developer tool caches", "iPhone 备份": "iPhone backups", "虚拟机和 WSL": "Virtual machines and WSL",
    "Steam 游戏": "Steam games", "应用数据": "App data", "本地应用数据": "Local app data",
    "已安装的程序": "Installed programs", "应用缓存": "App caches",
    "iTunes / 苹果设备备份。旧手机的备份可以在 iTunes 或“Apple 设备”里删除":
        "iTunes / Apple device backups. Remove backups of old phones in iTunes or the Apple Devices app",
    "WSL、Docker、VirtualBox、VMware 和安卓模拟器的虚拟磁盘。请在对应软件里清理":
        "Virtual disks of WSL, Docker, VirtualBox, VMware and Android emulators. Clean them up in those programs",
    "请在 Steam 里卸载不玩的游戏": "Uninstall games you don’t play from within Steam",
    "页面文件": "Page file",
    "内存不够时 Windows 用的硬盘空间。大小由系统管理，不要手动删":
        "Disk space Windows uses when memory runs short. Windows manages its size. Don’t remove it by hand",
    "休眠文件": "Hibernation file",
    "电脑休眠时保存内存用的。不用休眠的话，可以用管理员命令 powercfg /h off 关掉":
        "Holds memory while the PC hibernates. If you don’t use hibernation, turn it off with the admin command powercfg /h off",
    "可用": "Free",
    "可放心清理": "Safe to clean",
    "回收站": "Recycle Bin",
    "Windows 和其他": "Windows and other",
    "在桌面右键回收站 →“清空回收站”": "Right-click the Recycle Bin on the desktop → “Empty Recycle Bin”",
    "Windows 本身、系统还原点、其他用户的文件，以及没有权限查看的地方。请交给系统自带的“存储感知”：设置 → 系统 → 存储":
        "Windows itself, restore points, other users’ files and places you can’t view. Leave these to Storage Sense: Settings → System → Storage",
    "{}：{}。": "{0}: {1}.",                     # api.py 把整理建议拼成一句
    # ---- tidy.py
    "截图和录屏": "Screenshots and screen recordings",
    "放进 图片 › 截图、视频 › 录屏，按月份分好": "Into Pictures › Screenshots and Videos › Screen recordings, sorted by month",
    "{} 天没碰过的{}": "{1} untouched for {0} days",
    "收进 {} › {}，按月份分好": "Into {0} › {1}, sorted by month",
    "东西": "Things",
    "文件": "Files",
    # ---- tree.py
    "系统文件，没有细看": "System files, not looked into",
    "其余的小文件": "Other small files",
    "没有权限查看": "No permission to view",
    "打不开": "Can’t be opened",
    "系统和没权限的地方": "System and places without permission",
}

# core 里出现、但不是给用户看的中文（匹配文件名用的词、正则）
NOT_UI = {
    "屏幕截图", "截图", "qq截图", "微信图片", "微信截图", "录屏", "屏幕录制", "空的大小", "归档", "留白挪出",
}


# ---------------------------------------------------------------- 翻译

def _compile():
    exact, pats = {}, []
    for zh, en in EN.items():
        if "{}" not in zh:
            exact[zh] = en
            continue
        parts = zh.split("{}")
        rx = "^" + "(.+?)".join(re.escape(p) for p in parts) + "$"
        pats.append((re.compile(rx, re.S), en, len(zh)))
    pats.sort(key=lambda x: -x[2])       # 长的模板先试，免得被短的抢先
    return exact, pats


_EXACT, _PATS = _compile()
_CJK = re.compile(r"[一-鿿]")


def tr(s: str) -> str:
    if LANG != "en" or not isinstance(s, str) or not _CJK.search(s):
        return s
    if s in _EXACT:
        return _EXACT[s]
    for rx, en, _ in _PATS:
        m = rx.match(s)
        if m:
            groups = [tr(g) for g in m.groups()]
            return en(groups) if callable(en) else en.format(*groups)
    # 几句拼在一起的（比如“原因（这个位置留白不会动。）”）
    for tail in ("（这个位置留白不会动。）",):
        if s.endswith(tail) and s != tail:
            return tr(s[: -len(tail)]) + _EXACT[tail]
    return s


PAIR_KEYS = {"failed", "refused"}

# 用户自己的东西：不翻译（label 是确认卡片用的操作代号，界面自己翻）
USER_KEYS = {"path", "root", "dst", "src", "from", "to", "where", "samples", "older", "keep", "current", "exe",
             "start_path", "home", "label", "file", "twin_of"}


def translate(obj, key: str | None = None):
    """把 API 的结果翻成当前语言。中文时原样返回。"""
    if LANG != "en":
        return obj
    if isinstance(obj, dict):
        return {k: translate(v, k) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        if key in USER_KEYS:
            return obj
        if key in PAIR_KEYS:               # [[路径, 原因], …]：只翻原因
            return [[x[0], tr(x[1])] if isinstance(x, (list, tuple)) and len(x) == 2 else x for x in obj]
        return [translate(v, key) for v in obj]
    if isinstance(obj, str):
        if key in USER_KEYS:
            return obj
        if key == "name":                  # 名字：只有我们自己起的名字才翻（文件夹名可能本来就叫“下载”）
            return _EXACT.get(obj, obj) if not callable(_EXACT.get(obj)) else obj
        return tr(obj)
    return obj
