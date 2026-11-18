/* 留白介绍页。ink.js（和程序共用的纸墨几何、纹理）先加载，这里画首屏的演示和处理语言、下载链接。 */
"use strict";
const PAPER = "#FCFBF8";               // ink.js 的 buildPaper 用
const REPO = "yunningtang/blankspace";
const $ = id => document.getElementById(id);
const root = document.documentElement;

// ---------------------------------------------------------------- 语言
let LANG = "zh";
const L = (zh, en) => LANG === "en" ? en : zh;
function pickLang() {
  try { const s = localStorage.getItem("blankspace-lang"); if (s === "zh" || s === "en") return s; } catch (e) { /* 无痕模式等 */ }
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "zh" || q === "en") return q;
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}
function setLang(l) {
  LANG = l;
  root.dataset.lang = l;
  root.lang = l === "en" ? "en" : "zh-CN";
  document.title = L("留白 · Blankspace — 安静的 Windows 磁盘清理", "Blankspace · 留白 — a calm disk cleaner for Windows");
  try { localStorage.setItem("blankspace-lang", l); } catch (e) { /* 忽略 */ }
  document.querySelectorAll("img[data-shot]").forEach(img => {
    img.src = (l === "en" ? "img/en/" : "img/") + img.dataset.shot + ".jpg";
    img.alt = img.closest(".feat").querySelector(`h3 [lang="${l}"]`).textContent;
  });
  renderRelease();
  demo.render();
}
$("langBtn").addEventListener("click", () => setLang(LANG === "en" ? "zh" : "en"));

// ---------------------------------------------------------------- 最新版本：按钮直接下载
let release = null;
const mb = b => (b / 1024 / 1024).toFixed(0) + " MB";
function renderRelease() {
  if (!release) return;
  const assets = release.assets || [];
  const setup = assets.find(a => /Setup.*\.exe$/i.test(a.name)), port = assets.find(a => /portable.*\.zip$/i.test(a.name));
  document.querySelectorAll('[data-dl="setup"]').forEach(a => { if (setup) a.href = setup.browser_download_url; });
  document.querySelectorAll('[data-dl="portable"]').forEach(a => { if (port) a.href = port.browser_download_url; });
  document.querySelectorAll('[data-size="setup"]').forEach(s => { s.textContent = setup ? mb(setup.size) : ""; });
  document.querySelectorAll('[data-size="portable"]').forEach(s => { s.textContent = port ? mb(port.size) : ""; });
  const d = new Date(release.published_at);
  $("dlVer").textContent = L(`${release.tag_name} · ${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日发布`,
    `${release.tag_name} · released ${d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`);
}
fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
  .then(r => r.ok ? r.json() : null).then(j => { if (j && j.tag_name) { release = j; renderRelease(); } })
  .catch(() => { /* 拿不到就用默认链接：Releases 页 */ });

// ---------------------------------------------------------------- 首屏演示：一块 C 盘
// 一键清理的真实流程：清掉的先进回收站（纸不变大）→ 你自己清空回收站 → 纸才变大。
const GB = 1024 ** 3;
const DATA = [
  { k: "sys", zh: "Windows 和程序", en: "Windows & programs", g: 41, kind: "system" },
  { k: "wx", zh: "微信聊天文件", en: "WeChat files", g: 22 },
  { k: "video", zh: "视频", en: "Videos", g: 17 },
  { k: "code", zh: "代码项目", en: "Code projects", g: 9.5 },
  { k: "dl", zh: "下载", en: "Downloads", g: 7.2 },
  { k: "pics", zh: "图片", en: "Pictures", g: 5.1 },
  { k: "temp", zh: "临时文件", en: "Temporary files", g: 7.6, cache: true },
  { k: "err", zh: "错误报告", en: "Error reports", g: 2.4, cache: true },
  { k: "thumb", zh: "缩略图缓存", en: "Thumbnail cache", g: 1.6, cache: true },
];
const TOTAL = 168, CACHE = DATA.filter(d => d.cache).reduce((a, d) => a + d.g, 0);
const TIERS = [[.25, [32, 30, 28]], [.10, [82, 79, 74]], [.04, [120, 116, 109]], [.015, [162, 158, 150]], [0, [204, 200, 191]]];

