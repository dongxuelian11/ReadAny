/**
 * Quant pack build (LIB-3): turn the pinned Datawhale "quant-for-beginners"
 * Chinese notebooks into ONE readable EPUB ("金融量化入门（中文学习包）") that the
 * existing catalog/importBooks/Reader pipeline ships and opens directly.
 *
 * Hard rules enforced here:
 *  - Pinned source: datawhalechina/quant-for-beginners @ b385684e (MIT).
 *  - NOTHING is executed: notebook code and outputs are converted to STATIC
 *    XHTML. Dynamic outputs (widgets/JS) are replaced by an honest note.
 *  - No notebook JS/HTML reaches a privileged WebView: <script>/<iframe>/
 *    event handlers are stripped from every fragment before packaging.
 *  - Images are embedded from the pinned repo (fuzzy name resolution, since
 *    the notebooks' markdown references do not match exact filenames) and
 *    downscaled at build time so the installer stays small.
 *  - Formulas are rendered to MathML via KaTeX (no JS in the book).
 *  - The appendix chapter is OUR OWN synthetic-data walkthrough (fixed seed,
 *    signal shift, explicit fees) — clearly marked as self-authored, never
 *    attributed to Datawhale, and NOT a performance promise.
 *  - The eight original chapters are NOT counted as eight published books:
 *    the catalog ships ONE bundled learning-pack edition.
 *
 * What this script does:
 *  1. build scripts/quant/out/quant-for-beginners-zh.epub (+ build report)
 *  2. verify the EPUB structurally (same checks family as catalog build-seed)
 *  3. upsert the bundled edition row into catalog-seed/catalog.sqlite,
 *     copy the EPUB into catalog-seed/books/, bump meta.built_at and rewrite
 *     manifest.json (adds db sha256/size for seed.ts integrity checking)
 *
 * Usage: node scripts/quant/build-quant-pack.mjs [--db-only]
 *   --db-only: skip the (cached) fetch/convert and only re-run DB integration
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync, zipSync } from "fflate";
import * as katex from "katex";
import { marked } from "marked";
import sharp from "sharp";
import { buildCatalogIndexText } from "../../packages/core/src/catalog/normalize.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const OUT_DIR = path.join(__dirname, "out");
const CACHE_DIR = path.join(__dirname, "cache");
const SEED_DIR = path.join(ROOT, "packages", "app", "src-tauri", "resources", "catalog-seed");
const BOOKS_DIR = path.join(SEED_DIR, "books");

const REPO = "datawhalechina/quant-for-beginners";
const PIN = "b385684ee100813ebfb35f738cfcbcb6d96e356a";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${PIN}`;
const LICENSE_URL = `https://github.com/${REPO}/blob/${PIN}/LICENSE`;
const LANDING_URL = `https://github.com/${REPO}/tree/${PIN}`;
const CATALOG_EDITION_ID = "curated:quant-for-beginners-zh";
const EPUB_FILE = "quant-for-beginners-zh.epub";

const CHAPTERS = [
  { dir: "phase1_intro", file: "01_什么是量化金融.ipynb", title: "第一章 什么是量化金融" },
  { dir: "phase1_intro", file: "02_你的第一个量化实验.ipynb", title: "第二章 你的第一个量化实验" },
  { dir: "phase1_intro", file: "03_移动平均线策略.ipynb", title: "第三章 移动平均线策略" },
  { dir: "phase1_intro", file: "04_策略回测.ipynb", title: "第四章 策略回测" },
  { dir: "phase2_intro", file: "01_理解波动率.ipynb", title: "第五章 理解波动率" },
  { dir: "phase2_intro", file: "02_夏普比率与Beta.ipynb", title: "第六章 夏普比率与 Beta" },
  { dir: "phase2_intro", file: "03_最大回撤与仓位管理.ipynb", title: "第七章 最大回撤与仓位管理" },
  { dir: "phase2_intro", file: "04_多标的组合与相关性.ipynb", title: "第八章 多标的组合与相关性" },
];

/** Actual image/data files shipped next to the notebooks (from the pinned tree). */
const REPO_DIR_FILES = {
  phase1_intro: [
    "Edward Thorp.jpg",
    "Edward Thorp2.jpg",
    "Louis Bachelier.jpg",
    "Simons1st.jpg",
    "Simons2nd.jpg",
    "quant-diagram.png",
    "yibo quant.jpg",
    "yibo-quant.jpg",
  ],
  phase2_intro: [
    "Benoit Mandelbrot.jpg",
    "Harry Markowitz.jpg",
    "Robert Engle.jpg",
    "yibo quant.jpg",
  ],
};

const DB_ONLY = process.argv.includes("--db-only");

