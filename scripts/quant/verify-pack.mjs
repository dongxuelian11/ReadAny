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

// The corrected appendix must use the shift(1) execution signal and the
// net-of-fee series (regression guard against the old lookahead/gross mix).
check("appendix code shifts the signal by one day", appendix.includes("shift(1)"));
check(
  "appendix code charges fees into the daily return series (net basis)",
  appendix.includes("strat_ret = raw_ret * signal - turnover * FEE"),
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

if (failed) {
  console.error("verify-pack FAILED — see PASS/FAIL lines above");
  process.exit(1);
}
console.log("verify-pack: all checks passed");
