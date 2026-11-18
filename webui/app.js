/* 留白：界面。数据全部来自后端（core/api.py），这里只负责显示和把用户的选择传回去。

   - 打开时不扫描。用户选了地方才开始；看过的地方直接显示上次的结果。
   - 画面只在需要时重画：墨和纸画进一张缓存图，鼠标移动只在上面叠一层。没有一直在跑的动画。
   - 只在扫描或清理进行中时轮询后端，平时不打扰。
   - 动文件一律：选择 → plan()（只读预检）→ 原地确认 → execute() → 结果。界面从不直接动文件。 */
"use strict";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const app = $("app"), cv = $("cv"), ctx = cv.getContext("2d");
const PAPER = "#FCFBF8";
const GB = 1024 ** 3;

// ---------------------------------------------------------------- 语言：L("中文", "English")
// 后端的文字由 core/i18n.py 翻好再送过来；这里只管界面自己的字。
let LANG = "zh";
const L = (zh, en) => LANG === "en" ? en : zh;
const SERIF = () => LANG === "en" ? '"Iowan Old Style", "Palatino Linotype", Georgia, "Noto Serif SC", serif'
  : '"Noto Serif SC", "Source Han Serif SC", "SimSun", serif';

// ---------------------------------------------------------------- 和后端说话
let viaWebview = false;
const TOKEN = new URLSearchParams(location.search).get("token") || "";
function call(name, ...args) {
  if (viaWebview) return window.pywebview.api[name](...args);
  return fetch("/api/" + name, { method: "POST", headers: { "X-Liubai-Token": TOKEN }, body: JSON.stringify(args) })
    .then(r => r.ok ? r.json() : { error: L("后端拒绝了这次请求（", "The backend refused this request (") + r.status + L("）", ")") });
}

// ---------------------------------------------------------------- 状态
const S = {
  screen: "loading",          // consent / start / place / tool / caches / procs / history / settings
  boot: null,                 // start() 的结果：盘、常用文件夹、上次看过的
  st: null,                   // state()
  path: null, view: null,     // 正在看的文件夹
  tool: null,                 // {kind, path, data}
  caches: null, procs: null, history: null,
  picked: new Set(),          // 缓存：选中的
  marks: new Set(), moveMarks: new Set(), dupeMarks: new Set(), sel: new Set(),
  act: { phase: "idle", plan: null },     // 操作区：idle / checking / ask / running / done / error
  hover: null, target: null,  // 鼠标下的块、右键选中的块
  blocks: [], shapes: {},
};

// ---------------------------------------------------------------- 格式
const fmt = b => { b = b || 0; const g = b / GB; return g >= 10 ? g.toFixed(0) + " G" : g >= .1 ? g.toFixed(1) + " G" : b >= 1024 ** 2 ? Math.round(b / 1024 ** 2) + " M" : Math.max(1, Math.round(b / 1024)) + " K"; };
const count = n => (n || 0).toLocaleString(LANG === "en" ? "en-US" : "zh-CN");
const ago = ts => {
  if (!ts) return "";
  const s = Date.now() / 1000 - ts, n = s < 3600 ? Math.round(s / 60) : s < 86400 ? Math.round(s / 3600) : Math.round(s / 86400);
  if (s < 90) return L("刚刚", "just now");
  const unit = s < 3600 ? ["分钟", "minute"] : s < 86400 ? ["小时", "hour"] : ["天", "day"];
  return L(`${n} ${unit[0]}前`, `${n} ${unit[1]}${n > 1 ? "s" : ""} ago`);
};
const base = p => String(p).split(/[\\/]/).filter(Boolean).pop() || p;
const base2 = p => { const parts = String(p).split(/[\\/]/).filter(Boolean); return parts.length > 1 ? parts.slice(-2).join(" / ") : (parts[0] || p); };
const allowed = () => !!(S.st ? S.st.allow_changes : S.boot && S.boot.allow_changes);

// 墨色：按“占这里的多少”分五级（在一个 2 G 的文件夹里，绝对大小没有意义）
const TIERS = [
  { min: .25, c: [32, 30, 28], label: "25%+" },
  { min: .10, c: [82, 79, 74], label: "10–25%" },
  { min: .04, c: [120, 116, 109], label: "4–10%" },
  { min: .015, c: [162, 158, 150], label: "1.5–4%" },
  { min: 0, c: [204, 200, 191], label: "<1.5%" },
];
const tierOf = f => TIERS.findIndex(t => f >= t.min);
const jit = k => { let h = 0; for (const ch of String(k)) h = (h * 31 + ch.charCodeAt(0)) % 997; return (h % 11 - 5) * 1.6; };
const toneOf = b => b.kind === "system" ? [214, 210, 202] : b.kind === "rest" ? [196, 192, 184] : TIERS[tierOf(b.frac)].c.map(v => Math.max(0, Math.min(255, Math.round(v + jit(b.key)))));
const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;
const isDark = c => c[0] < 128;

// ---------------------------------------------------------------- 画：只在需要时重画
// W、H、portrait 在 ink.js 里声明
const baseCv = document.createElement("canvas"), bctx = baseCv.getContext("2d");
let dpr = 1, paperPoly = null, ripples = [], rafOn = false;

function resize() {
  const r = app.getBoundingClientRect();
  dpr = Math.min(2, devicePixelRatio || 1);
  W = r.width; H = r.height; portrait = H > W * .95;
  cv.width = baseCv.width = Math.round(W * dpr); cv.height = baseCv.height = Math.round(H * dpr);
  const tw = Math.max(1, Math.round(W)), th = Math.max(1, Math.round(H));
  if (!paperTex || Math.abs(paperTex.width - tw - 40) > 40 || Math.abs(paperTex.height - th - 40) > 40) {
    paperTex = buildPaper(tw + 40, th + 40); washTex = buildWash(tw + 40, th + 40);
  }
  buildBase();
}

function setBlocks(blocks, paperFrac) {
  S.blocks = blocks; S.paperFrac = paperFrac;
  if (!reduce) { cv.classList.add("fading"); setTimeout(() => { buildBase(); cv.classList.remove("fading"); }, 110); }
  else buildBase();
}

// 把纸、墨、标签画进缓存图。块变了、窗口大小变了才调用。
function buildBase() {
  if (!W) return;
  const g = bctx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const all = [[0, 0], [W, 0], [W, H], [0, H]];
  const frac = S.paperFrac || .38;
  const [pp, rest] = split(all, frac, (portrait ? Math.PI / 2 : 0) + .12);
  paperPoly = pp;
  const items = S.blocks.filter(b => b.size > 0).map(b => ({ k: b.key, v: b.size })).sort((a, b) => b.v - a.v);
  const shapes = {};
  if (items.length) {
    const tree = buildTree(items, rng(20261114));
    const raw = {}; layoutTree(tree, rest, raw, k => Math.max((S.blocks.find(b => b.key === k) || {}).size || 0, 1));
    for (const b of S.blocks) if (raw[b.key] && raw[b.key].length > 2) shapes[b.key] = wobble(raw[b.key], 3);
  }
  S.shapes = shapes;
  const tr = pts => { g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); };
  const union = () => { g.beginPath(); for (const k in shapes) { shapes[k].forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); } };
  g.clearRect(0, 0, W, H);
  g.drawImage(paperTex, 0, 0);
  g.save(); g.globalCompositeOperation = "multiply";
  for (const b of S.blocks) { const s = shapes[b.key]; if (!s) continue; tr(s); g.fillStyle = rgb(toneOf(b)); g.fill(); }
  g.restore();
  if (Object.keys(shapes).length) {
    g.save(); union(); g.clip();
    g.globalCompositeOperation = "soft-light"; g.globalAlpha = .45; g.drawImage(washTex, -20, -20);
    g.globalCompositeOperation = "screen"; g.globalAlpha = .07; g.drawImage(paperTex, 0, 0);
    g.restore();
    for (const b of S.blocks) {
      const s = shapes[b.key]; if (!s) continue;
      g.save(); tr(s); g.clip();
      for (const [w, a] of [[12, .03], [4, .06]]) { g.lineWidth = w; g.strokeStyle = `rgba(10,9,8,${a})`; tr(s); g.stroke(); }
      g.restore();
    }
    g.save(); union(); g.strokeStyle = "rgba(252,251,248,.16)"; g.lineWidth = 1.2; g.stroke(); g.restore();
  }
  const pw = wobble(paperPoly, 3).map(([x, y]) => [x <= .5 ? -30 : x >= W - .5 ? W + 30 : x, y <= .5 ? -30 : y >= H - .5 ? H + 30 : y]);
  g.save(); tr(pw); g.clip(); g.drawImage(paperTex, 0, 0); g.restore();
  g.save(); tr(pw); g.clip(); g.lineWidth = 12; g.strokeStyle = "rgba(60,56,50,.08)"; tr(pw); g.stroke(); g.restore();
  // 标签
  const NAME = [19, 16, 14, 13, 12], SIZE = [13, 12, 11.5, 11, 11];
  for (const b of S.blocks) {
    const s = shapes[b.key]; if (!s) continue;
    const xs = s.map(p => p[0]), ys = s.map(p => p[1]);
    const bw = (Math.max(...xs) - Math.min(...xs)) * .72, bh = (Math.max(...ys) - Math.min(...ys)) * .7;
    const cx = xs.reduce((a, x) => a + x, 0) / xs.length, cy = ys.reduce((a, y) => a + y, 0) / ys.length;
    const ti = b.kind === "rest" || b.kind === "system" ? 4 : tierOf(b.frac), dark = isDark(toneOf(b));
    g.textAlign = "center"; g.textBaseline = "middle";
    const name = b.kind === "dir" ? b.name + " ›" : b.name;
    g.font = `${ti < 2 ? 500 : 400} ${NAME[ti]}px ${SERIF()}`;
    if (bh > NAME[ti] * 2.6 && g.measureText(name).width < bw) {
      g.fillStyle = dark ? "#F7F4EC" : "#141413"; g.fillText(name, cx, cy - NAME[ti] * .62);
      g.font = `300 ${SIZE[ti]}px ${SERIF()}`; g.fillStyle = dark ? "rgba(247,244,236,.72)" : "rgba(20,20,19,.62)";
      g.fillText(fmt(b.size), cx, cy + NAME[ti] * .72);
    } else {
      g.font = `300 ${SIZE[ti]}px ${SERIF()}`; g.fillStyle = dark ? "rgba(247,244,236,.8)" : "rgba(20,20,19,.7)";
      if (bh > 16 && g.measureText(fmt(b.size)).width < bw) g.fillText(fmt(b.size), cx, cy);
    }
  }
  placePaper();
  paint();
  probeCtrl();
}