// ── small helpers ───────────────────────────────────────────────────────────

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function fetchRepoFile(repoPath) {
  const cachePath = path.join(CACHE_DIR, repoPath.replace(/[\\/]/g, "__"));
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath);
  const res = await fetch(`${RAW_BASE}/${repoPath.split("/").map(encodeURIComponent).join("/")}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${repoPath}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(cachePath, buf);
  return buf;
}

/** The notebooks reference images by names that often drop spaces
 * ("Edward Thorp.jpg" → "Thorp.jpg"). Resolve by normalized basename with a
 * suffix fallback; unresolved references render as an honest note. */
function resolveRepoImage(dir, ref) {
  const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const base = norm(path.posix.basename(ref));
  const candidates = REPO_DIR_FILES[dir] || [];
  return (
    candidates.find((c) => norm(c) === base) ??
    candidates.find((c) => norm(c).endsWith(base) || base.endsWith(norm(c)))
  );
}

// ── images (build-time downscale, deduped by content hash) ─────────────────

const images = new Map(); // hash → { href, bytes, ext }
let imageCounter = 0;

async function addImage(buf, ext) {
  const hash = sha256(buf);
  if (images.has(hash)) return images.get(hash).href;
  // Downscale huge diagrams/photos; keep transparency for alpha PNGs.
  const img = sharp(buf, { failOn: "none" });
  const meta = await img.metadata();
  let outBuf = buf;
  let outExt = ext.replace(/^jpe?g$/i, "jpg");
  if ((meta.width || 0) > 1500 || buf.length > 400_000) {
    if (meta.hasAlpha) {
      outBuf = await img.resize({ width: 1400, withoutEnlargement: true }).png().toBuffer();
      outExt = "png";
    } else {
      outBuf = await img
        .resize({ width: 1400, withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      outExt = "jpg";
    }
  }
  imageCounter += 1;
  const href = `images/img${String(imageCounter).padStart(3, "0")}.${outExt}`;
  images.set(hash, { href, bytes: outBuf });
  return href;
}

// ── markdown → XHTML (math via KaTeX→MathML, images via repo fetch) ────────

function renderMath(tex, displayMode) {
  return katex.renderToString(tex, {
    output: "mathml",
    displayMode,
    throwOnError: false,
    strict: false,
  });
}

/** Replace LaTeX in non-code text with placeholders BEFORE marked runs. */
function extractMath(markdown) {
  const mathSpans = [];
  const protect = (tex, display) => {
    mathSpans.push(renderMath(tex, display));
    return `QQMATH${mathSpans.length - 1}QQ`;
  };
  let out = markdown.replace(/\\\[([\s\S]*?)\\\]/g, (_, tex) => protect(tex.trim(), true));
  out = out.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => protect(tex.trim(), true));
  out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_, tex) => protect(tex.trim(), false));
  // Inline $…$ must not span lines and must not be a currency price ($100).
  out = out.replace(/(?<![\w$])\$(?!\s)([^\n$]{1,200}?)(?<!\s)\$(?![\w$])/g, (_, tex) =>
    protect(tex.trim(), false),
  );
  return { html: out, mathSpans };
}

function sanitizeHtmlFragment(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe\b[\s\S]*?(<\/iframe>|\/>)/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "blocked:");
}

function markdownToXhtml(markdown, _dir) {
  // 1) rewrite image references (markdown + raw <img>) to numeric tokens;
  //    actual repo fetch + downscale happens later (async) in resolveImageTokens
  const imgTokens = [];
  let md = markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (all, alt, ref) => {
    const clean = decodeURIComponent(ref.trim().replace(/^\.?\//, ""));
    if (clean.startsWith("attachment:") || clean.startsWith("data:")) return all;
    imgTokens.push({ alt, ref: clean });
    return `![${alt}](imgtok${imgTokens.length - 1}endtok)`;
  });
  md = md.replace(/<img([^>]*?)src="([^"]+)"([^>]*)>/g, (all, pre, ref, post) => {
    const clean = decodeURIComponent(ref.trim().replace(/^\.?\//, ""));
    if (clean.startsWith("data:")) return all;
    imgTokens.push({ alt: "", ref: clean });
    return `<img${pre}src="imgtok${imgTokens.length - 1}endtok"${post}>`;
  });

  // 2) math placeholders
  const { html: mdWithMath, mathSpans } = extractMath(md);

  // 3) markdown → HTML (numbered image tokens survive as src="imgtokNendtok")
  let html = marked.parse(mdWithMath, { async: false });

  // 4) substitute math tokens
  html = html.replace(/QQMATH(\d+)QQ/g, (_, i) => mathSpans[Number(i)]);

  return { html, imgTokens };
}

/** Resolve image tokens (async: fetch + downscale) and swap real hrefs. */
async function resolveImageTokens(html, imgTokens, dir) {
  let out = html;
  for (let i = 0; i < imgTokens.length; i++) {
    const tok = imgTokens[i];
    const actual = resolveRepoImage(dir, tok.ref);
    if (!actual) {
      out = out.replaceAll(
        new RegExp(`<img[^>]*src="imgtok${i}endtok"[^>]*/?>`, "g"),
        `<span class="dynnote">[图未收录：${escapeXml(tok.ref)}]</span>`,
      );
      continue;
    }
    const buf = await fetchRepoFile(`notebooks/${dir}/${actual}`);
    const href = await addImage(buf, path.posix.extname(actual).slice(1));
    out = out.replaceAll(`src="imgtok${i}endtok"`, `src="${href}"`);
  }
  return out;
}

/** Notebook → XHTML body string. */
async function notebookToXhtml(chapter) {
  const buf = await fetchRepoFile(`notebooks/${chapter.dir}/${chapter.file}`);
  const nb = JSON.parse(buf.toString("utf8"));
  const parts = [];
  for (const cell of nb.cells) {
    const src = Array.isArray(cell.source) ? cell.source.join("") : cell.source || "";
    if (cell.cell_type === "markdown") {
      const converted = markdownToXhtml(src, chapter.dir);
      const html = await resolveImageTokens(converted.html, converted.imgTokens, chapter.dir);
      // sanitize drops scripts/iframes; toXhtml makes marked's HTML5 output
      // XML-well-formed (self-closed voids, escaped ampersands) — EPUB XHTML
      // is parsed as XML by the reader.
      parts.push(toXhtml(sanitizeHtmlFragment(html)));
    } else if (cell.cell_type === "code") {
      parts.push(
        `<div class="codeblock"><div class="codelabel">代码（静态展示，不可执行）</div><pre><code>${escapeXml(src)}</code></pre></div>`,
      );
      for (const out of cell.outputs || []) {
        if (out.output_type === "stream") {
          const text = Array.isArray(out.text) ? out.text.join("") : out.text || "";
          parts.push(`<pre class="out">${escapeXml(text)}</pre>`);
        } else if (out.output_type === "error") {
          const text = `${out.ename || ""}: ${out.evalue || ""}`;
          parts.push(`<pre class="err">${escapeXml(text)}</pre>`);
        } else {
          const data = out.data || {};
          if (data["text/html"]) {
            const raw = Array.isArray(data["text/html"])
              ? data["text/html"].join("")
              : data["text/html"];
            parts.push(`<div class="htoutput">${toXhtml(sanitizeHtmlFragment(raw))}</div>`);
          } else if (data["image/png"]) {
            const png = Buffer.from(data["image/png"], "base64");
            const href = await addImage(png, "png");
            parts.push(`<div class="figure"><img src="${href}" alt="notebook 输出图"/></div>`);
          } else if (data["text/plain"]) {
            const text = Array.isArray(data["text/plain"])
              ? data["text/plain"].join("")
              : data["text/plain"];
            parts.push(`<pre class="out">${escapeXml(text)}</pre>`);
          } else if (data["application/vnd.jupyter.widget-view+json"]) {
            parts.push(
              `<p class="dynnote">此处原为交互式控件输出，阅读包中不包含动态内容；请参考上方代码与后续静态图表。</p>`,
            );
          }
        }
      }
    }
  }
  return parts.join("\n");
}

// ── XHTML assembly helpers ─────────────────────────────────────────────────

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Make marked's HTML5 output XML-well-formed for EPUB XHTML. */
function toXhtml(html) {
  const x = html
    .replace(/<br\s*\/?>/gi, "<br/>")
    .replace(/<hr\s*\/?>/gi, "<hr/>")
    .replace(
      /<(img|input|area|col|embed|source|track|wbr)((?:"[^"]*"|[^>])*?)>/gi,
      (_all, tag, rest) => (rest.trimEnd().endsWith("/") ? `<${tag}${rest}>` : `<${tag}${rest}/>`),
    )
    // escape stray ampersands that marked left as-is
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
  return x;
}

function checkTagBalance(xhtml, label) {
  const stack = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  for (;;) {
    const m = re.exec(xhtml);
    if (!m) break;
    const tag = m[1];
    const attrs = m[2] ?? "";
    const selfClose = m[3];
    if (VOID_TAGS.has(tag.toLowerCase()) || selfClose === "/") continue;
    if (m[0].startsWith("</")) {
      const top = stack.pop();
      if (top !== tag.toLowerCase()) {
        throw new Error(
          `${label}: tag mismatch — expected </${top ?? "none"}> got </${tag.toLowerCase()}>`,
        );
      }
    } else if (!attrs.trimEnd().endsWith("/")) {
      stack.push(tag.toLowerCase());
    }
  }
  if (stack.length) throw new Error(`${label}: unclosed tags: ${stack.join(", ")}`);
}

function xhtmlDoc(title, body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>`;
}

