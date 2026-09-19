// Quant pack integrity verification. Exits NON-ZERO on any mismatch —
// including the synthetic appendix numbers, which are re-computed here from
// the SAME shared implementation the builder used and compared against the
// values embedded in the shipped EPUB (no console-true substitutes).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { computeSyntheticBacktest } from "./synthetic-backtest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const BOOKS_DIR = path.join(
  ROOT,
  "packages",
  "app",
  "src-tauri",
  "resources",
  "catalog-seed",
  "books",
);

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
}

// ── catalog row / book file / manifest integrity ───────────────────────────
const db = new DatabaseSync(
  path.join(ROOT, "packages/app/src-tauri/resources/catalog-seed/catalog.sqlite"),
);
const row = db
  .prepare(
    "SELECT catalog_edition_id, title_zh, language, level, availability, bundled_file, sha256, size_bytes, verified_at, resource_format FROM editions WHERE catalog_edition_id='curated:quant-for-beginners-zh'",
  )
  .get();
console.log("row:", JSON.stringify(row, null, 1));
check("catalog row exists", !!row);
check("row is bundled zh epub", row?.availability === "bundled" && row?.language === "zh");

const file = fs.readFileSync(path.join(BOOKS_DIR, row.bundled_file));
const hash = createHash("sha256").update(file).digest("hex");
check("book file sha256 matches catalog row", hash === row.sha256);
check("book file size matches catalog row", file.length === row.size_bytes);

const counts = db
  .prepare("SELECT availability, COUNT(*) n FROM editions GROUP BY availability")
  .all();
console.log("availability counts:", counts.map((c) => `${c.availability}=${c.n}`).join(", "));

const manifest = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, "packages/app/src-tauri/resources/catalog-seed/manifest.json"),
    "utf8",
  ),
);
check(
  "manifest lists the quant pack",
  manifest.books.some((b) => b.catalogEditionId === row.catalog_edition_id),
);
const dbHash = createHash("sha256")
  .update(
    fs.readFileSync(
      path.join(ROOT, "packages/app/src-tauri/resources/catalog-seed/catalog.sqlite"),
    ),
  )
  .digest("hex");
check("manifest db sha256 matches catalog.sqlite", manifest.db?.sha256 === dbHash);
db.close();

// ── appendix numbers: shipped EPUB vs shared implementation ────────────────
const files = unzipSync(new Uint8Array(file));
const appendixName = Object.keys(files).find((n) => n.endsWith("ch09.xhtml"));
check("appendix chapter present", !!appendixName);
const appendix = strFromU8(files[appendixName]);

// The corrected appendix must use the prior-day execution signal (the
// shift(1) equivalent in the runnable Python snippet) and the net-of-fee
// series (regression guard against the old lookahead/gross mix).
check(
  "appendix code executes the signal from the prior day (shift(1) equivalent)",
  appendix.includes("prev_exec") && appendix.includes("sma(FAST, i - 1)"),
);
check(
  "appendix code charges fees into the daily return series (net basis)",
  appendix.includes("net = ret * exec_sig - FEE * turnover"),
);

const metrics = computeSyntheticBacktest();
const embedded = new Map();
for (const m of appendix.matchAll(/data-metric="(\w+)" data-value="([-\d.e+]+)"/g)) {
  embedded.set(m[1], Number(m[2]));
}
const expected = [
  "strategyTotal",
  "strategyAnnRet",
  "strategyAnnVol",
  "strategySharpe",
  "strategyMaxDd",
  "bhTotal",
  "bhAnnRet",
  "bhAnnVol",
  "bhSharpe",
  "bhMaxDd",
  "trades",
];
for (const key of expected) {
  const shipped = embedded.get(key);
  const recomputed = metrics[key];
  const ok =
    shipped !== undefined &&
    (typeof recomputed === "number" && Number.isInteger(recomputed)
      ? shipped === recomputed
      : Math.abs(shipped - recomputed) <= 1e-9);
  check(
    `appendix metric ${key} matches recomputation`,
    ok,
    `shipped=${shipped} recomputed=${recomputed}`,
  );
}