// 每次鼠标移动只做这一点：贴缓存图 + 高亮
function paint() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(baseCv, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const hl = (k, fill, line) => {
    const s = S.shapes[k]; if (!s) return;
    ctx.beginPath(); s.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (line) { ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.stroke(); }
  };
  if (S.hover) { const b = S.blocks.find(x => x.key === S.hover); if (b) hl(S.hover, isDark(toneOf(b)) ? "rgba(252,251,248,.12)" : "rgba(10,9,8,.07)"); }
  if (S.target) hl(S.target.key, null, "rgba(22,22,22,.55)");
  const now = performance.now();
  ripples = ripples.filter(r => now - r.t < 1800);
  for (const r of ripples) {
    const k = (now - r.t) / 1800;
    ctx.strokeStyle = `rgba(22,22,22,${.25 * (1 - k)})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(r.x, r.y, 8 + k * 120, 0, 7); ctx.stroke();
  }
  if (ripples.length && !rafOn && !reduce) { rafOn = true; requestAnimationFrame(() => { rafOn = false; paint(); }); }
}

function placePaper() {
  const box = $("paper"), pad = Math.max(24, Math.min(W, H) * .045), TB = 32;
  box.style.left = pad + "px"; box.style.top = (TB + pad * .5) + "px";
  if (!portrait) {
    const rightX = Math.min(...paperPoly.filter(p => p[0] > 1).map(p => p[0]));
    box.style.width = Math.max(260, Math.min(440, rightX - pad * 1.4 - 14)) + "px";
    box.style.height = (H - TB - pad * 1.5) + "px";
  } else {
    const bottomY = Math.min(...paperPoly.filter(p => p[1] > 1).map(p => p[1]));
    box.style.width = (W - pad * 2) + "px";
    box.style.height = Math.max(260, bottomY - TB - pad) + "px";
  }
}

function probeCtrl() {
  const x = Math.round((W - 138) * dpr), y = Math.round(6 * dpr), w = Math.round(132 * dpr), h = Math.round(20 * dpr);
  if (x < 0) return;
  try {
    const px = bctx.getImageData(x, y, w, h).data; let s = 0;
    for (let i = 0; i < px.length; i += 16) s += px[i] * .3 + px[i + 1] * .59 + px[i + 2] * .11;
    $("tbCtrl").classList.toggle("on-dark", s / (px.length / 16) < 140);
  } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 画面：开始之前
function langLinks() {
  return `<div class="langs">${LANG === "en"
    ? `<button class="link u" data-act="lang" data-lang="zh">中文</button>`
    : `<button class="link u" data-act="lang" data-lang="en">English</button>`}</div>`;
}

function screenConsent() {
  setBlocks([], .5);
  return `${langLinks()}<div class="big">${L("留白", "Blankspace")}</div>
    <div class="line">${L("开始之前，先说清楚留白会做什么、不会做什么。", "Before you start, here is what Blankspace will and won’t do.")}</div>
    <ul class="promise">
      <li>${L("<b>你选了地方才会看。</b>打开时不扫描任何东西；你选一个盘或文件夹、点开始，才去读。看过的地方会记住，下次直接显示，不重复读硬盘。",
        "<b>It looks only where you choose.</b> Nothing is scanned when it opens. It reads a drive or folder only after you pick one, and remembers places it has seen so it doesn’t read the disk again.")}</li>
      <li>${L("<b>只读，直到你允许。</b>不打开“允许整理和清理”，留白只看，不移动、不删除任何文件。",
        "<b>Read-only until you allow it.</b> Unless you turn on “Allow tidying and cleaning”, Blankspace only looks. It never moves or removes a file.")}</li>
      <li>${L("<b>每次动手前都先问你。</b>就算允许了，每一次都会先列出要动什么、什么不会动，你点确定才开始。",
        "<b>It asks every time.</b> Even when allowed, it first lists what it will touch and what it won’t, and starts only when you confirm.")}</li>
      <li>${L("<b>不永久删除。</b>删除只移到回收站；放不进回收站的（U 盘、太大的文件）直接不动。挪走和改名都能撤销。",
        "<b>Nothing is permanently deleted.</b> Removing means moving to the Recycle Bin. Anything that can’t go there (USB sticks, very large files) is left alone. Moves and renames can be undone.")}</li>
      <li>${L("<b>不碰系统和程序。</b>Windows、Program Files、程序数据、OneDrive 一律不动。不联网，没有广告。",
        "<b>System and programs are off limits.</b> Windows, Program Files, program data and OneDrive are never touched. No network, no ads.")}</li>
    </ul>
    <div class="btnrow" style="margin-top:22px">
      <button class="yes" data-act="consent" data-allow="0">${L("先只看看", "Just look for now")}</button>
      <button class="link u" data-act="consent" data-allow="1">${L("允许整理和清理（每次仍会先问我）", "Allow tidying and cleaning (still ask me each time)")}</button>
    </div>
    <div class="line" style="font-size:11.5px;color:var(--ink3)">${L("以后可以在“设置”里改。", "You can change this later in Settings.")}</div>`;
}

// ---------------------------------------------------------------- 画面：选地方
function screenStart() {
  const b = S.boot || { drives: [], folders: [], recent: [] };
  const used = b.drives.reduce((a, d) => a + d.used, 0) || 1;
  setBlocks(b.drives.map(d => ({ key: "drive:" + d.path, kind: "dir", name: d.name, size: d.used, frac: d.used / used, path: d.path })), .42);
  const recent = (b.recent || []).map(r => `<button class="item" data-open="${esc(r.root)}"><span class="n">${esc(base(r.root) || r.root)}</span><span class="s">${fmt(r.size)}</span>
      <span class="h">${L(`${ago(r.at)}看过${r.complete ? "" : "（没看完）"} · 直接显示上次的结果`, `Seen ${ago(r.at)}${r.complete ? "" : " (not finished)"} · shows the last result`)}</span></button>`).join("");
  return `<div class="oneclick"><button class="go" data-act="oneclick"${S.act.phase === "idle" ? "" : " disabled"}>${L("一键清理", "One-click clean")}</button>
      <span class="h">${L("只清可以放心清的：临时文件、错误报告、缩略图这类。先告诉你清什么，你点确定才开始",
        "Only what’s safe to clean: temporary files, error reports, thumbnails and the like. It shows you what first and starts only when you confirm")}</span></div>
    <div class="act" id="act" data-buttons="[]"></div>
    <div class="meta">${L("选一个地方看看", "Pick a place to look at")}</div>
    <div class="line">${L("留白只会看你选的地方。看之前不会读任何文件。", "Blankspace looks only where you choose. Nothing is read before that.")}</div>
    <div class="sec"><span>${L("磁盘", "Drives")}</span></div>
    <div class="list">${b.drives.map(d => `<button class="item" data-open="${esc(d.path)}" data-scan="1">
        <span class="n">${esc(d.name)}${d.label ? `<span class="muted">　${esc(d.label)}</span>` : ""}${d.system ? `<span class="muted">　${L("系统盘", "system")}</span>` : ""}${d.removable ? `<span class="muted">　${L("移动硬盘", "removable")}</span>` : ""}</span>
        <span class="s">${L(`剩 ${fmt(d.free)} / ${fmt(d.total)}`, `${fmt(d.free)} free of ${fmt(d.total)}`)}</span>
        <span class="bar"><i style="width:${Math.round(d.used / d.total * 100)}%"></i></span></button>`).join("")}</div>
    <div class="sec"><span>${L("常用文件夹", "Common folders")}</span></div>
    <div class="chips">${b.folders.map(f => `<button data-open="${esc(f.path)}" data-scan="1">${esc(f.name)}</button>`).join("")}<button data-act="pick">${L("选择文件夹…", "Choose a folder…")}</button></div>
    ${recent ? `<div class="sec"><span>${L("上次看过", "Seen before")}</span></div><div class="list">${recent}</div>` : ""}
    <div class="sec"><span>${L("其他", "More")}</span></div>
    <div class="chips"><button data-go="caches">${L("系统和软件缓存", "System and app caches")}</button><button data-go="procs">${L("正在运行的程序", "Running programs")}</button><button data-go="history">${L("清理记录", "History")}</button></div>
    ${allowed() ? "" : `<div class="notice">${L("现在是“只看”模式，不会动任何文件。", "Look-only mode: no file will be touched.")}<button class="link" data-go="settings">${L("去设置", "Settings")}</button></div>`}`;
}

// ---------------------------------------------------------------- 画面：一个地方（往里走）
const toolText = k => ({
  inspect: [L("看看哪些可能不再需要", "What might not be needed"), L("旧安装包、已经解压过的压缩包、能重新生成的文件夹、很久没动的下载", "Old installers, archives already extracted, folders that can be regenerated, downloads untouched for a long time")],
  tidy: [L("整理这里", "Tidy this folder"), L("截图和录屏按月份收好，很久没碰的东西收进“归档”", "Screenshots and recordings sorted by month; things untouched for a long time go into “Archive”")],
  dupes: [L("找重复的文件", "Find duplicate files"), L("内容一模一样的，每组留一份。要读文件内容，大文件夹会久一点", "Files with identical contents, keeping one of each. Reads file contents, so big folders take a while")],
  rename: [L("按拍摄时间重命名照片", "Rename photos by date taken"), L("IMG_2034、微信图片_… 这类名字改成拍摄日期", "Names like IMG_2034 become the date the photo was taken")],
  versions: [L("整理文件版本", "Tidy file versions"), L("“终版”“最终版”“(1)”放在一起，留最新的", "“final”, “final2”, “(1)” go together; the newest stays")],
}[k]);

function screenPlace() {
  const st = S.st || {}, sc = st.scan || {}, v = S.view;
  if (sc.running) {
    setBlocks([], .5);
    return `<div class="meta">${esc(sc.root)}</div>
      <div class="big">${count(sc.count)}<small>${L("个文件", " files")}</small></div>
      <div class="line">${sc.paused ? L("已暂停。", "Paused.") : L("正在看…", "Looking…")}<span class="muted" style="font-size:11.5px"> ${esc(base2(sc.current || ""))}</span></div>
      <div class="line" style="font-size:11.5px;color:var(--ink3)">${L("后台慢慢读，不拖慢电脑；只读，不改任何文件。系统文件夹不进去。", "Reading slowly in the background so your PC stays fast. Read-only, nothing is changed. System folders are skipped.")}</div>
      <div class="btnrow">${sc.paused ? `<button class="yes" data-act="resume">${L("继续", "Resume")}</button>` : `<button class="yes" data-act="pause">${L("暂停", "Pause")}</button>`}<button class="link u" data-act="cancelscan">${L("取消", "Cancel")}</button></div>`;
  }
  if (!v || !v.ok) { setBlocks([], .5); return `<div class="loading">${esc((v && v.why) || st.error || L("正在打开…", "Opening…"))}</div>`; }
  const p = st.place || {};
  const total = v.size || 1;
  const drive = v.is_root && p.drive;
  setBlocks(v.items.map(x => ({ key: x.kind + ":" + x.path + (x.kind === "rest" ? ":rest" : ""), kind: x.kind, name: x.name, size: x.size, frac: x.size / (drive ? p.used || total : total), path: x.path, files: x.files, skipped: x.skipped })),
    drive && p.free ? Math.max(.36, p.free / (p.free + p.used)) : .38);
  const crumbs = `<button data-go="start">${L("首页", "Home")}</button>` + v.crumbs.map((c, i) => `<span class="sep">›</span>` + (i === v.crumbs.length - 1 ? `<span class="here">${esc(c.name)}</span>` : `<button data-nav="${esc(c.path)}">${esc(c.name)}</button>`)).join("");
  const top = v.items.filter(x => x.kind !== "rest" && x.kind !== "system").slice(0, 8);
  return `<div class="crumbs">${crumbs}</div>
    <div class="h1" title="${esc(v.path)}">${esc(v.name)}</div>
    <button class="pathlink" data-act="openfolder" data-path="${esc(v.path)}" title="${L("在资源管理器中打开", "Open in File Explorer")}"><bdi>${esc(v.path)}</bdi></button>
    <div class="line">${fmt(v.size)} · ${count(v.files)} ${L("个文件", "files")}${drive ? ` · ${L(`剩 ${fmt(p.free)}`, `${fmt(p.free)} free`)}` : ""}${v.skipped ? ` · ${esc(v.skipped)}` : ""}
      <span class="muted" style="font-size:11.5px">　${L(`${ago(p.at)}看的${p.complete ? "" : "（没看完）"}`, `seen ${ago(p.at)}${p.complete ? "" : " (not finished)"}`)}</span><button class="link u" data-act="rescan">${L("重新看", "Look again")}</button></div>
    <div class="sec"><span>${L("这里面最大的", "Largest here")}</span><span class="muted">${L("点进去 · 右键更多", "click to open · right-click for more")}</span></div>
    <div class="list" style="max-height:34%">${top.map(x => `<button class="item ${x.kind === "dir" ? "dir" : ""}${x.skipped ? " muted" : ""}" data-item="${esc(x.path)}" data-kind="${x.kind}">
      <span class="n">${esc(x.name)}</span><span class="s">${fmt(x.size)}</span><span class="bar"><i style="width:${Math.max(1, Math.round(x.size / total * 100))}%"></i></span></button>`).join("") || `<div class="loading">${L("这里是空的。", "This folder is empty.")}</div>`}</div>
    <div class="sec"><span>${L("可以做的事", "Things to do")}</span><span class="muted">${L("都只是先看看，不会动文件", "each one only looks first")}</span></div>
    <div class="list">${v.tools.map(t => `<button class="item" data-tool="${t}"><span class="n">${toolText(t)[0]}</span><span class="s"></span><span class="h">${toolText(t)[1]}</span></button>`).join("")}</div>
    <div class="act" id="act"></div>`;
}

// ---------------------------------------------------------------- 画面：工具的结果
function screenTool() {
  const t = S.tool, v = S.view;
  const head = `<div class="crumbs"><button data-go="place">← ${esc(v ? v.name : L("返回", "Back"))}</button></div>`;
  const titles = { inspect: L("可能不再需要的", "Might not be needed"), tidy: L("整理这里", "Tidy this folder"), dupes: L("重复的文件", "Duplicate files"),
    rename: L("按拍摄时间重命名", "Rename by date taken"), versions: L("整理文件版本", "Tidy file versions") };
  if (!t.data) return `${head}<div class="h1">${titles[t.kind]}</div><div class="loading">${L("正在看", "Looking")}${t.kind === "dupes" ? L("（要读文件内容，大文件夹会久一点）", " (reading file contents, big folders take a while)") : ""}…</div>
    <div class="btnrow"><button class="link u" data-act="canceltool">${L("停下", "Stop")}</button></div>`;
  const d = t.data;
  if (!d.ok) return `${head}<div class="loading">${esc(d.why || L("出错了", "Something went wrong"))}</div>`;
  let body = "", buttons = [];
  const showBtn = p => `<button class="link" data-reveal="${esc(p)}">${L("在文件夹中显示", "Show in folder")}</button>`;
  if (t.kind === "inspect") {
    const drive = S.drives && S.drives[0];
    body = `<div class="line">${d.maybe > 0 ? L(`约 <b>${fmt(d.maybe)}</b> 可能不再需要。`, `About <b>${fmt(d.maybe)}</b> might not be needed.`) : L("没发现明显不需要的东西。", "Nothing obviously unneeded.")}</div>` +
      d.groups.map(g => {
        const all = g.lvl === "maybe" && g.items.every(f => S.marks.has(f.id));
        return `<div class="gh"><span>${g.title}</span><span class="gs">${L(`${g.items.length} 项`, `${g.items.length} item${g.items.length > 1 ? "s" : ""}`)} · ${fmt(g.size)}</span>${g.lvl === "maybe" ? `<button class="link u" data-allmarks="1">${all ? L("全不选", "Select none") : L("全选", "Select all")}</button>` : ""}</div>` +
          g.items.map(f => {
            const m = S.marks.has(f.id), mv = S.moveMarks.has(f.id);
            const acts = g.lvl === "maybe" ? `<button class="link${m ? " on" : ""}" data-mark="${f.id}">${L("移走", "Remove")}</button><button class="link" data-keep="${f.id}">${L("留着", "Keep")}</button>`
              : g.lvl === "mine" && drive ? `<button class="link${mv ? " on" : ""}" data-move="${f.id}">${L(`挪到 ${esc(drive.name)}`, `Move to ${esc(drive.name)}`)}</button>` : "";
            return `<div class="file${g.lvl === "keep" || g.lvl === "lock" ? " muted" : ""}${m || mv ? " marked" : ""}" data-ctx="${esc(f.path)}" data-ctxkind="${f.dir ? "dir" : "file"}">
              <div class="l1"><span title="${esc(f.path)}">${esc(f.name)}</span><span>${fmt(f.size)}</span></div><div class="why">${esc(f.why)}</div>
              <div class="do">${acts}${showBtn(f.path)}</div></div>`;
          }).join("");
      }).join("") + (d.rest && d.rest.count ? `<div class="rest">${L(`其余 ${count(d.rest.count)} 个文件 · ${fmt(d.rest.size)} · 都不大，或者看不出该怎么处理`, `${count(d.rest.count)} other files · ${fmt(d.rest.size)} · all small, or nothing obvious to do`)}</div>` : "");
    const items = d.groups.flatMap(g => g.items), sel = items.filter(f => S.marks.has(f.id)), mv = items.filter(f => S.moveMarks.has(f.id));
    buttons = [{ kind: "files", label: L("移到回收站", "Move to Recycle Bin"), n: sel.length, bytes: sel.reduce((a, f) => a + f.size, 0) }];
    if (drive) buttons.push({ kind: "move", label: L(`挪到 ${drive.name}`, `Move to ${drive.name}`), n: mv.length, bytes: mv.reduce((a, f) => a + f.size, 0) });
  } else if (t.kind === "dupes") {
    const gs = d.dupes, copies = gs.flatMap(g => g.files.filter(f => !f.keeper));
    const sizeOf = Object.fromEntries(gs.flatMap(g => g.files.map(f => [f.id, g.size])));
    const allOn = copies.length && copies.every(f => S.dupeMarks.has(f.id));
    body = `<div class="line">${gs.length ? L(`${gs.length} 组一模一样的文件，副本共 <b>${fmt(d.size)}</b>。每组都会留一份。`, `${gs.length} groups of identical files, <b>${fmt(d.size)}</b> in copies. One of each always stays.`) : L("没有找到一模一样的文件。", "No identical files found.")}</div>` +
      (gs.length ? `<div class="gh"><span>${L("按占用从大到小", "Largest first")}</span><span class="gs">${L(`${gs.length} 组`, `${gs.length} groups`)}</span><button class="link u" data-alldupes="1">${allOn ? L("全不选", "Select none") : L("选上所有副本", "Select all copies")}</button></div>` : "") +
      gs.map(g => `<div class="dgroup"><div class="l1"><span>${esc(g.name)}</span><span>${fmt(g.size)} × ${g.files.length}</span></div>` + g.files.map(f => f.keeper
        ? `<div class="drow keep" data-ctx="${esc(f.path)}" data-ctxkind="file"><span class="tag">${L("留下", "Keeps")}</span><span class="w" title="${esc(f.path)}">${esc(f.where)} › ${esc(f.name)}</span><button class="link" data-reveal="${esc(f.path)}">${L("显示", "Show")}</button></div>`
        : `<div class="drow${S.dupeMarks.has(f.id) ? " on" : ""}" data-ctx="${esc(f.path)}" data-ctxkind="file"><button class="link${S.dupeMarks.has(f.id) ? " on" : ""}" data-dupe="${f.id}">${L("移走", "Remove")}</button><span class="w" title="${esc(f.path)}">${esc(f.where)} › ${esc(f.name)}</span><button class="link" data-keeper="${g.id}" data-file="${f.id}">${L("改留这份", "Keep this one")}</button></div>`).join("") + `</div>`).join("");
    const sel = copies.filter(f => S.dupeMarks.has(f.id));
    buttons = [{ kind: "dupes", label: L("移到回收站", "Move to Recycle Bin"), n: sel.length, bytes: sel.reduce((a, f) => a + sizeOf[f.id], 0) }];
  } else if (t.kind === "tidy") {
    if (!S.selInit) { S.selInit = true; d.proposals.forEach(p => S.sel.add(p.id)); }
    body = `<div class="line">${d.proposals.length ? L("按下面的方式分好放。只是挪位置，不删除，挪完可以撤销。", "Sorted as below. Files are only moved, never removed, and it can be undone.") : L("这里已经很整齐了。", "This folder is already tidy.")}</div>` +
      d.proposals.map(p => { const on = S.sel.has(p.id); return `<div class="prop"><button class="row${on ? "" : " off"}" data-sel="${p.id}"><span class="dot ${on ? "on" : ""}"></span><span>${esc(p.title)}<span class="sub">${L(`${p.count} 个`, `${p.count}`)}</span></span><span class="size">${fmt(p.size)}</span></button>
        <div class="how">${esc(p.how)}</div><div class="samples">${p.samples.map(esc).join(L("、", ", "))}${p.count > p.samples.length ? " …" : ""}</div></div>`; }).join("");
    const sel = d.proposals.filter(p => S.sel.has(p.id));
    buttons = [{ kind: "tidy", label: L("整理", "Tidy up"), n: sel.reduce((a, p) => a + p.count, 0), bytes: sel.reduce((a, p) => a + p.size, 0) }];
  } else if (t.kind === "rename") {
    if (!S.selInit) { S.selInit = true; d.renames.forEach(r => S.sel.add(r.id)); }
    const all = d.renames.length && d.renames.every(r => S.sel.has(r.id));
    body = `<div class="line">${d.renames.length ? L(`${d.renames.length} 个照片和视频的名字看不出内容，可以改成拍摄时间。只改名字，不改内容；改完可以撤销。`, `${d.renames.length} photos and videos have names that say nothing. They can be renamed to when they were taken. Only names change, and it can be undone.`) : L("这里没有需要改名的照片和视频。", "No photos or videos here need renaming.")}</div>` +
      (d.renames.length ? `<div class="gh"><span>${L("原来的名字 → 新名字", "Old name → new name")}</span><button class="link u" data-allsel="1">${all ? L("全不选", "Select none") : L("全选", "Select all")}</button></div>` : "") +
      d.renames.slice(0, 400).map(r => `<div class="rn" data-sel="${r.id}"><span class="dot ${S.sel.has(r.id) ? "on" : ""}"></span><span class="from">${r.where ? esc(r.where) + " › " : ""}${esc(r.from)}</span><span class="to">${esc(r.to)}</span><span class="how">${L("按", "from ")}${esc(r.how)}</span></div>`).join("");
    const n = d.renames.filter(r => S.sel.has(r.id)).length;
    buttons = [{ kind: "rename", label: L("改名", "Rename"), n, bytes: 0, noSize: true }];
  } else if (t.kind === "versions") {
    if (!S.selInit) { S.selInit = true; d.groups.forEach(g => S.sel.add(g.id)); }
    body = `<div class="line">${d.groups.length ? L("同一份文件存了好几个版本。每组最新的那份留在原处，其余的收进同一个文件夹里的“旧版本”。", "The same file was saved in several versions. The newest of each group stays put; the others go into “Old versions” in the same folder.") : L("这里没有发现一份文件存了好几个版本的情况。", "No file here was saved in several versions.")}</div>` +
      d.groups.map(g => { const on = S.sel.has(g.id); return `<div class="prop"><button class="row${on ? "" : " off"}" data-sel="${g.id}"><span class="dot ${on ? "on" : ""}"></span><span>${L("留下：", "Keeps: ")}${esc(g.keep)}</span><span class="size">${L(`${g.older.length} 个旧版`, `${g.older.length} older`)}</span></button>
        <div class="samples">${g.older.map(o => esc(o.name)).join(L("、", ", "))}</div></div>`; }).join("");
    const sel = d.groups.filter(g => S.sel.has(g.id));
    buttons = [{ kind: "versions", label: L("收起旧版本", "Put away old versions"), n: sel.reduce((a, g) => a + g.older.length, 0), bytes: 0, noSize: true }];
  }
  return `${head}<div class="h1">${titles[t.kind]}</div><button class="pathlink" data-act="openfolder" data-path="${esc(t.path)}"><bdi>${esc(t.path)}</bdi></button>
    <div class="list" style="flex:1 1 auto">${body}</div><div class="act" id="act" data-buttons='${esc(JSON.stringify(buttons))}'></div>`;
}

// ---------------------------------------------------------------- 画面：缓存
function screenCaches() {
  const c = S.caches;
  const head = `<div class="crumbs"><button data-go="back">← ${L("返回", "Back")}</button></div><div class="h1">${L("系统和软件缓存", "System and app caches")}</div>`;
  if (!c) return head + `<div class="loading">${L("正在看（只看几个缓存文件夹，很快）…", "Looking (only a few cache folders, this is quick)…")}</div>`;
  const items = c.items, isSafe = x => x.default && !x.cost && (x.group === "系统" || x.group === "System");
  const safe = items.filter(isSafe), slow = items.filter(x => !isSafe(x));
  const row = x => `<button class="row${S.picked.has(x.key) ? "" : " off"}" data-c="${x.key}"${x.busy ? " disabled" : ""}><span class="dot ${S.picked.has(x.key) ? "on" : ""}"></span><span>${esc(x.name)}</span><span class="size">${fmt(x.size)}</span>
     <span class="note">${esc(x.note)}${x.cost ? `<br><span class="cost">${L("代价：", "Cost: ")}${esc(x.cost)}</span>` : ""}${x.busy ? `<br><span class="busy">${L(`${esc(x.busy)}开着，现在清不掉。先关掉它`, `${esc(x.busy)} is open, so this can’t be cleaned now. Close it first`)}</span>` : ""}</span></button>`;
  const sel = items.filter(x => S.picked.has(x.key));
  return head + `<div class="line">${items.length ? L(`一共 ${fmt(items.reduce((a, x) => a + x.size, 0))}。`, `${fmt(items.reduce((a, x) => a + x.size, 0))} in total.`) : L("没有找到可以清的缓存。", "No caches to clean.")}</div>
    <div class="list" style="flex:1 1 auto">
      ${safe.length ? `<div class="sec"><span>${L("可以放心清", "Safe to clean")}</span><span class="muted">${L("几乎没有代价", "almost no downside")}</span></div><div class="items" style="padding-left:0">${safe.map(row).join("")}</div>` : ""}
      ${slow.length ? `<div class="sec"><span>${L("清了会慢一阵", "Slower for a while afterwards")}</span><span class="muted">${L("默认不选，看清代价再决定", "off by default; read the cost first")}</span></div><div class="items" style="padding-left:0">${slow.map(row).join("")}</div>` : ""}
    </div>
    <div class="act" id="act" data-buttons='${esc(JSON.stringify([{ kind: "caches", label: L("移到回收站", "Move to Recycle Bin"), n: sel.length, bytes: sel.reduce((a, x) => a + x.size, 0) }]))}'></div>`;
}

// ---------------------------------------------------------------- 画面：正在运行的程序
function screenProcs() {
  const p = S.procs;
  const head = `<div class="crumbs"><button data-go="back">← ${L("返回", "Back")}</button></div><div class="h1">${L("正在运行的程序", "Running programs")}</div>`;
  if (!p) return head + `<div class="loading">${L("正在看…", "Looking…")}</div>`;
  if (!p.ok) return head + `<div class="loading">${L("看不到程序列表。", "Can’t see the list of programs.")}</div>`;
  setBlocks(p.groups.slice(0, 18).map(g => ({ key: "proc:" + g.name, kind: "file", name: g.name, size: g.memory, frac: g.memory / p.used })), .42);
  const ask = S.endAsk;
  return head + `<div class="line">${L(`内存用了 <b>${fmt(p.used)}</b> / ${fmt(p.total)}（${Math.round(p.percent)}%）`, `Memory in use: <b>${fmt(p.used)}</b> of ${fmt(p.total)} (${Math.round(p.percent)}%)`)}<button class="link u" data-act="procs">${L("刷新", "Refresh")}</button></div>
    <div class="line" style="font-size:11.5px;color:var(--ink3)">${L("按占用的内存从多到少。同一个程序的多个进程合成一行。Windows 自己会管理内存，一般不需要手动关；只在某个程序卡住或占得太多时再关。",
      "Sorted by memory use. Several processes of the same program are shown as one line. Windows manages memory itself, so there’s usually no need to close anything. Only close a program that has hung or uses far too much.")}</div>
    <div class="list" style="flex:1 1 auto">${p.groups.map(g => `<div class="proc"><span class="n">${esc(g.name)}${g.count > 1 ? `<span class="muted">　${L(`${g.count} 个进程`, `${g.count} processes`)}</span>` : ""}</span><span class="m">${fmt(g.memory)}</span><span class="m">${g.cpu}%</span>
      <span class="h">${g.can_end ? (ask && ask.name === g.name ? `<span>${L(`关掉 ${esc(g.name)}？没保存的内容会丢。`, `Close ${esc(g.name)}? Unsaved work will be lost.`)}</span><button class="link" data-act="endyes">${L("关掉", "Close")}</button><button class="link" data-act="endno">${L("不了", "No")}</button>` : `<button class="link" data-end="${esc(g.name)}"${allowed() ? "" : ` disabled title="${L("先在设置里允许", "Allow it in Settings first")}"`}>${L("关掉", "Close")}</button>`) : `<span>${g.self ? L("这是留白自己", "This is Blankspace") : L("系统需要，不能关", "Needed by Windows")}</span>`}</span></div>`).join("")}</div>`;
}

// ---------------------------------------------------------------- 画面：清理记录、设置
function screenHistory() {
  const h = S.history;
  const head = `<div class="crumbs"><button data-go="back">← ${L("返回", "Back")}</button></div><div class="h1">${L("清理记录", "History")}</div>`;
  if (!h) return head + `<div class="loading">${L("正在读取…", "Reading…")}</div>`;
  const recs = h.records, batches = h.batches;
  const verb = r => !r.ok ? L("没有动：", "Not touched: ") + esc(r.error) : r.action === "trash" ? L("移到回收站", "Moved to Recycle Bin") : r.action === "undo" ? L("放回原处", "Put back") : L("挪到 ", "Moved to ") + esc(base2(r.dst || ""));
  return head + `<div class="line">${recs.length ? L("移到回收站的，到回收站里右键“还原”；挪走、改名、整理的，可以在这里撤销。", "Things moved to the Recycle Bin can be restored there (right-click → Restore). Moves, renames and tidying can be undone here.") : L("还没有清理过。", "Nothing cleaned yet.")}</div>
    <div class="list" style="flex:1 1 auto">${batches.length ? `<div class="sec"><span>${L("最近的挪动和改名", "Recent moves and renames")}</span></div>` + batches.map(x => `<div class="file"><div class="l1"><span>${esc((x.time || "").replace("T", " "))}</span><span>${L(`${x.count} 项`, `${x.count} items`)}</span></div>
      <div class="do">${x.undoable ? `<button class="link u" data-act="undo" data-batch="${x.batch}">${L("撤销这一批", "Undo this batch")}</button>` : `<span class="muted">${L("已撤销", "Undone")}</span>`}</div></div>`).join("") : ""}
    ${recs.length ? `<div class="sec"><span>${L("每一项", "Every item")}</span></div>` + recs.map(r => `<div class="file${r.ok ? "" : " muted"}" data-ctx="${esc(r.ok && r.action !== "trash" ? r.dst || r.path : r.path)}" data-ctxkind="file">
      <div class="l1"><span title="${esc(r.path)}">${esc(base2(r.path))}</span><span>${r.size ? fmt(r.size) : ""}</span></div>
      <div class="why">${esc((r.time || "").replace("T", " "))} · ${verb(r)}</div></div>`).join("") : ""}</div>
    <div class="act" id="act" data-buttons="[]"></div>
    <div class="btnrow"><button class="link u" data-act="openbin">${L("打开回收站", "Open Recycle Bin")}</button></div>`;
}

function screenSettings() {
  const on = allowed(), pref = (S.boot && S.boot.lang_pref) || "auto";
  const opt = (v, label) => `<button class="${pref === v ? "on" : ""}" data-act="lang" data-lang="${v}">${label}</button>`;
  return `<div class="crumbs"><button data-go="back">← ${L("返回", "Back")}</button></div><div class="h1">${L("设置", "Settings")}</div>
    <div class="switch" role="switch" aria-checked="${on}" data-act="toggleallow" tabindex="0"><span class="k"></span><span><span class="t">${L("允许留白整理和清理文件", "Allow Blankspace to tidy and clean files")}</span>
      <div class="d">${L("关着时留白只看：不移到回收站、不移动、不改名、不关程序。打开以后，每一次动手前仍然会先告诉你要动什么，你点确定才开始。",
        "While off, Blankspace only looks: nothing goes to the Recycle Bin, nothing is moved or renamed, no program is closed. When on, it still tells you what it will do every time and waits for you to confirm.")}</div></span></div>
    <div class="sec"><span>${L("语言", "Language")}</span></div>
    <div class="chips seg">${opt("auto", L("跟随系统", "Same as Windows"))}${opt("zh", "中文")}${opt("en", "English")}</div>
    <div class="line" style="font-size:12px">${L("留白新建的文件夹（旧版本、归档、截图）也按这个语言起名。", "Folders Blankspace creates (Old versions, Archive, Screenshots) are named in this language too.")}</div>
    <div class="sec"><span>${L("留白的东西存在哪", "Where Blankspace keeps its data")}</span></div>
    <div class="line" style="font-size:12px">${L("清理记录、设置和扫描结果都在 <code>%LOCALAPPDATA%\\Liubai</code>。卸载留白时不会删它们，由你决定。",
      "History, settings and scan results are in <code>%LOCALAPPDATA%\\Liubai</code>. Uninstalling doesn’t remove them; that’s up to you.")}</div>
    <div class="sec"><span>${L("右键菜单", "Right-click menu")}</span></div>
    <div class="line" style="font-size:12px">${L("安装版会在资源管理器的右键菜单里加一项“用留白看看这里”（Windows 11 在“显示更多选项”里）。卸载时会一起去掉。",
      "The installed version adds “Look here with Blankspace” to File Explorer’s right-click menu (on Windows 11 it’s under “Show more options”). Uninstalling removes it.")}</div>`;
}

// ---------------------------------------------------------------- 渲染
const RENDER = { consent: screenConsent, start: screenStart, place: screenPlace, tool: screenTool, caches: screenCaches, procs: screenProcs, history: screenHistory, settings: screenSettings, loading: () => `<div class="loading">…</div>` };
let lastScreen = null;
function render() {
  const view = $("view"), keep = view.querySelector(".list") ? view.querySelector(".list").scrollTop : 0;
  view.innerHTML = RENDER[S.screen]();
  if (S.screen === lastScreen) { const l = view.querySelector(".list"); if (l) l.scrollTop = keep; }
  else { view.classList.remove("enter"); void view.offsetWidth; view.classList.add("enter"); lastScreen = S.screen; }
  const act = $("act");
  if (act) renderAct(act, JSON.parse(act.dataset.buttons || "[]"));
}
function go(screen) {
  if (S.act.phase !== "running") S.act = { phase: "idle", plan: null };
  S.target = null; S.screen = screen; render();
}

// 标题栏、窗口按钮这些写在 index.html 里的字
function applyChrome() {
  document.documentElement.lang = LANG === "en" ? "en" : "zh-CN";
  document.title = L("留白", "Blankspace");
  document.body.classList.toggle("en", LANG === "en");
  document.querySelector(".tb-title").textContent = L("留 白", "Blankspace");
  $("mHome").textContent = L("首页", "Home");
  $("mHistory").textContent = L("清理记录", "History");
  $("mSettings").textContent = L("设置", "Settings");
  $("bMin").setAttribute("aria-label", L("最小化", "Minimize"));
  $("bMax").setAttribute("aria-label", L("最大化", "Maximize"));
  $("bClose").setAttribute("aria-label", L("关闭", "Close"));
  cv.setAttribute("aria-label", L("水墨图：每块墨是一个文件夹或文件，越大越深", "Ink map: each patch is a folder or file; bigger means darker"));
}

// ---------------------------------------------------------------- 操作区
// 确认卡片的操作代号由后端给（中文），这里翻成按钮上的字
const PLAN_LABEL = { "整理": ["整理", "Tidy up"], "改名": ["改名", "Rename"], "收起旧版本": ["收起旧版本", "Put away"], "挪走": ["挪走", "Move"] };
const planLabel = l => PLAN_LABEL[l] ? L(...PLAN_LABEL[l]) : L("挪走", "Move");

function renderAct(el, buttons) {
  const a = S.act, job = S.st && S.st.job;
  if (a.phase === "checking") { el.innerHTML = `<div class="card"><p>${L("正在检查每一项…", "Checking each item…")}</p></div>`; return; }
  if (a.phase === "error") { el.innerHTML = `<div class="card"><p class="lead">${esc(a.why)}</p><div class="btns">${a.why && (a.why.includes("设置") || a.why.includes("Settings")) ? `<button class="yes" data-go="settings">${L("去设置", "Open Settings")}</button>` : ""}<button class="link u" data-act="no">${L("好", "OK")}</button></div></div>`; return; }
  if (a.phase === "ask" && a.plan) {
    const p = a.plan;
    if (!p.count) { el.innerHTML = `<div class="card"><p class="lead">${L("这些都不能动。", "None of these can be touched.")}</p>${refusedList(p)}<div class="btns"><button class="link u" data-act="no">${L("好", "OK")}</button></div></div>`; return; }
    const lead = p.type === "move"
      ? ({ 整理: L(`整理 ${p.count} 个文件。`, `Tidy ${p.count} files.`), 改名: L(`给 ${p.count} 个文件改名。`, `Rename ${p.count} files.`),
           收起旧版本: L(`把 ${p.count} 个旧版本收进“旧版本”文件夹。`, `Put ${p.count} old versions into the “Old versions” folder.`) }[p.label]
         || L(`把 ${p.count} 项挪走，共 <b>${fmt(p.total)}</b>。`, `Move ${p.count} items, <b>${fmt(p.total)}</b> in all.`))
      : L(`把 ${p.count} 项移到回收站，共 <b>${fmt(p.total)}</b>。`, `Move ${p.count} items to the Recycle Bin, <b>${fmt(p.total)}</b> in all.`);
    const yes = p.type === "move" ? planLabel(p.label) : L("移到回收站", "Move to Recycle Bin");
    el.innerHTML = `<div class="card" role="group" aria-label="${L("确认", "Confirm")}"><p class="lead">${lead}</p>
      ${p.then.map(x => `<p>${esc(x)}</p>`).join("")}
      ${p.type === "move" ? `<p class="fine">${L("做完以后可以一键撤销，放回原处、改回原名。", "Afterwards you can undo it in one click: everything goes back, with the old names.")}</p>` : ""}
      ${p.refused_count ? refusedList(p) : ""}${p.warnings.map(w => `<p class="fine">${esc(w)}</p>`).join("")}
      <div class="btns"><button class="yes" data-act="yes">${yes}</button><button class="link u" data-act="no">${L("再想想", "Not now")}</button></div></div>`;
    return;
  }
  if (job && (a.phase === "running" || a.phase === "done")) {
    if (job.running) {
      const pc = job.count ? Math.round((job.index + 1) / job.count * 100) : 0;
      const doing = job.kind === "recycle" ? L("正在移到回收站", "Moving to Recycle Bin") : job.kind === "undo" ? L("正在放回原处", "Putting back") : L("正在挪", "Moving");
      el.innerHTML = `<div class="card"><p>${doing} ${Math.min(job.index + 1, job.count)} / ${job.count}</p><div class="progress"><i style="width:${pc}%"></i></div></div>`;
      return;
    }
    const failed = job.failed.length ? `<details><summary>${L(`${job.failed.length} 项没有动`, `${job.failed.length} items not touched`)}</summary><ul>${job.failed.map(([p, w]) => `<li>${esc(base(p))}：${esc(w)}</li>`).join("")}</ul></details>` : "";
    el.innerHTML = job.kind === "recycle"
      ? `<div class="card"><p class="lead">${L(`已移到回收站 ${job.moved} 项，共 <b>${fmt(job.trashed)}</b>。`, `Moved ${job.moved} items to the Recycle Bin, <b>${fmt(job.trashed)}</b> in all.`)}</p><p class="fine">${L("清空回收站后，这些空间才会空出来。想找回，也在回收站里。", "The space is freed when you empty the Recycle Bin. To get something back, it’s there too.")}</p>${failed}
         <div class="btns"><button class="yes" data-act="openbin">${L("打开回收站", "Open Recycle Bin")}</button><button class="link u" data-act="ok">${L("好", "OK")}</button></div></div>`
      : job.kind === "undo"
        ? `<div class="card"><p class="lead">${L(`已放回原处 ${job.moved} 项。`, `Put back ${job.moved} items.`)}</p>${failed}<div class="btns"><button class="yes" data-act="ok">${L("好", "OK")}</button></div></div>`
        : `<div class="card"><p class="lead">${L(`做好了 ${job.moved} 项。`, `Done: ${job.moved} items.`)}</p><p class="fine">${L("想放回原处，点撤销；以后也可以在“清理记录”里撤销。", "To put everything back, click Undo. You can also undo it later from History.")}</p>${failed}
           <div class="btns">${job.undoable ? `<button class="yes" data-act="undo" data-batch="${job.batch}">${L("撤销", "Undo")}</button>` : ""}<button class="link u" data-act="ok">${L("好", "OK")}</button></div></div>`;
    return;
  }
  const busy = S.st && ((S.st.scan && S.st.scan.running) || (job && job.running));
  el.innerHTML = buttons.filter(b => b.n || buttons.length === 1).map(b =>
    `<button class="go" data-act="ask" data-kind="${b.kind}"${b.n && !busy ? "" : " disabled"}>${b.label}${b.n ? L(`（${b.n} 项${b.noSize ? "" : " · " + fmt(b.bytes)}）`, ` (${b.n}${b.noSize ? "" : " · " + fmt(b.bytes)})`) : ""}</button>`).join("")
    + (allowed() || !buttons.length ? "" : `<div class="fine" style="font-size:11.5px;color:var(--ink3)">${L("现在是只看模式，点了会提示你去设置里打开。", "Look-only mode: clicking will point you to Settings.")}</div>`);
}
function refusedList(p) {
  return `<details><summary>${L(`另有 ${p.refused_count} 项不会动`, `${p.refused_count} more won’t be touched`)}</summary><ul>${p.refused.map(([x, w]) => `<li>${esc(base(x))}${L("：", ": ")}${esc(w)}</li>`).join("")}</ul></details>`;
}

async function askPlan(kind, ids, target) {
  S.act = { phase: "checking", plan: null }; render();
  if (!ids) {
    ids = { caches: [...S.picked], files: [...S.marks], move: [...S.moveMarks], dupes: [...S.dupeMarks], tidy: [...S.sel], rename: [...S.sel], versions: [...S.sel] }[kind];
    if (kind === "move") target = S.drives && S.drives[0] && S.drives[0].path;
  }
  const plan = await call("plan", kind, ids, target || null);
  S.act = plan.error ? { phase: "error", why: plan.error } : { phase: "ask", plan };
  render();
  const y = app.querySelector(".card .yes"); if (y) y.focus({ preventScroll: true });
}
async function confirmPlan() {
  const r = await call("execute", S.act.plan.id);
  if (!r.started) { S.act = { phase: "error", why: r.why || L("没有开始", "It didn’t start") }; render(); return; }
  S.act = { phase: "running", plan: S.act.plan };
  if (S.target && S.shapes[S.target.key]) { const s = S.shapes[S.target.key]; ripples.push({ x: s.reduce((a, p) => a + p[0], 0) / s.length, y: s.reduce((a, p) => a + p[1], 0) / s.length, t: performance.now() }); paint(); }
  S.marks.clear(); S.moveMarks.clear(); S.dupeMarks.clear();
  render(); poll();
}
async function startUndo(batch) {
  const r = await call("undo", batch);
  if (!r.started) { S.act = { phase: "error", why: r.why || L("没法撤销", "Can’t undo") }; render(); return; }
  S.act = { phase: "running", plan: null }; render(); poll();
}

// ---------------------------------------------------------------- 打开地方、往里走、工具
async function openPlace(path, rescan) {
  const r = await call("open_place", path, !!rescan);
  if (!r.ok) { S.act = { phase: "error", why: r.why }; S.screen = "start"; render(); return; }
  S.path = r.loaded ? path : null; S.view = null; S.screen = "place";
  await refreshState();
  if (r.loaded) await nav(path); else { render(); poll(); }
}
async function nav(path) {
  S.path = path; S.target = null; S.tool = null;
  if (S.act.phase !== "running") S.act = { phase: "idle", plan: null };
  S.view = await call("view", path);
  S.drives = await call("drives", path);
  S.screen = "place"; render();
}
async function runTool(kind, path) {
  S.tool = { kind, path: path || S.path, data: null }; S.marks.clear(); S.moveMarks.clear(); S.dupeMarks.clear(); S.sel = new Set(); S.selInit = false;
  go("tool");
  const data = await call("tool", kind, S.tool.path);
  if (S.tool && S.tool.kind === kind) { S.tool.data = data; render(); }
}
async function reloadAfterJob() {
  if (S.screen === "tool" && S.tool) { const data = await call("tool", S.tool.kind, S.tool.path); S.tool.data = data; S.selInit = false; S.sel = new Set(); }
  if (S.path) { S.view = await call("view", S.path); }
  if (S.screen === "caches") S.caches = await call("caches");
  if (S.screen === "history") S.history = await call("history");
  render();
}

// ---------------------------------------------------------------- 状态轮询：只在忙的时候
let polling = false;
async function refreshState() { S.st = await call("state"); return S.st; }
async function poll() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const st = await refreshState();
      const scanning = st.scan && st.scan.running, working = st.job && st.job.running;
      if (S.screen === "place" && !S.view) {
        if (!scanning && st.place) { await nav(st.place.root); }
        else render();
      }
      if (S.act.phase === "running") {
        if (!working && st.job && st.job.done) { S.act.phase = "done"; await reloadAfterJob(); }
        else render();
      }
      if (!scanning && !working) break;
      await new Promise(r => setTimeout(r, scanning ? 400 : 250));
    }
  } finally { polling = false; }
}

// ---------------------------------------------------------------- 右键菜单
const menu = $("menu");
function openMenu(x, y, t) {
  S.target = t; paint();
  const can = allowed(), drive = S.drives && S.drives[0];
  const dis = can ? "" : ` disabled title="${L("先在设置里允许整理和清理", "Allow tidying and cleaning in Settings first")}"`;
  const items = [];
  if (t.kind === "dir") items.push(`<button data-m="enter">${L("进去看看", "Open here")}</button>`, `<button data-m="openfolder">${L("在资源管理器中打开", "Open in File Explorer")}</button>`);
  if (t.kind === "file") items.push(`<button data-m="openfile">${L("打开", "Open")}</button>`, `<button data-m="reveal">${L("在文件夹中显示", "Show in folder")}</button>`);
  if (t.kind === "rest" || t.kind === "system") items.push(`<button data-m="openfolder">${L("在资源管理器中打开", "Open in File Explorer")}</button>`);
  if (t.kind === "dir" || t.kind === "file") {
    items.push(`<button data-m="copy">${L("复制路径", "Copy path")}</button>`);
    if (t.kind === "dir") items.push(`<hr><button data-m="inspect">${L("看看哪些可能不再需要", "What might not be needed")}</button>`);
    items.push(`<hr><button data-m="trash"${dis}>${L("移到回收站…", "Move to Recycle Bin…")}</button>`);
    if (drive) items.push(`<button data-m="move"${dis}>${L(`挪到 ${esc(drive.name)}…`, `Move to ${esc(drive.name)}…`)}</button>`);
  }
  menu.innerHTML = `<div class="mh" title="${esc(t.path)}">${esc(t.name || base(t.path))}</div>` + items.join("");
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, W - r.width - 8) + "px"; menu.style.top = Math.min(y, H - r.height - 8) + "px";
  const first = menu.querySelector("button:not([disabled])"); if (first) first.focus({ preventScroll: true });
}
function closeMenu() { if (!menu.hidden) { menu.hidden = true; S.target = null; paint(); } }
menu.addEventListener("click", async e => {
  const b = e.target.closest("button[data-m]"); if (!b || b.disabled) return;
  const t = S.target, m = b.dataset.m;
  menu.hidden = true;
  if (m === "enter") nav(t.path);
  else if (m === "openfolder") call("open_folder", t.path);
  else if (m === "openfile") call("open_file", t.path);
  else if (m === "reveal") call("reveal", t.path);
  else if (m === "copy") copyText(t.path);
  else if (m === "inspect") runTool("inspect", t.path);
  else if (m === "trash" || m === "move") {
    if (!$("act")) go("place");
    await askPlan(m === "trash" ? "paths" : "move", [t.path], m === "move" ? S.drives[0].path : null);
  }
  S.target = null; paint();
});
function copyText(s) {
  const done = () => { const sl = $("slip"); sl.innerHTML = L("已复制路径", "Path copied"); sl.style.left = "50%"; sl.style.top = (H - 60) + "px"; sl.classList.add("on"); setTimeout(() => sl.classList.remove("on"), 1200); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s).then(done, () => fallback());
  else fallback();
  function fallback() { const ta = document.createElement("textarea"); ta.value = s; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); done(); } catch (e) { } ta.remove(); }
}

// ---------------------------------------------------------------- 鼠标
const slip = $("slip");
function pickAt(x, y) { for (const k in S.shapes) if (inside(S.shapes[k], x, y)) return S.blocks.find(b => b.key === k); return null; }
cv.addEventListener("mousemove", e => {
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, b = pickAt(x, y);
  const k = b ? b.key : null;
  if (k !== S.hover) { S.hover = k; paint(); }
  cv.classList.toggle("pointer", !!b);
  if (!b) { slip.classList.remove("on"); return; }
  const tip = b.kind === "dir" ? L("点一下进去 · 右键更多", "Click to open · right-click for more") : b.kind === "file" ? L("右键：打开、在文件夹中显示…", "Right-click: open, show in folder…") : b.kind === "system" ? L("Windows、程序和没权限看的地方", "Windows, programs and places without permission") : "";
  slip.innerHTML = `${esc(b.name)}　${fmt(b.size)}${b.files > 1 ? `<em>${L(`${count(b.files)} 个文件`, `${count(b.files)} files`)}</em>` : ""}${b.skipped ? `<em>${esc(b.skipped)}</em>` : ""}<span class="tip">${tip}</span>`;
  slip.style.left = Math.min(x + 16, W - 270) + "px"; slip.style.top = (y + 18 + 80 > H ? y - 80 : y + 18) + "px";
  slip.classList.add("on");
});
cv.addEventListener("mouseleave", () => { S.hover = null; slip.classList.remove("on"); paint(); });
cv.addEventListener("click", e => {
  closeMenu();
  const r = cv.getBoundingClientRect(), b = pickAt(e.clientX - r.left, e.clientY - r.top);
  if (!b) return;
  if (b.key.startsWith("drive:")) return openPlace(b.path, false);
  if (b.kind === "dir" && S.screen === "place") return nav(b.path);
  if (b.kind === "dir" && S.screen === "tool") return nav(b.path);
});
cv.addEventListener("contextmenu", e => {
  e.preventDefault();
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, b = pickAt(x, y);
  if (!b || !b.path || b.key.startsWith("drive:") || b.key.startsWith("proc:")) return;
  slip.classList.remove("on");
  openMenu(x, y, { key: b.key, kind: b.kind, name: b.name, path: b.path });
});
document.addEventListener("contextmenu", e => {
  const row = e.target.closest("[data-item],[data-ctx]");
  if (!row) { if (e.target.closest("#view")) e.preventDefault(); return; }
  e.preventDefault();
  const r = app.getBoundingClientRect();
  const path = row.dataset.item || row.dataset.ctx, kind = row.dataset.kind || row.dataset.ctxkind || "file";
  const key = (kind === "rest" ? "rest:" : kind + ":") + path;
  openMenu(e.clientX - r.left, e.clientY - r.top, { key, kind, name: base(path), path });
});
document.addEventListener("mousedown", e => { if (!e.target.closest("#menu")) closeMenu(); });

document.addEventListener("click", async e => {
  const t = e.target.closest("button,[data-sel],[data-act]"); if (!t || t.disabled) return;
  const d = t.dataset;
  if (d.go === "back") return S.path ? (S.view ? go("place") : go("start")) : go("start");
  if (d.go === "start") { S.path = null; S.view = null; return go("start"); }
  if (d.go === "place") return go("place");
  if (d.go === "caches") { S.caches = null; go("caches"); S.caches = await call("caches"); S.picked = new Set(S.caches.items.filter(x => x.default).map(x => x.key)); return render(); }
  if (d.go === "procs") return loadProcs();
  if (d.go === "history") { S.history = null; go("history"); S.history = await call("history"); return render(); }
  if (d.go === "settings") return go("settings");
  if (d.open) return openPlace(d.open, false);
  if (d.nav) return nav(d.nav);
  if (d.item) { if (d.kind === "dir") return nav(d.item); return call("reveal", d.item); }
  if (d.tool) return runTool(d.tool);
  if (d.c) { S.picked.has(d.c) ? S.picked.delete(d.c) : S.picked.add(d.c); resetAsk(); return render(); }
  if (d.mark) { S.moveMarks.delete(d.mark); toggle(S.marks, d.mark); return; }
  if (d.move) { S.marks.delete(d.move); toggle(S.moveMarks, d.move); return; }
  if (d.dupe) return toggle(S.dupeMarks, d.dupe);
  if (d.sel) return toggle(S.sel, d.sel);
  if (d.allsel) { const ids = S.tool.data.renames.map(r => r.id); const all = ids.every(i => S.sel.has(i)); ids.forEach(i => all ? S.sel.delete(i) : S.sel.add(i)); resetAsk(); return render(); }
  if (d.alldupes) { const ids = S.tool.data.dupes.flatMap(g => g.files.filter(f => !f.keeper).map(f => f.id)); const all = ids.every(i => S.dupeMarks.has(i)); ids.forEach(i => all ? S.dupeMarks.delete(i) : S.dupeMarks.add(i)); resetAsk(); return render(); }
  if (d.allmarks) { const g = S.tool.data.groups.find(g => g.lvl === "maybe"); const all = g.items.every(f => S.marks.has(f.id)); g.items.forEach(f => all ? S.marks.delete(f.id) : S.marks.add(f.id)); resetAsk(); return render(); }
  if (d.keeper) { S.dupeMarks.delete(d.file); await call("set_keeper", d.keeper, d.file); S.tool.data = await call("tool", "dupes", S.tool.path); return render(); }
  if (d.keep) { S.marks.delete(d.keep); await call("set_keep", d.keep, true); S.tool.data = await call("tool", "inspect", S.tool.path); return render(); }
  if (d.reveal) return call("reveal", d.reveal);
  if (d.end) { S.endAsk = S.procs.groups.find(g => g.name === d.end); return render(); }
  switch (d.act) {
    case "consent": { const r = await call("set_consent", d.allow === "1"); S.boot.allow_changes = r.allow_changes; S.boot.consented = true; return afterConsent(); }
    case "lang": return setLang(d.lang);
    case "oneclick": {
      // 只挑“可以放心清”的默认项，正开着的程序用的跳过；照常预检 → 确认 → 进回收站
      S.act = { phase: "checking", plan: null }; render();
      const c = await call("caches");
      const keys = (c.items || []).filter(x => x.default && !x.busy && x.size > 0 && (x.group === "系统" || x.group === "System") && !x.cost).map(x => x.key);
      if (!keys.length) { S.act = { phase: "error", why: L("现在没有需要清的。临时文件这类都很干净。", "Nothing to clean right now. Temporary files and the like are already tidy.") }; return render(); }
      return askPlan("caches", keys);
    }
    case "pick": { const r = viaWebview ? await call("pick_folder") : { path: prompt(L("文件夹路径", "Folder path")) }; if (r && r.path) openPlace(r.path, false); return; }
    case "rescan": return openPlace(S.st.place.root, true);
    case "pause": await call("scan_control", "pause"); await refreshState(); return render();
    case "resume": await call("scan_control", "resume"); await refreshState(); render(); return poll();
    case "cancelscan": await call("scan_control", "cancel"); return;
    case "canceltool": await call("cancel"); return go("place");
    case "openfolder": return call("open_folder", d.path);
    case "ask": return askPlan(d.kind);
    case "yes": return confirmPlan();
    case "no": S.act = { phase: "idle", plan: null }; return render();
    case "ok": S.act = { phase: "idle", plan: null }; call("clear_job"); return render();
    case "undo": return startUndo(d.batch);
    case "openbin": return call("open_recycle_bin");
    case "procs": return loadProcs();
    case "endno": S.endAsk = null; return render();
    case "endyes": { const g = S.endAsk; S.endAsk = null; const r = await call("end_processes", g.pids); if (!r.ok) { alertLine(r.why); } return loadProcs(); }
    case "toggleallow": { await call("set_allow_changes", !allowed()); await refreshState(); if (S.boot) S.boot.allow_changes = S.st.allow_changes; return render(); }
  }
});
function toggle(set, id) { set.has(id) ? set.delete(id) : set.add(id); resetAsk(); render(); }
function resetAsk() { if (S.act.phase === "ask" || S.act.phase === "error") S.act = { phase: "idle", plan: null }; }
function alertLine(msg) { S.act = { phase: "error", why: msg }; render(); }
async function loadProcs() { S.procs = null; S.endAsk = null; if (S.screen !== "procs") go("procs"); else render(); S.procs = await call("processes"); render(); }
async function afterConsent() {
  S.boot = await call("start");
  await refreshState();
  if (S.boot.start_path) return openPlace(S.boot.start_path, false);
  go("start");
}

// 换语言：后端换（以后的结果都翻好），界面重画；已经拿到的数据重新要一遍
async function setLang(lang) {
  const r = await call("set_lang", lang);
  LANG = r.lang;
  applyChrome();
  const boot = await call("start");
  S.boot = Object.assign(S.boot || {}, boot);
  await refreshState();
  if (S.path && S.view) S.view = await call("view", S.path);
  if (S.tool && S.tool.data) S.tool.data = await call("tool", S.tool.kind, S.tool.path);
  if (S.screen === "caches") S.caches = await call("caches");
  if (S.screen === "procs") S.procs = await call("processes");
  if (S.screen === "history") S.history = await call("history");
  buildBase();
  render();
}

$("mHome").addEventListener("click", () => { S.path = null; S.view = null; go("start"); });
$("mHistory").addEventListener("click", async () => { S.history = null; go("history"); S.history = await call("history"); render(); });
$("mSettings").addEventListener("click", () => go("settings"));
$("bMin").addEventListener("click", () => call("win_minimize"));
$("bMax").addEventListener("click", async () => {
  const r = await call("win_toggle_max");
  $("maxIcon").innerHTML = r && r.maxed ? '<rect x=".5" y="2.5" width="7" height="7"/><path d="M2.5 2.5V.5h7v7h-2"/>' : '<rect x=".5" y=".5" width="9" height="9"/>';
});
$("bClose").addEventListener("click", () => call("win_close"));
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if (!menu.hidden) return closeMenu();
    if (S.act.phase === "ask" || S.act.phase === "error") { S.act = { phase: "idle", plan: null }; return render(); }
    if (S.screen === "tool") return go("place");
  }
  if (e.key === "Backspace" && S.screen === "place" && S.view && S.view.crumbs.length > 1 && !e.target.closest("input,textarea")) {
    nav(S.view.crumbs[S.view.crumbs.length - 2].path);
  }
});

// ---------------------------------------------------------------- 启动：很轻，不扫任何东西
async function boot() {
  await new Promise(res => {
    if (window.pywebview && window.pywebview.api) { viaWebview = true; return res(); }
    window.addEventListener("pywebviewready", () => { viaWebview = true; res(); }, { once: true });
    setTimeout(res, 400);
  });
  S.boot = await call("start");
  LANG = S.boot.lang === "en" ? "en" : "zh";
  applyChrome();
  resize();
  let t = null;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(resize, 120); }).observe(app);
  await refreshState();
  if (!S.boot.consented) { S.screen = "consent"; return render(); }
  return afterConsent();
}
boot();