// ── appendix: self-authored synthetic backtest (deterministic) ─────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The exact strategy shown in the appendix, run on fixed synthetic data. */
function computeSyntheticBacktest() {
  const rand = mulberry32(42);
  const gaussian = () => {
    const u = Math.max(rand(), 1e-9);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const nDays = 500;
  const s0 = 100;
  const mu = 0.08;
  const sigma = 0.2;
  const dt = 1 / 252;
  const prices = [s0];
  for (let i = 1; i < nDays; i++) {
    prices.push(
      prices[i - 1] *
        Math.exp((mu - (sigma * sigma) / 2) * dt + sigma * Math.sqrt(dt) * gaussian()),
    );
  }

  const sma = (window, idx) => {
    if (idx + 1 < window) return null;
    let sum = 0;
    for (let j = idx - window + 1; j <= idx; j++) sum += prices[j];
    return sum / window;
  };

  const FEE = 0.0005; // 0.05% per side
  const _position = 0; // 0/1 — uses YESTERDAY's signal (shift(1): no lookahead)
  let equity = 1;
  const dailyReturns = [];
  let peak = 1;
  let maxDd = 0;
  let trades = 0;
  const bhReturns = [];
  let bhPeak = 1;
  let bhMaxDd = 0;

  for (let i = 60; i < nDays; i++) {
    const fast = sma(20, i);
    const slow = sma(60, i);
    const signal = fast > slow ? 1 : 0;
    const prevSignal = i >= 61 ? (sma(20, i - 1) > sma(60, i - 1) ? 1 : 0) : 0;
    const dayRet = prices[i] / prices[i - 1] - 1;
    // cost when the POSITION (from yesterday's signal) changes today
    if (signal !== prevSignal) {
      trades++;
      equity *= 1 - FEE * Math.abs(signal - prevSignal);
    }
    equity *= 1 + dayRet * signal;
    dailyReturns.push(dayRet * signal);
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
    bhReturns.push(dayRet);
    const bhEquity = prices[i] / prices[60];
    bhPeak = Math.max(bhPeak, bhEquity);
    bhMaxDd = Math.max(bhMaxDd, 1 - bhEquity / bhPeak);
  }

  const ann = (rs) => {
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1));
    return {
      mean: mean * 252,
      sd: sd * Math.sqrt(252),
      sharpe: sd > 0 ? (mean * 252) / (sd * Math.sqrt(252)) : 0,
    };
  };
  const strat = ann(dailyReturns);
  const bh = ann(bhReturns);
  return {
    days: nDays,
    trades,
    strategyTotal: equity,
    strategyAnnRet: strat.mean,
    strategyAnnVol: strat.sd,
    strategySharpe: strat.sharpe,
    strategyMaxDd: maxDd,
    bhTotal: prices[nDays - 1] / prices[60],
    bhAnnRet: bh.mean,
    bhAnnVol: bh.sd,
    bhSharpe: bh.sharpe,
    bhMaxDd: bhMaxDd,
  };
}