const cv = $("ink"), g = cv.getContext("2d");
var ctx = g;                                  // ink.js 的 trace 用全局 ctx
const demo = {
  stage: 0,                                   // 0 原样，1 已移到回收站，2 已清空回收站
  shapes: {}, blocks: [], hover: null, dpr: 1, base: document.createElement("canvas"),
  items() {
    const used = DATA.filter(d => !(d.cache && this.stage > 0));
    if (this.stage === 1) used.push({ k: "bin", zh: "回收站", en: "Recycle Bin", g: CACHE, bin: true });
    return used;
  },
  free() { return TOTAL - this.items().reduce((a, d) => a + d.g, 0); },
  layout() {
    const r = cv.getBoundingClientRect();
    if (!r.width) return;
    this.dpr = Math.min(2, devicePixelRatio || 1);
    W = r.width; H = r.height; portrait = false;
    cv.width = this.base.width = Math.round(W * this.dpr); cv.height = this.base.height = Math.round(H * this.dpr);
    if (!paperTex || paperTex.width < W + 40 || paperTex.height < H + 40) {
      paperTex = buildPaper(Math.round(W) + 40, Math.round(H) + 40); washTex = buildWash(Math.round(W) + 40, Math.round(H) + 40);
    }
    this.draw();
  },
  draw() {
    const b = this.base.getContext("2d"), dpr = this.dpr;
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    const items = this.items(), used = items.reduce((a, d) => a + d.g, 0), free = TOTAL - used;
    const all = [[0, 0], [W, 0], [W, H], [0, H]];
    const [paperPoly, rest] = split(all, Math.max(.16, free / TOTAL), .12);
    const sorted = items.map(d => ({ k: d.k, v: d.g })).sort((a, c) => c.v - a.v);
    const raw = {}; layoutTree(buildTree(sorted, rng(20261118)), rest, raw, k => items.find(d => d.k === k).g);
    const shapes = {};
    for (const d of items) if (raw[d.k] && raw[d.k].length > 2) shapes[d.k] = wobble(raw[d.k], 3);
    this.shapes = shapes; this.blocks = items;
    const tone = d => d.kind === "system" ? [212, 208, 200] : d.bin ? [150, 146, 139] : TIERS.find(t => d.g / used >= t[0])[1];
    const tr = pts => { b.beginPath(); pts.forEach((p, i) => i ? b.lineTo(p[0], p[1]) : b.moveTo(p[0], p[1])); b.closePath(); };
    b.clearRect(0, 0, W, H);
    b.drawImage(paperTex, 0, 0);
    b.save(); b.globalCompositeOperation = "multiply";
    for (const d of items) { const s = shapes[d.k]; if (!s) continue; tr(s); b.fillStyle = `rgb(${tone(d)})`; b.fill(); }
    b.restore();
    b.save(); b.beginPath();
    for (const k in shapes) { shapes[k].forEach((p, i) => i ? b.lineTo(p[0], p[1]) : b.moveTo(p[0], p[1])); b.closePath(); }
    b.clip(); b.globalCompositeOperation = "soft-light"; b.globalAlpha = .45; b.drawImage(washTex, -20, -20); b.restore();
    for (const d of items) {
      const s = shapes[d.k]; if (!s) continue;
      b.save(); tr(s); b.clip();
      for (const [w, a] of [[12, .03], [4, .06]]) { b.lineWidth = w; b.strokeStyle = `rgba(10,9,8,${a})`; tr(s); b.stroke(); }
      b.restore();
      if (d.bin) { b.save(); tr(s); b.setLineDash([5, 5]); b.strokeStyle = "rgba(252,251,248,.55)"; b.lineWidth = 1.2; b.stroke(); b.restore(); }
    }
    const pw = wobble(paperPoly, 3).map(([x, y]) => [x <= .5 ? -30 : x >= W - .5 ? W + 30 : x, y <= .5 ? -30 : y >= H - .5 ? H + 30 : y]);
    b.save(); tr(pw); b.clip(); b.drawImage(paperTex, 0, 0); b.restore();
    b.save(); tr(pw); b.clip(); b.lineWidth = 12; b.strokeStyle = "rgba(60,56,50,.08)"; tr(pw); b.stroke(); b.restore();
    // 标签
    const font = (w, s) => `${w} ${s}px ${LANG === "en" ? '"EB Garamond", Georgia, serif' : '"Noto Serif SC", "SimSun", serif'}`;
    b.textAlign = "center"; b.textBaseline = "middle";
    for (const d of items) {
      const s = shapes[d.k]; if (!s) continue;
      const xs = s.map(p => p[0]), ys = s.map(p => p[1]);
      const bw = (Math.max(...xs) - Math.min(...xs)) * .78, bh = (Math.max(...ys) - Math.min(...ys)) * .7;
      const cx = xs.reduce((a, x) => a + x, 0) / xs.length, cy = ys.reduce((a, y) => a + y, 0) / ys.length;
      const dark = tone(d)[0] < 128, big = d.g / used > .1, name = L(d.zh, d.en), size = d.g >= 10 ? d.g.toFixed(0) + " G" : d.g.toFixed(1) + " G";
      b.font = font(big ? 500 : 400, big ? 17 : 13.5);
      if (bh > 40 && b.measureText(name).width < bw) {
        b.fillStyle = dark ? "#F7F4EC" : "#141413"; b.fillText(name, cx, cy - 9);
        b.font = font(300, 12); b.fillStyle = dark ? "rgba(247,244,236,.72)" : "rgba(20,20,19,.6)"; b.fillText(size, cx, cy + 11);
      }
    }
    // 纸上写可用空间
    const px = Math.min(...paperPoly.map(p => p[0])) + 22, py = Math.min(...paperPoly.map(p => p[1])) + 34;
    b.textAlign = "left"; b.fillStyle = "#141413"; b.font = font(300, 40);
    b.fillText(`${free.toFixed(0)} G`, px, py + 6);
    b.font = font(400, 13); b.fillStyle = "rgba(20,20,19,.55)";
    b.fillText(L("可用 · 这张纸", "free · the paper"), px + 2, py + 36);
    this.paint();
  },
  paint() {
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); g.drawImage(this.base, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const s = this.hover && this.shapes[this.hover];
    if (s) { g.beginPath(); s.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); g.fillStyle = "rgba(252,251,248,.12)"; g.fill(); }
  },
  render() {
    const btn = $("demoBtn"), msg = $("demoMsg"), reset = $("demoReset");
    if (this.stage === 0) {
      msg.textContent = L("墨越深，占得越多。浅色的三块是临时文件、错误报告和缩略图——可以放心清。", "Darker ink takes more space. The three light patches are temporary files, error reports and thumbnails: safe to clean.");
      btn.textContent = L("试试一键清理", "Try One-click clean");
    } else if (this.stage === 1) {
      msg.textContent = L(`已移到回收站 ${CACHE.toFixed(1)} G。纸还没变大：清空回收站后，空间才会空出来。这一步留给你。`, `${CACHE.toFixed(1)} G moved to the Recycle Bin. The paper hasn’t grown yet: the space comes back when you empty the Recycle Bin, and that step is yours.`);
      btn.textContent = L("清空回收站（你自己来）", "Empty the Recycle Bin (your call)");
    } else {
      msg.textContent = L(`纸多了 ${CACHE.toFixed(1)} G。留白从不替你清空回收站，也从不永久删除。`, `The paper grew by ${CACHE.toFixed(1)} G. Blankspace never empties the Recycle Bin for you, and never deletes permanently.`);
      btn.textContent = "";
    }
    btn.hidden = this.stage === 2; reset.hidden = this.stage === 0;
    if (W) this.draw();
  },
};
$("demoBtn").addEventListener("click", () => { demo.stage = Math.min(2, demo.stage + 1); demo.render(); });
$("demoReset").addEventListener("click", () => { demo.stage = 0; demo.render(); });
const tip = $("tip");
cv.addEventListener("mousemove", e => {
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  let hit = null;
  for (const k in demo.shapes) if (inside(demo.shapes[k], x, y)) hit = k;
  if (hit !== demo.hover) { demo.hover = hit; demo.paint(); }
  if (!hit) { tip.hidden = true; return; }
  const d = demo.blocks.find(b => b.k === hit);
  const why = d.cache ? L("可以放心清", "safe to clean") : d.bin ? L("还占着空间", "still takes space") : d.kind === "system" ? L("留白不碰", "never touched") : L("你的文件", "your files");
  tip.innerHTML = `${L(d.zh, d.en)} · ${d.g >= 10 ? d.g.toFixed(0) : d.g.toFixed(1)} G<em>${why}</em>`;
  tip.hidden = false;
  tip.style.left = Math.min(x + 14, r.width - tip.offsetWidth - 4) + "px"; tip.style.top = (y + 16) + "px";
});
cv.addEventListener("mouseleave", () => { demo.hover = null; tip.hidden = true; demo.paint(); });

// ---------------------------------------------------------------- 纸纹背景、顶栏、浮现
function paperBackground() {
  try {
    const c = buildPaper(520, 520);
    document.body.style.backgroundImage = `url(${c.toDataURL("image/png")})`;
  } catch (e) { /* 只是纹理，没有也行 */ }
}
addEventListener("scroll", () => document.querySelector(".top").classList.toggle("scrolled", scrollY > 8), { passive: true });
const io = "IntersectionObserver" in window ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px" }) : null;
document.querySelectorAll(".tenets > div, .feat, .promise li, .steps li").forEach(el => { if (io) { el.classList.add("reveal"); io.observe(el); } });

let rt = null;
new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => demo.layout(), 100); }).observe(cv);
setLang(pickLang());
paperBackground();
(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => demo.layout());