// Visible-cell check: the text the reader actually sees must be the honest
// rendering of the embedded machine value — a tampered visible cell with a
// correct hidden data-value must FAIL (the old verifier missed this).
function renderedFor(key, value) {
  if (key === "trades") return String(value);
  if (key.endsWith("Sharpe")) return value.toFixed(2);
  if (key.endsWith("Total")) return `${((value - 1) * 100).toFixed(1)}%`;
  return `${(value * 100).toFixed(1)}%`;
}
for (const m of appendix.matchAll(
  /<td data-metric="(\w+)" data-value="([-\d.e+]+)">([^<]*)<\/td>/g,
)) {
  const [, key, rawValue, visible] = m;
  check(
    `visible cell for ${key} renders its embedded value`,
    renderedFor(key, Number(rawValue)) === visible,
    `visible="${visible}" expected="${renderedFor(key, Number(rawValue))}"`,
  );
}

// Display-code reproduction: extract the runnable Python snippet from the
// shipped EPUB, RUN it, and require its printed numbers to match the shared
// implementation (and the table). The "copy to reproduce" claim is thereby
// executed on every verification, not asserted.
const codeMatch = appendix.match(
  /<div class="codeblock"><div class="codelabel">[^<]*<\/div><pre><code>([\s\S]*?)<\/code><\/pre><\/div>/,
);
check("runnable display code block present", !!codeMatch);
if (codeMatch) {
  const unescapeXml = (s) =>
    s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  const displayCode = unescapeXml(codeMatch[1]);
  const { execFileSync } = await import("node:child_process");
  const python = process.env.QUANT_PYTHON ?? "python";
  let stdout = "";
  try {
    stdout = execFileSync(python, ["-I", "-X", "utf8", "-"], {
      input: displayCode,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
  } catch (error) {
    check(
      `display Python runs under "${python}"`,
      false,
      error instanceof Error ? error.message.slice(0, 300) : String(error),
    );
  }
  if (stdout) {
    // One metric per line, "<label>: <value>"; map by fixed order and assert
    // the labels so a reordered snippet cannot silently pass.
    const lines = stdout
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const displayOrder = [
      ["策略累计净值（费用后）", "strategyTotal", (v) => v],
      ["策略年化收益", "strategyAnnRet", (v) => v],
      ["策略年化波动", "strategyAnnVol", (v) => v],
      ["策略夏普比率", "strategySharpe", (v) => v],
      ["策略最大回撤", "strategyMaxDd", (v) => v],
      ["买入持有累计净值", "bhTotal", (v) => v],
      ["买入持有年化收益", "bhAnnRet", (v) => v],
      ["买入持有年化波动", "bhAnnVol", (v) => v],
      ["买入持有夏普比率", "bhSharpe", (v) => v],
      ["买入持有最大回撤", "bhMaxDd", (v) => v],
      ["调仓次数", "trades", (v) => Math.round(v)],
    ];
    check("display Python printed all metrics", lines.length === displayOrder.length);
    for (let i = 0; i < Math.min(lines.length, displayOrder.length); i += 1) {
      const [label, key, cast] = displayOrder[i];
      if (!lines[i].startsWith(label)) {
        check(`display line ${i + 1} is "${label}"`, false, `got: ${lines[i]}`);
        continue;
      }
      const rawToken = lines[i].split(":").pop().trim();
      const isPercent = rawToken.endsWith("%");
      const value = Number(rawToken.replace(/%$/, "")) * (isPercent ? 0.01 : 1);
      const target = metrics[key];
      const ok =
        Number.isFinite(value) &&
        (key === "trades" ? cast(value) === target : Math.abs(value - cast(target)) <= 1e-5);
      check(`display Python ${key} matches recomputation`, ok, `printed=${value} expected=${target}`);
    }
  }
}

if (failed) {
  console.error("verify-pack FAILED — see PASS/FAIL lines above");
  process.exit(1);
}
console.log("verify-pack: all checks passed");