function appendixXhtml(r) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const num = (x, d = 2) => x.toFixed(d);
  const code = `import numpy as np
import pandas as pd

FEE = 0.0005  # 单边手续费 0.05%（示例假设）

rng = np.random.default_rng(42)
n_days, s0, mu, sigma = 500, 100.0, 0.08, 0.20
ret = rng.normal((mu - sigma**2/2)/252, sigma/np.sqrt(252), n_days)
price = s0 * np.exp(np.cumsum(ret))

px = pd.Series(price)
sma_fast, sma_slow = px.rolling(20).mean(), px.rolling(60).mean()

# 关键：信号在“次日”才执行（shift(1)），避免使用未来数据
signal = (sma_fast > sma_slow).astype(int).shift(1).fillna(0)
raw_ret = px.pct_change().fillna(0)
turnover = signal.diff().abs().fillna(0)
strat_ret = raw_ret * signal - turnover * FEE

equity = (1 + strat_ret).cumprod()
bh = (1 + raw_ret).cumprod()

sharpe = strat_ret.mean()/strat_ret.std()*np.sqrt(252)
max_dd = (equity/equity.cummax() - 1).min()`;

  return `
<section class="appendix-note">
  <p><strong>本章为 ReadAny 自创的对照示例</strong>，不属于 Datawhale 原作内容，数据为固定种子（42）生成的合成行情，
  仅供理解第3、4章中“信号时点、手续费、回撤”等概念，<strong>不构成任何收益承诺或投资建议</strong>。</p>
</section>

<h2>为什么需要合成数据对照</h2>
<p>真实行情难以复现。固定种子的合成数据让每个数字都可以被任何人用同一段代码重新算出来，
适合用来<strong>核对回测里最容易犯的两个错误</strong>：使用了未来数据（信号未右移）与忽略交易成本。</p>

<h2>示例代码（静态展示）</h2>
<div class="codeblock"><div class="codelabel">示例代码（Python，静态展示，不可执行）</div><pre><code>${escapeXml(code)}</code></pre></div>

<h2>本机构建时的实际运行结果</h2>
<p>构建脚本用同一套参数（固定种子 42，${r.days} 个交易日，年化波动 20% 的设定）算出的结果如下——
数字本身没有意义，<strong>方法上的差别</strong>才有意义：</p>

<table>
  <thead><tr><th>指标</th><th>均线策略（含 0.05% 单边费用）</th><th>买入持有</th></tr></thead>
  <tbody>
    <tr><td>累计收益（自第61日起）</td><td>${pct(r.strategyTotal - 1)}</td><td>${pct(r.bhTotal - 1)}</td></tr>
    <tr><td>年化收益</td><td>${pct(r.strategyAnnRet)}</td><td>${pct(r.bhAnnRet)}</td></tr>
    <tr><td>年化波动</td><td>${pct(r.strategyAnnVol)}</td><td>${pct(r.bhAnnVol)}</td></tr>
    <tr><td>夏普比率（无风险利率取 0）</td><td>${num(r.strategySharpe)}</td><td>${num(r.bhSharpe)}</td></tr>
    <tr><td>最大回撤</td><td>${pct(r.strategyMaxDd)}</td><td>${pct(r.bhMaxDd)}</td></tr>
    <tr><td>调仓次数</td><td>${r.trades}</td><td>1</td></tr>
  </tbody>
</table>

<h2>请核对的三件事</h2>
<ol>
  <li><strong>信号时点</strong>：代码中 <code>signal.shift(1)</code> —— 今天收盘算出的信号，明天才执行。删掉 shift 再跑一遍，结果会明显变好，但那是“偷看未来”，不可信。</li>
  <li><strong>交易成本</strong>：每次换仓扣 0.05% 单边。调仓次数越多，费用拖累越大——高频翻转的均线信号对成本非常敏感。</li>
  <li><strong>样本内外</strong>：合成数据上的“好看”不等于真实市场有效；真实数据上应划分样本外区间再评估。</li>
</ol>
<p class="dynnote">本例使用 A 股之外无涨跌停限制的简化假设；具体市场规则请以官方资料为准。</p>`;
}

