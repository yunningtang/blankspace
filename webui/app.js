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

// ---------------------------------------------------------------- 和后端说话
let viaWebview = false;
const TOKEN = new URLSearchParams(location.search).get("token") || "";
function call(name, ...args) {
  if (viaWebview) return window.pywebview.api[name](...args);
  return fetch("/api/" + name, { method: "POST", headers: { "X-Liubai-Token": TOKEN }, body: JSON.stringify(args) })
    .then(r => r.ok ? r.json() : { error: "后端拒绝了这次请求（" + r.status + "）" });
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
const count = n => (n || 0).toLocaleString("zh-CN");
const ago = ts => { if (!ts) return ""; const s = Date.now() / 1000 - ts; return s < 90 ? "刚刚" : s < 3600 ? Math.round(s / 60) + " 分钟前" : s < 86400 ? Math.round(s / 3600) + " 小时前" : Math.round(s / 86400) + " 天前"; };
const base = p => String(p).split(/[\\/]/).filter(Boolean).pop() || p;
const base2 = p => { const parts = String(p).split(/[\\/]/).filter(Boolean); return parts.length > 1 ? parts.slice(-2).join(" / ") : (parts[0] || p); };
const allowed = () => !!(S.st ? S.st.allow_changes : S.boot && S.boot.allow_changes);

// 墨色：按“占这里的多少”分五级（在一个 2 G 的文件夹里，绝对大小没有意义）
const TIERS = [
  { min: .25, c: [32, 30, 28], label: "占这里 25% 以上" },
  { min: .10, c: [82, 79, 74], label: "10–25%" },
  { min: .04, c: [120, 116, 109], label: "4–10%" },
  { min: .015, c: [162, 158, 150], label: "1.5–4%" },
  { min: 0, c: [204, 200, 191], label: "更少" },
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
    g.font = `${ti < 2 ? 500 : 400} ${NAME[ti]}px "Noto Serif SC", "Source Han Serif SC", "SimSun", serif`;
    if (bh > NAME[ti] * 2.6 && g.measureText(name).width < bw) {
      g.fillStyle = dark ? "#F7F4EC" : "#141413"; g.fillText(name, cx, cy - NAME[ti] * .62);
      g.font = `300 ${SIZE[ti]}px "Noto Serif SC", "SimSun", serif`; g.fillStyle = dark ? "rgba(247,244,236,.72)" : "rgba(20,20,19,.62)";
      g.fillText(fmt(b.size), cx, cy + NAME[ti] * .72);
    } else {
      g.font = `300 ${SIZE[ti]}px "Noto Serif SC", "SimSun", serif`; g.fillStyle = dark ? "rgba(247,244,236,.8)" : "rgba(20,20,19,.7)";
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
function screenConsent() {
  setBlocks([], .5);
  return `<div class="big">留白</div>
    <div class="line">开始之前，先说清楚留白会做什么、不会做什么。</div>
    <ul class="promise">
      <li><b>你选了地方才会看。</b>打开时不扫描任何东西；你选一个盘或文件夹、点开始，才去读。看过的地方会记住，下次直接显示，不重复读硬盘。</li>
      <li><b>只读，直到你允许。</b>不打开“允许整理和清理”，留白只看，不移动、不删除任何文件。</li>
      <li><b>每次动手前都先问你。</b>就算允许了，每一次都会先列出要动什么、什么不会动，你点确定才开始。</li>
      <li><b>不永久删除。</b>删除只移到回收站；放不进回收站的（U 盘、太大的文件）直接不动。挪走和改名都能撤销。</li>
      <li><b>不碰系统和程序。</b>Windows、Program Files、程序数据、OneDrive 一律不动。不联网，没有广告。</li>
    </ul>
    <div class="btnrow" style="margin-top:22px">
      <button class="yes" data-act="consent" data-allow="0">先只看看</button>
      <button class="link u" data-act="consent" data-allow="1">允许整理和清理（每次仍会先问我）</button>
    </div>
    <div class="line" style="font-size:11.5px;color:var(--ink3)">以后可以在“设置”里改。</div>`;
}

// ---------------------------------------------------------------- 画面：选地方
function screenStart() {
  const b = S.boot || { drives: [], folders: [], recent: [] };
  const used = b.drives.reduce((a, d) => a + d.used, 0) || 1;
  setBlocks(b.drives.map(d => ({ key: "drive:" + d.path, kind: "dir", name: d.name, size: d.used, frac: d.used / used, path: d.path })), .42);
  const recent = (b.recent || []).map(r => `<button class="item" data-open="${esc(r.root)}"><span class="n">${esc(base(r.root) || r.root)}</span><span class="s">${fmt(r.size)}</span>
      <span class="h">${ago(r.at)}看过${r.complete ? "" : "（没看完）"} · 直接显示上次的结果</span></button>`).join("");
  return `<div class="meta">选一个地方看看</div>
    <div class="line">留白只会看你选的地方。看之前不会读任何文件。</div>
    <div class="sec"><span>磁盘</span></div>
    <div class="list">${b.drives.map(d => `<button class="item" data-open="${esc(d.path)}" data-scan="1">
        <span class="n">${esc(d.name)}${d.label ? `<span class="muted">　${esc(d.label)}</span>` : ""}${d.system ? `<span class="muted">　系统盘</span>` : ""}${d.removable ? `<span class="muted">　移动硬盘</span>` : ""}</span>
        <span class="s">剩 ${fmt(d.free)} / ${fmt(d.total)}</span>
        <span class="bar"><i style="width:${Math.round(d.used / d.total * 100)}%"></i></span></button>`).join("")}</div>
    <div class="sec"><span>常用文件夹</span></div>
    <div class="chips">${b.folders.map(f => `<button data-open="${esc(f.path)}" data-scan="1">${esc(f.name)}</button>`).join("")}<button data-act="pick">选择文件夹…</button></div>
    ${recent ? `<div class="sec"><span>上次看过</span></div><div class="list">${recent}</div>` : ""}
    <div class="sec"><span>其他</span></div>
    <div class="chips"><button data-go="caches">系统和软件缓存</button><button data-go="procs">正在运行的程序</button><button data-go="history">清理记录</button></div>
    ${allowed() ? "" : `<div class="notice">现在是“只看”模式，不会动任何文件。<button class="link" data-go="settings">去设置</button></div>`}`;
}

// ---------------------------------------------------------------- 画面：一个地方（往里走）
function screenPlace() {
  const st = S.st || {}, sc = st.scan || {}, v = S.view;
  if (sc.running) {
    setBlocks([], .5);
    return `<div class="meta">${esc(sc.root)}</div>
      <div class="big">${count(sc.count)}<small>个文件</small></div>
      <div class="line">${sc.paused ? "已暂停。" : "正在看…"}<span class="muted" style="font-size:11.5px"> ${esc(base2(sc.current || ""))}</span></div>
      <div class="line" style="font-size:11.5px;color:var(--ink3)">后台慢慢读，不拖慢电脑；只读，不改任何文件。系统文件夹不进去。</div>
      <div class="btnrow">${sc.paused ? `<button class="yes" data-act="resume">继续</button>` : `<button class="yes" data-act="pause">暂停</button>`}<button class="link u" data-act="cancelscan">取消</button></div>`;
  }
  if (!v || !v.ok) { setBlocks([], .5); return `<div class="loading">${esc((v && v.why) || st.error || "正在打开…")}</div>`; }
  const p = st.place || {};
  const total = v.size || 1;
  const drive = v.is_root && p.drive;
  setBlocks(v.items.map(x => ({ key: x.kind + ":" + x.path + (x.kind === "rest" ? ":rest" : ""), kind: x.kind, name: x.name, size: x.size, frac: x.size / (drive ? p.used || total : total), path: x.path, files: x.files, skipped: x.skipped })),
    drive && p.free ? Math.max(.36, p.free / (p.free + p.used)) : .38);
  const crumbs = `<button data-go="start">首页</button>` + v.crumbs.map((c, i) => `<span class="sep">›</span>` + (i === v.crumbs.length - 1 ? `<span class="here">${esc(c.name)}</span>` : `<button data-nav="${esc(c.path)}">${esc(c.name)}</button>`)).join("");
  const top = v.items.filter(x => x.kind !== "rest" && x.kind !== "system").slice(0, 8);
  const tools = { inspect: ["看看哪些可能不再需要", "旧安装包、已经解压过的压缩包、能重新生成的文件夹、很久没动的下载"],
    tidy: ["整理这里", "截图和录屏按月份收好，很久没碰的东西收进“归档”"],
    dupes: ["找重复的文件", "内容一模一样的，每组留一份。要读文件内容，大文件夹会久一点"],
    rename: ["按拍摄时间重命名照片", "IMG_2034、微信图片_… 这类名字改成拍摄日期"],
    versions: ["整理文件版本", "“终版”“最终版”“(1)”放在一起，留最新的"] };
  return `<div class="crumbs">${crumbs}</div>
    <div class="h1" title="${esc(v.path)}">${esc(v.name)}</div>
    <button class="pathlink" data-act="openfolder" data-path="${esc(v.path)}" title="在资源管理器中打开"><bdi>${esc(v.path)}</bdi></button>
    <div class="line">${fmt(v.size)} · ${count(v.files)} 个文件${drive ? ` · 剩 ${fmt(p.free)}` : ""}${v.skipped ? ` · ${esc(v.skipped)}` : ""}
      <span class="muted" style="font-size:11.5px">　${ago(p.at)}看的${p.complete ? "" : "（没看完）"}</span><button class="link u" data-act="rescan">重新看</button></div>
    <div class="sec"><span>这里面最大的</span><span class="muted">点进去 · 右键更多</span></div>
    <div class="list" style="max-height:34%">${top.map(x => `<button class="item ${x.kind === "dir" ? "dir" : ""}${x.skipped ? " muted" : ""}" data-item="${esc(x.path)}" data-kind="${x.kind}">
      <span class="n">${esc(x.name)}</span><span class="s">${fmt(x.size)}</span><span class="bar"><i style="width:${Math.max(1, Math.round(x.size / total * 100))}%"></i></span></button>`).join("") || `<div class="loading">这里是空的。</div>`}</div>
    <div class="sec"><span>可以做的事</span><span class="muted">都只是先看看，不会动文件</span></div>
    <div class="list">${v.tools.map(t => `<button class="item" data-tool="${t}"><span class="n">${tools[t][0]}</span><span class="s"></span><span class="h">${tools[t][1]}</span></button>`).join("")}</div>
    <div class="act" id="act"></div>`;
}

// ---------------------------------------------------------------- 画面：工具的结果
function screenTool() {
  const t = S.tool, v = S.view;
  const head = `<div class="crumbs"><button data-go="place">← ${esc(v ? v.name : "返回")}</button></div>`;
  const titles = { inspect: "可能不再需要的", tidy: "整理这里", dupes: "重复的文件", rename: "按拍摄时间重命名", versions: "整理文件版本" };
  if (!t.data) return `${head}<div class="h1">${titles[t.kind]}</div><div class="loading">正在看${t.kind === "dupes" ? "（要读文件内容，大文件夹会久一点）" : ""}…</div>
    <div class="btnrow"><button class="link u" data-act="canceltool">停下</button></div>`;
  const d = t.data;
  if (!d.ok) return `${head}<div class="loading">${esc(d.why || "出错了")}</div>`;
  let body = "", buttons = [];
  if (t.kind === "inspect") {
    const drive = S.drives && S.drives[0];
    body = `<div class="line">${d.maybe > 0 ? `约 <b>${fmt(d.maybe)}</b> 可能不再需要。` : "没发现明显不需要的东西。"}</div>` +
      d.groups.map(g => {
        const all = g.lvl === "maybe" && g.items.every(f => S.marks.has(f.id));
        return `<div class="gh"><span>${g.title}</span><span class="gs">${g.items.length} 项 · ${fmt(g.size)}</span>${g.lvl === "maybe" ? `<button class="link u" data-allmarks="1">${all ? "全不选" : "全选"}</button>` : ""}</div>` +
          g.items.map(f => {
            const m = S.marks.has(f.id), mv = S.moveMarks.has(f.id);
            const acts = g.lvl === "maybe" ? `<button class="link${m ? " on" : ""}" data-mark="${f.id}">移走</button><button class="link" data-keep="${f.id}">留着</button>`
              : g.lvl === "mine" && drive ? `<button class="link${mv ? " on" : ""}" data-move="${f.id}">挪到 ${esc(drive.name)}</button>` : "";
            return `<div class="file${g.lvl === "keep" || g.lvl === "lock" ? " muted" : ""}${m || mv ? " marked" : ""}" data-ctx="${esc(f.path)}" data-ctxkind="${f.dir ? "dir" : "file"}">
              <div class="l1"><span title="${esc(f.path)}">${esc(f.name)}</span><span>${fmt(f.size)}</span></div><div class="why">${esc(f.why)}</div>
              <div class="do">${acts}<button class="link" data-reveal="${esc(f.path)}">在文件夹中显示</button></div></div>`;
          }).join("");
      }).join("") + (d.rest && d.rest.count ? `<div class="rest">其余 ${count(d.rest.count)} 个文件 · ${fmt(d.rest.size)} · 都不大，或者看不出该怎么处理</div>` : "");
    const items = d.groups.flatMap(g => g.items), sel = items.filter(f => S.marks.has(f.id)), mv = items.filter(f => S.moveMarks.has(f.id));
    buttons = [{ kind: "files", label: "移到回收站", n: sel.length, bytes: sel.reduce((a, f) => a + f.size, 0) }];
    if (drive) buttons.push({ kind: "move", label: `挪到 ${drive.name}`, n: mv.length, bytes: mv.reduce((a, f) => a + f.size, 0) });
  } else if (t.kind === "dupes") {
    const gs = d.dupes, copies = gs.flatMap(g => g.files.filter(f => !f.keeper));
    const sizeOf = Object.fromEntries(gs.flatMap(g => g.files.map(f => [f.id, g.size])));
    const allOn = copies.length && copies.every(f => S.dupeMarks.has(f.id));
    body = `<div class="line">${gs.length ? `${gs.length} 组一模一样的文件，副本共 <b>${fmt(d.size)}</b>。每组都会留一份。` : "没有找到一模一样的文件。"}</div>` +
      (gs.length ? `<div class="gh"><span>按占用从大到小</span><span class="gs">${gs.length} 组</span><button class="link u" data-alldupes="1">${allOn ? "全不选" : "选上所有副本"}</button></div>` : "") +
      gs.map(g => `<div class="dgroup"><div class="l1"><span>${esc(g.name)}</span><span>${fmt(g.size)} × ${g.files.length}</span></div>` + g.files.map(f => f.keeper
        ? `<div class="drow keep" data-ctx="${esc(f.path)}" data-ctxkind="file"><span class="tag">留下</span><span class="w" title="${esc(f.path)}">${esc(f.where)} › ${esc(f.name)}</span><button class="link" data-reveal="${esc(f.path)}">显示</button></div>`
        : `<div class="drow${S.dupeMarks.has(f.id) ? " on" : ""}" data-ctx="${esc(f.path)}" data-ctxkind="file"><button class="link${S.dupeMarks.has(f.id) ? " on" : ""}" data-dupe="${f.id}">移走</button><span class="w" title="${esc(f.path)}">${esc(f.where)} › ${esc(f.name)}</span><button class="link" data-keeper="${g.id}" data-file="${f.id}">改留这份</button></div>`).join("") + `</div>`).join("");
    const sel = copies.filter(f => S.dupeMarks.has(f.id));
    buttons = [{ kind: "dupes", label: "移到回收站", n: sel.length, bytes: sel.reduce((a, f) => a + sizeOf[f.id], 0) }];
  } else if (t.kind === "tidy") {
    if (!S.selInit) { S.selInit = true; d.proposals.forEach(p => S.sel.add(p.id)); }
    body = `<div class="line">${d.proposals.length ? "按下面的方式分好放。只是挪位置，不删除，挪完可以撤销。" : "这里已经很整齐了。"}</div>` +
      d.proposals.map(p => { const on = S.sel.has(p.id); return `<div class="prop"><button class="row${on ? "" : " off"}" data-sel="${p.id}"><span class="dot ${on ? "on" : ""}"></span><span>${esc(p.title)}<span class="sub">${p.count} 个</span></span><span class="size">${fmt(p.size)}</span></button>
        <div class="how">${esc(p.how)}</div><div class="samples">${p.samples.map(esc).join("、")}${p.count > p.samples.length ? " ……" : ""}</div></div>`; }).join("");
    const sel = d.proposals.filter(p => S.sel.has(p.id));
    buttons = [{ kind: "tidy", label: "整理", n: sel.reduce((a, p) => a + p.count, 0), bytes: sel.reduce((a, p) => a + p.size, 0) }];
  } else if (t.kind === "rename") {
    if (!S.selInit) { S.selInit = true; d.renames.forEach(r => S.sel.add(r.id)); }
    const all = d.renames.length && d.renames.every(r => S.sel.has(r.id));
    body = `<div class="line">${d.renames.length ? `${d.renames.length} 个照片和视频的名字看不出内容，可以改成拍摄时间。只改名字，不改内容；改完可以撤销。` : "这里没有需要改名的照片和视频。"}</div>` +
      (d.renames.length ? `<div class="gh"><span>原来的名字 → 新名字</span><button class="link u" data-allsel="1">${all ? "全不选" : "全选"}</button></div>` : "") +
      d.renames.slice(0, 400).map(r => `<div class="rn" data-sel="${r.id}"><span class="dot ${S.sel.has(r.id) ? "on" : ""}"></span><span class="from">${r.where ? esc(r.where) + " › " : ""}${esc(r.from)}</span><span class="to">${esc(r.to)}</span><span class="how">按${esc(r.how)}</span></div>`).join("");
    const n = d.renames.filter(r => S.sel.has(r.id)).length;
    buttons = [{ kind: "rename", label: "改名", n, bytes: 0, noSize: true }];
  } else if (t.kind === "versions") {
    if (!S.selInit) { S.selInit = true; d.groups.forEach(g => S.sel.add(g.id)); }
    body = `<div class="line">${d.groups.length ? "同一份文件存了好几个版本。每组最新的那份留在原处，其余的收进同一个文件夹里的“旧版本”。" : "这里没有发现一份文件存了好几个版本的情况。"}</div>` +
      d.groups.map(g => { const on = S.sel.has(g.id); return `<div class="prop"><button class="row${on ? "" : " off"}" data-sel="${g.id}"><span class="dot ${on ? "on" : ""}"></span><span>留下：${esc(g.keep)}</span><span class="size">${g.older.length} 个旧版</span></button>
        <div class="samples">${g.older.map(o => esc(o.name)).join("、")}</div></div>`; }).join("");
    const sel = d.groups.filter(g => S.sel.has(g.id));
    buttons = [{ kind: "versions", label: "收起旧版本", n: sel.reduce((a, g) => a + g.older.length, 0), bytes: 0, noSize: true }];
  }
  return `${head}<div class="h1">${titles[t.kind]}</div><button class="pathlink" data-act="openfolder" data-path="${esc(t.path)}"><bdi>${esc(t.path)}</bdi></button>
    <div class="list" style="flex:1 1 auto">${body}</div><div class="act" id="act" data-buttons='${esc(JSON.stringify(buttons))}'></div>`;
}

// ---------------------------------------------------------------- 画面：缓存
function screenCaches() {
  const c = S.caches;
  const head = `<div class="crumbs"><button data-go="back">← 返回</button></div><div class="h1">系统和软件缓存</div>`;
  if (!c) return head + `<div class="loading">正在看（只看几个缓存文件夹，很快）…</div>`;
  const items = c.items, safe = items.filter(x => x.group === "系统" && !x.cost), slow = items.filter(x => !(x.group === "系统" && !x.cost));
  const row = x => `<button class="row${S.picked.has(x.key) ? "" : " off"}" data-c="${x.key}"${x.busy ? " disabled" : ""}><span class="dot ${S.picked.has(x.key) ? "on" : ""}"></span><span>${esc(x.name)}</span><span class="size">${fmt(x.size)}</span>
     <span class="note">${esc(x.note)}${x.cost ? `<br><span class="cost">代价：${esc(x.cost)}</span>` : ""}${x.busy ? `<br><span class="busy">${esc(x.busy)}开着，现在清不掉。先关掉它</span>` : ""}</span></button>`;
  const sel = items.filter(x => S.picked.has(x.key));
  return head + `<div class="line">${items.length ? `一共 ${fmt(items.reduce((a, x) => a + x.size, 0))}。` : "没有找到可以清的缓存。"}</div>
    <div class="list" style="flex:1 1 auto">
      ${safe.length ? `<div class="sec"><span>可以放心清</span><span class="muted">几乎没有代价</span></div><div class="items" style="padding-left:0">${safe.map(row).join("")}</div>` : ""}
      ${slow.length ? `<div class="sec"><span>清了会慢一阵</span><span class="muted">默认不选，看清代价再决定</span></div><div class="items" style="padding-left:0">${slow.map(row).join("")}</div>` : ""}
    </div>
    <div class="act" id="act" data-buttons='${esc(JSON.stringify([{ kind: "caches", label: "移到回收站", n: sel.length, bytes: sel.reduce((a, x) => a + x.size, 0) }]))}'></div>`;
}

// ---------------------------------------------------------------- 画面：正在运行的程序
function screenProcs() {
  const p = S.procs;
  const head = `<div class="crumbs"><button data-go="back">← 返回</button></div><div class="h1">正在运行的程序</div>`;
  if (!p) return head + `<div class="loading">正在看…</div>`;
  if (!p.ok) return head + `<div class="loading">看不到程序列表。</div>`;
  setBlocks(p.groups.slice(0, 18).map(g => ({ key: "proc:" + g.name, kind: "file", name: g.name, size: g.memory, frac: g.memory / p.used })), .42);
  const ask = S.endAsk;
  return head + `<div class="line">内存用了 <b>${fmt(p.used)}</b> / ${fmt(p.total)}（${Math.round(p.percent)}%）<button class="link u" data-act="procs">刷新</button></div>
    <div class="line" style="font-size:11.5px;color:var(--ink3)">按占用的内存从多到少。同一个程序的多个进程合成一行。Windows 自己会管理内存，一般不需要手动关；只在某个程序卡住或占得太多时再关。</div>
    <div class="list" style="flex:1 1 auto">${p.groups.map(g => `<div class="proc"><span class="n">${esc(g.name)}${g.count > 1 ? `<span class="muted">　${g.count} 个进程</span>` : ""}</span><span class="m">${fmt(g.memory)}</span><span class="m">${g.cpu}%</span>
      <span class="h">${g.can_end ? (ask && ask.name === g.name ? `<span>关掉 ${esc(g.name)}？没保存的内容会丢。</span><button class="link" data-act="endyes">关掉</button><button class="link" data-act="endno">不了</button>` : `<button class="link" data-end="${esc(g.name)}"${allowed() ? "" : " disabled title=\"先在设置里允许\""}>关掉</button>`) : `<span>${g.self ? "这是留白自己" : "系统需要，不能关"}</span>`}</span></div>`).join("")}</div>`;
}

// ---------------------------------------------------------------- 画面：清理记录、设置
function screenHistory() {
  const h = S.history;
  const head = `<div class="crumbs"><button data-go="back">← 返回</button></div><div class="h1">清理记录</div>`;
  if (!h) return head + `<div class="loading">正在读取…</div>`;
  const recs = h.records, batches = h.batches;
  const verb = r => !r.ok ? "没有动：" + esc(r.error) : r.action === "trash" ? "移到回收站" : r.action === "undo" ? "放回原处" : "挪到 " + esc(base2(r.dst || ""));
  return head + `<div class="line">${recs.length ? "移到回收站的，到回收站里右键“还原”；挪走、改名、整理的，可以在这里撤销。" : "还没有清理过。"}</div>
    <div class="list" style="flex:1 1 auto">${batches.length ? `<div class="sec"><span>最近的挪动和改名</span></div>` + batches.map(x => `<div class="file"><div class="l1"><span>${esc((x.time || "").replace("T", " "))}</span><span>${x.count} 项</span></div>
      <div class="do">${x.undoable ? `<button class="link u" data-act="undo" data-batch="${x.batch}">撤销这一批</button>` : `<span class="muted">已撤销</span>`}</div></div>`).join("") : ""}
    ${recs.length ? `<div class="sec"><span>每一项</span></div>` + recs.map(r => `<div class="file${r.ok ? "" : " muted"}" data-ctx="${esc(r.ok && r.action !== "trash" ? r.dst || r.path : r.path)}" data-ctxkind="file">
      <div class="l1"><span title="${esc(r.path)}">${esc(base2(r.path))}</span><span>${r.size ? fmt(r.size) : ""}</span></div>
      <div class="why">${esc((r.time || "").replace("T", " "))} · ${verb(r)}</div></div>`).join("") : ""}</div>
    <div class="act" id="act" data-buttons="[]"></div>
    <div class="btnrow"><button class="link u" data-act="openbin">打开回收站</button></div>`;
}

function screenSettings() {
  const on = allowed();
  return `<div class="crumbs"><button data-go="back">← 返回</button></div><div class="h1">设置</div>
    <div class="switch" role="switch" aria-checked="${on}" data-act="toggleallow" tabindex="0"><span class="k"></span><span><span class="t">允许留白整理和清理文件</span>
      <div class="d">关着时留白只看：不移到回收站、不移动、不改名、不关程序。打开以后，每一次动手前仍然会先告诉你要动什么，你点确定才开始。</div></span></div>
    <div class="sec"><span>留白的东西存在哪</span></div>
    <div class="line" style="font-size:12px">清理记录、设置和扫描结果都在 <code>%LOCALAPPDATA%\\Liubai</code>。卸载留白时不会删它们，由你决定。</div>
    <div class="sec"><span>右键菜单</span></div>
    <div class="line" style="font-size:12px">安装版会在资源管理器的右键菜单里加一项“用留白看看这里”（Windows 11 在“显示更多选项”里）。卸载时会一起去掉。</div>`;
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

// ---------------------------------------------------------------- 操作区
function renderAct(el, buttons) {
  const a = S.act, job = S.st && S.st.job;
  if (a.phase === "checking") { el.innerHTML = `<div class="card"><p>正在检查每一项…</p></div>`; return; }
  if (a.phase === "error") { el.innerHTML = `<div class="card"><p class="lead">${esc(a.why)}</p><div class="btns">${a.why && a.why.includes("设置") ? `<button class="yes" data-go="settings">去设置</button>` : ""}<button class="link u" data-act="no">好</button></div></div>`; return; }
  if (a.phase === "ask" && a.plan) {
    const p = a.plan;
    if (!p.count) { el.innerHTML = `<div class="card"><p class="lead">这些都不能动。</p>${refusedList(p)}<div class="btns"><button class="link u" data-act="no">好</button></div></div>`; return; }
    const lead = p.type === "move"
      ? ({ 整理: `整理 ${p.count} 个文件。`, 改名: `给 ${p.count} 个文件改名。`, 收起旧版本: `把 ${p.count} 个旧版本收进“旧版本”文件夹。` }[p.label] || `把 ${p.count} 项挪走，共 <b>${fmt(p.total)}</b>。`)
      : `把 ${p.count} 项移到回收站，共 <b>${fmt(p.total)}</b>。`;
    const yes = p.type === "move" ? (p.label || "挪走") : "移到回收站";
    el.innerHTML = `<div class="card" role="group" aria-label="确认"><p class="lead">${lead}</p>
      ${p.then.map(x => `<p>${esc(x)}</p>`).join("")}
      ${p.type === "move" ? `<p class="fine">做完以后可以一键撤销，放回原处、改回原名。</p>` : ""}
      ${p.refused_count ? refusedList(p) : ""}${p.warnings.map(w => `<p class="fine">${esc(w)}</p>`).join("")}
      <div class="btns"><button class="yes" data-act="yes">${yes}</button><button class="link u" data-act="no">再想想</button></div></div>`;
    return;
  }
  if (job && (a.phase === "running" || a.phase === "done")) {
    if (job.running) {
      const pc = job.count ? Math.round((job.index + 1) / job.count * 100) : 0;
      el.innerHTML = `<div class="card"><p>${job.kind === "recycle" ? "正在移到回收站" : job.kind === "undo" ? "正在放回原处" : "正在挪"} ${Math.min(job.index + 1, job.count)} / ${job.count}</p><div class="progress"><i style="width:${pc}%"></i></div></div>`;
      return;
    }
    const failed = job.failed.length ? `<details><summary>${job.failed.length} 项没有动</summary><ul>${job.failed.map(([p, w]) => `<li>${esc(base(p))}：${esc(w)}</li>`).join("")}</ul></details>` : "";
    el.innerHTML = job.kind === "recycle"
      ? `<div class="card"><p class="lead">已移到回收站 ${job.moved} 项，共 <b>${fmt(job.trashed)}</b>。</p><p class="fine">清空回收站后，这些空间才会空出来。想找回，也在回收站里。</p>${failed}
         <div class="btns"><button class="yes" data-act="openbin">打开回收站</button><button class="link u" data-act="ok">好</button></div></div>`
      : job.kind === "undo"
        ? `<div class="card"><p class="lead">已放回原处 ${job.moved} 项。</p>${failed}<div class="btns"><button class="yes" data-act="ok">好</button></div></div>`
        : `<div class="card"><p class="lead">做好了 ${job.moved} 项。</p><p class="fine">想放回原处，点撤销；以后也可以在“清理记录”里撤销。</p>${failed}
           <div class="btns">${job.undoable ? `<button class="yes" data-act="undo" data-batch="${job.batch}">撤销</button>` : ""}<button class="link u" data-act="ok">好</button></div></div>`;
    return;
  }
  const busy = S.st && ((S.st.scan && S.st.scan.running) || (job && job.running));
  el.innerHTML = buttons.filter(b => b.n || buttons.length === 1).map(b =>
    `<button class="go" data-act="ask" data-kind="${b.kind}"${b.n && !busy ? "" : " disabled"}>${b.label}${b.n ? `（${b.n} 项${b.noSize ? "" : " · " + fmt(b.bytes)}）` : ""}</button>`).join("")
    + (allowed() || !buttons.length ? "" : `<div class="fine" style="font-size:11.5px;color:var(--ink3)">现在是只看模式，点了会提示你去设置里打开。</div>`);
}
function refusedList(p) {
  return `<details><summary>另有 ${p.refused_count} 项不会动</summary><ul>${p.refused.map(([x, w]) => `<li>${esc(base(x))}：${esc(w)}</li>`).join("")}</ul></details>`;
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
  if (!r.started) { S.act = { phase: "error", why: r.why || "没有开始" }; render(); return; }
  S.act = { phase: "running", plan: S.act.plan };
  if (S.target && S.shapes[S.target.key]) { const s = S.shapes[S.target.key]; ripples.push({ x: s.reduce((a, p) => a + p[0], 0) / s.length, y: s.reduce((a, p) => a + p[1], 0) / s.length, t: performance.now() }); paint(); }
  S.marks.clear(); S.moveMarks.clear(); S.dupeMarks.clear();
  render(); poll();
}
async function startUndo(batch) {
  const r = await call("undo", batch);
  if (!r.started) { S.act = { phase: "error", why: r.why || "没法撤销" }; render(); return; }
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
  const dis = can ? "" : ` disabled title="先在设置里允许整理和清理"`;
  const items = [];
  if (t.kind === "dir") items.push(`<button data-m="enter">进去看看</button>`, `<button data-m="openfolder">在资源管理器中打开</button>`);
  if (t.kind === "file") items.push(`<button data-m="openfile">打开</button>`, `<button data-m="reveal">在文件夹中显示</button>`);
  if (t.kind === "rest" || t.kind === "system") items.push(`<button data-m="openfolder">在资源管理器中打开</button>`);
  if (t.kind === "dir" || t.kind === "file") {
    items.push(`<button data-m="copy">复制路径</button>`);
    if (t.kind === "dir") items.push(`<hr><button data-m="inspect">看看哪些可能不再需要</button>`);
    items.push(`<hr><button data-m="trash"${dis}>移到回收站…</button>`);
    if (drive) items.push(`<button data-m="move"${dis}>挪到 ${esc(drive.name)}…</button>`);
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
  const done = () => { const sl = $("slip"); sl.innerHTML = "已复制路径"; sl.style.left = "50%"; sl.style.top = (H - 60) + "px"; sl.classList.add("on"); setTimeout(() => sl.classList.remove("on"), 1200); };
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
  const tip = b.kind === "dir" ? "点一下进去 · 右键更多" : b.kind === "file" ? "右键：打开、在文件夹中显示…" : b.kind === "system" ? "Windows、程序和没权限看的地方" : "";
  slip.innerHTML = `${esc(b.name)}　${fmt(b.size)}${b.files > 1 ? `<em>${count(b.files)} 个文件</em>` : ""}${b.skipped ? `<em>${esc(b.skipped)}</em>` : ""}<span class="tip">${tip}</span>`;
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
    case "pick": { const r = viaWebview ? await call("pick_folder") : { path: prompt("文件夹路径") }; if (r && r.path) openPlace(r.path, false); return; }
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
  resize();
  let t = null;
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(resize, 120); }).observe(app);
  S.boot = await call("start");
  await refreshState();
  if (!S.boot.consented) { S.screen = "consent"; return render(); }
  return afterConsent();
}
boot();