// ── title page ─────────────────────────────────────────────────────────────

function titleXhtml() {
  return `
<h1>金融量化入门（中文学习包）</h1>
<p class="subtitle">Quant for Beginners · 中文 Notebooks 阅读版</p>

<h2>这是什么</h2>
<p>本学习包由 Datawhale 开源项目 <strong>quant-for-beginners</strong> 的 8 章中文 Notebook
在构建期<strong>静态转换</strong>而成：正文、代码、公式与静态图表保留，交互式输出以说明替代。
随书附一篇 <strong>ReadAny 自创的合成数据对照示例</strong>（见附录）。</p>

<h2>如何使用</h2>
<ul>
  <li>无需安装 Jupyter 或 Python——所有代码以静态形式展示，不可执行；</li>
  <li>公式为标准 MathML，代码与图表均有来源标注；</li>
  <li>可在阅读器内使用划词翻译与 AI 讲解（需自行配置模型）；</li>
  <li>建议顺序：第1→2→3→4章（认识与回测），第5→6→7→8章（风险与组合），最后读附录。</li>
</ul>

<h2>来源与许可</h2>
<ul>
  <li>原作：Datawhale quant-for-beginners 项目组（MIT License）</li>
  <li>固定版本：<code>${PIN}</code></li>
  <li>许可全文：${escapeXml(LICENSE_URL)}</li>
  <li>转换与附录：ReadAny 构建脚本生成；附录为自创内容并已标注</li>
</ul>
<p class="dynnote">本学习包是学习材料，不构成投资建议；示例中的历史表现不代表未来收益。</p>`;
}

// ── EPUB assembly ──────────────────────────────────────────────────────────

function buildEpub(chapterDocs) {
  const uuid = `urn:uuid:${createHash("sha256").update(PIN).digest("hex").slice(0, 8)}-9a7b-4c1d-8e2f-3a5b6c7d8e9f`;
  const modified = "2026-09-13T00:00:00Z";
  const docs = [
    { id: "title", file: "title.xhtml", title: "金融量化入门（中文学习包）" },
    ...chapterDocs.map((c, i) => ({
      id: `ch${String(i + 1).padStart(2, "0")}`,
      file: `ch${String(i + 1).padStart(2, "0")}.xhtml`,
      title: c.title,
      body: c.body,
      selfAuthored: c.selfAuthored,
      metrics: c.metrics,
    })),
  ];
  const _spineCount = docs.length;

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  const manifestItems = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
    ...docs.map((d) => `<item id="${d.id}" href="${d.file}" media-type="application/xhtml+xml"/>`),
    ...[...images.values()].map(
      (img) =>
        `<item id="i_${sha256(img.href)}" href="${img.href}" media-type="image/${img.href.endsWith(".png") ? "png" : "jpeg"}"/>`,
    ),
  ].join("\n    ");
  const spineItems = docs.map((d) => `<itemref idref="${d.id}"/>`).join("\n    ");

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${uuid}</dc:identifier>
    <dc:title>金融量化入门（中文学习包）</dc:title>
    <dc:creator>Datawhale quant-for-beginners 项目组（原作）· ReadAny 学习包构建</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:source>${LANDING_URL}</dc:source>
    <dc:rights>MIT License（原作）· 固定版本 ${PIN}</dc:rights>
    <dc:description>基于 Datawhale quant-for-beginners 固定版本 ${PIN} 的 8 章中文 Notebook 静态转换阅读包，附 ReadAny 自创合成数据对照示例。学习材料，不构成投资建议。</dc:description>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    ${spineItems}
  </spine>
</package>`;

  const navLis = docs
    .map((d) => `<li><a href="${d.file}">${escapeXml(d.title)}</a></li>`)
    .join("\n      ");
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc"><h1>目录</h1>
    <ol>
      ${navLis}
    </ol>
  </nav>
</body>
</html>`;

  const navPoints = docs
    .map(
      (d, i) =>
        `<navPoint id="np${i}" playOrder="${i + 1}"><navLabel><text>${escapeXml(d.title)}</text></navLabel><content src="${d.file}"/></navPoint>`,
    )
    .join("\n");
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${uuid}"/><meta name="dtb:depth" content="1"/></head>
  <docTitle><text>金融量化入门（中文学习包）</text></docTitle>
  <navMap>
    ${navPoints}
  </navMap>
</ncx>`;

  const css = `body { font-family: serif; line-height: 1.7; margin: 1em; color: #111; }
h1 { font-size: 1.5em; } h2 { font-size: 1.2em; margin-top: 1.2em; }
.subtitle { color: #555; }
pre { background: #f5f5f5; border: 1px solid #ddd; border-radius: 4px; padding: 0.6em; font-size: 0.82em; white-space: pre-wrap; word-break: break-all; }
code { font-family: monospace; background: #f5f5f5; padding: 0 0.2em; }
pre code { background: transparent; }
pre.out { background: #fafafa; }
pre.err { background: #fdf0ef; border-color: #e0b4b4; }
.codeblock { margin: 0.8em 0; }
.codelabel { font-size: 0.75em; color: #666; margin-bottom: 0.2em; }
.figure { margin: 0.8em 0; text-align: center; }
.figure img { max-width: 100%; }
table { border-collapse: collapse; width: 100%; margin: 0.8em 0; font-size: 0.9em; }
th, td { border: 1px solid #ccc; padding: 0.35em 0.6em; text-align: left; }
th { background: #f0f0f0; }
.dynnote, .appendix-note { color: #7a5c00; background: #fffbe8; border: 1px solid #e8dc9a; border-radius: 4px; padding: 0.6em; font-size: 0.88em; margin: 0.8em 0; }
.appendix-note { margin: 1em 0; }`;

  const files = {
    mimetype: [new TextEncoder().encode("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": new TextEncoder().encode(container),
    "OEBPS/content.opf": new TextEncoder().encode(opf),
    "OEBPS/nav.xhtml": new TextEncoder().encode(nav),
    "OEBPS/toc.ncx": new TextEncoder().encode(ncx),
    "OEBPS/style.css": new TextEncoder().encode(css),
  };
  for (const d of docs) {
    const body =
      d.id === "title" ? titleXhtml() : d.selfAuthored ? appendixXhtml(d.metrics) : d.body;
    const doc = xhtmlDoc(d.title, body);
    checkTagBalance(doc, d.file);
    files[`OEBPS/${d.file}`] = new TextEncoder().encode(doc);
  }
  for (const img of images.values()) {
    files[`OEBPS/${img.href}`] = img.bytes;
  }
  return zipSync(files);
}

// ── verify (same family of checks as catalog build-seed) ───────────────────

function verifyEpub(buf) {
  if (buf.length < 30_000) throw new Error(`EPUB too small: ${buf.length}`);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error("bad magic");
  const files = unzipSync(new Uint8Array(buf));
  if (!files["META-INF/container.xml"]) throw new Error("missing container.xml");
  const opfPath = strFromU8(files["META-INF/container.xml"]).match(/full-path="([^"]+)"/)?.[1];
  const opf = strFromU8(files[opfPath]);
  const spineIds = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
  const itemMap = new Map(
    [...opf.matchAll(/<item\b[^>]*>/g)].map((m) => [
      m[0].match(/id="([^"]+)"/)?.[1],
      m[0].match(/href="([^"]+)"/)?.[1],
    ]),
  );
  let sample = "";
  for (const id of spineIds) {
    const href = itemMap.get(id);
    if (!href || !/\.x?html?$/i.test(href)) continue;
    const doc = files[`OEBPS/${href}`];
    if (doc) sample += strFromU8(doc).replace(/<[^>]+>/g, " ");
    if (sample.length > 300) break;
  }
  if (sample.replace(/\s/g, "").length < 300) throw new Error("text sample too small");
  // no script tags anywhere, and no non-self-closed void tags (EPUB XHTML is
  // parsed as XML — a bare <br> breaks the whole spine document)
  const voidRe = /<(?:br|hr|img|input|col|embed|source|track|wbr)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  for (const name of Object.keys(files)) {
    if (!name.endsWith(".xhtml")) continue;
    const t = strFromU8(files[name]);
    if (/<script/i.test(t)) throw new Error(`script tag survived in ${name}`);
    for (const tag of t.match(voidRe) ?? []) {
      if (!tag.endsWith("/>")) {
        throw new Error(`${name}: non-self-closed void tag — not XML-safe: ${tag.slice(0, 80)}`);
      }
    }
  }
  return { spine: spineIds.length, sampleChars: sample.length };
}

// ── DB integration ─────────────────────────────────────────────────────────

function upsertCatalogRow(db, epubBuf, toc) {
  const _subjects = JSON.stringify(["econ-finance", "math"]);
  const row = {
    catalog_edition_id: CATALOG_EDITION_ID,
    provider_id: "curated",
    provider_record_id: `${REPO}@${PIN}:${EPUB_FILE}`,
    work_key: "金融量化入门（中文学习包）",
    original_title: "Quant for Beginners — 金融量化入门中文学习包（静态转换阅读版）",
    title_zh: "金融量化入门（中文学习包）",
    title_zh_source: "original",
    authors: JSON.stringify(["Datawhale quant-for-beginners 项目组"]),
    language: "zh",
    publisher: "ReadAny 学习包构建（Datawhale 原作，MIT）",
    year: null,
    subject_ids: JSON.stringify(["econ-finance", "math"]),
    level: "入门",
    description_zh:
      "把 Datawhale 开源项目 quant-for-beginners 的 8 章中文 Notebook（量化概念、第一个实验、均线策略、回测、波动率、Sharpe 与 Beta、最大回撤与仓位、组合相关性）静态转换为可直接阅读的中文学习包：正文、代码、公式（MathML）与静态图表保留，交互输出以说明替代，另附 ReadAny 自创的合成数据对照回测一章（已标注）。原作 MIT 许可，固定版本 b385684e。学习材料，不构成投资建议。",
    toc: JSON.stringify(toc),
    popularity: 0,
    resource_format: "epub",
    resource_landing_url: LANDING_URL,
    resource_download_url: null,
    availability: "bundled",
    license_id: "MIT",
    license_url: LICENSE_URL,
    attribution: `Datawhale quant-for-beginners 项目组（MIT License, ${PIN}）；ReadAny 静态转换，附录为自创内容`,
    sha256: sha256(epubBuf),
    size_bytes: epubBuf.length,
    verified_at: new Date().toISOString().slice(0, 10),
    bundled_file: EPUB_FILE,
  };
  row.search_text = buildCatalogIndexText([
    row.title_zh,
    row.original_title,
    "Datawhale quant-for-beginners 量化 金融量化 回测 波动率 夏普比率 最大回撤 组合 相关性",
    row.publisher,
    "经济金融 数学",
    row.language,
  ]);
  db.prepare(
    `INSERT INTO editions (
      catalog_edition_id, provider_id, provider_record_id, work_key, original_title,
      title_zh, title_zh_source, authors, language, publisher, year, subject_ids, level,
      description_zh, toc, popularity, resource_format, resource_landing_url,
      resource_download_url, availability, license_id, license_url, attribution,
      sha256, size_bytes, verified_at, bundled_file, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(catalog_edition_id) DO UPDATE SET
      title_zh=excluded.title_zh, title_zh_source=excluded.title_zh_source,
      description_zh=excluded.description_zh, level=excluded.level,
      subject_ids=excluded.subject_ids, availability=excluded.availability,
      bundled_file=excluded.bundled_file, resource_format=excluded.resource_format,
      resource_landing_url=excluded.resource_landing_url, resource_download_url=excluded.resource_download_url,
      work_key=excluded.work_key, search_text=excluded.search_text,
      sha256=excluded.sha256, size_bytes=excluded.size_bytes, verified_at=excluded.verified_at`,
  ).run(
    row.catalog_edition_id,
    row.provider_id,
    row.provider_record_id,
    row.work_key,
    row.original_title,
    row.title_zh,
    row.title_zh_source,
    row.authors,
    row.language,
    row.publisher,
    row.year,
    row.subject_ids,
    row.level,
    row.description_zh,
    row.toc,
    row.popularity,
    row.resource_format,
    row.resource_landing_url,
    row.resource_download_url,
    row.availability,
    row.license_id,
    row.license_url,
    row.attribution,
    row.sha256,
    row.size_bytes,
    row.verified_at,
    row.bundled_file,
    row.search_text,
  );
}

function rewriteManifest(db) {
  const counts = {
    totalEditions: db.prepare("SELECT COUNT(*) AS n FROM editions").get().n,
    bundled: db.prepare("SELECT COUNT(*) AS n FROM editions WHERE availability='bundled'").get().n,
    online: db.prepare("SELECT COUNT(*) AS n FROM editions WHERE availability='online'").get().n,
    metadataOnly: db
      .prepare("SELECT COUNT(*) AS n FROM editions WHERE availability='metadata-only'")
      .get().n,
  };
  const rows = db
    .prepare(
      "SELECT catalog_edition_id, bundled_file, resource_format, sha256, size_bytes, license_id, verified_at FROM editions WHERE availability='bundled' ORDER BY catalog_edition_id",
    )
    .all();
  const books = rows
    .filter((r) => r.bundled_file && fs.existsSync(path.join(BOOKS_DIR, r.bundled_file)))
    .map((r) => ({
      catalogEditionId: r.catalog_edition_id,
      file: r.bundled_file,
      format: r.resource_format,
      sha256: r.sha256,
      sizeBytes: r.size_bytes,
      licenseId: r.license_id,
      verifiedAt: r.verified_at,
    }));
  const dbBuf = fs.readFileSync(path.join(SEED_DIR, "catalog.sqlite"));
  const builtAt = db.prepare("SELECT value FROM meta WHERE key='built_at'").get().value;
  const manifest = {
    schemaVersion: 1,
    builtAt,
    seededAt: new Date().toISOString(),
    counts,
    books,
    db: { sha256: sha256(dbBuf), sizeBytes: dbBuf.length },
  };
  fs.writeFileSync(path.join(SEED_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(BOOKS_DIR, { recursive: true });

  let epubBuf;
  if (DB_ONLY && fs.existsSync(path.join(OUT_DIR, EPUB_FILE))) {
    epubBuf = fs.readFileSync(path.join(OUT_DIR, EPUB_FILE));
    console.log("[quant-pack] --db-only: reusing existing EPUB");
  } else {
    console.log("[quant-pack] converting 8 chapters (static, nothing executed)…");
    const chapterDocs = [];
    for (const ch of CHAPTERS) {
      console.log(`  - ${ch.title}`);
      const body = await notebookToXhtml(ch);
      chapterDocs.push({ ...ch, body });
    }
    const metrics = computeSyntheticBacktest();
    chapterDocs.push({
      dir: "appendix",
      file: "appendix.ipynb",
      title: "附录 合成数据对照回测（ReadAny 自创示例）",
      metrics,
      selfAuthored: true,
    });

    console.log(`[quant-pack] images embedded: ${images.size}`);
    epubBuf = Buffer.from(buildEpub(chapterDocs));
    fs.writeFileSync(path.join(OUT_DIR, EPUB_FILE), epubBuf);
  }

  const verified = verifyEpub(epubBuf);
  console.log(
    `[quant-pack] EPUB OK: ${epubBuf.length} bytes, spine=${verified.spine}, sha256=${sha256(epubBuf).slice(0, 16)}…`,
  );

  // ── DB integration ──
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = path.join(SEED_DIR, "catalog.sqlite");
  const db = new DatabaseSync(dbPath);
  const toc = [
    "第一章 什么是量化金融",
    "第二章 你的第一个量化实验",
    "第三章 移动平均线策略",
    "第四章 策略回测",
    "第五章 理解波动率",
    "第六章 夏普比率与 Beta",
    "第七章 最大回撤与仓位管理",
    "第八章 多标的组合与相关性",
    "附录 合成数据对照回测（ReadAny 自创示例）",
  ];
  upsertCatalogRow(db, epubBuf, toc);
  fs.writeFileSync(path.join(BOOKS_DIR, EPUB_FILE), epubBuf);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    "built_at",
    new Date().toISOString(),
  );
  const manifest = rewriteManifest(db);
  db.close();
  console.log(
    `[quant-pack] catalog row upserted; manifest: ${manifest.counts.totalEditions} editions, ${manifest.books.length} bundled books, builtAt=${manifest.builtAt}`,
  );
  console.log("[quant-pack] DONE");
}

main().catch((err) => {
  console.error("quant-pack build FAILED:", err);
  process.exit(1);
});
