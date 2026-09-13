import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
/**
 * Print real catalog statistics from the built seed (for release reports).
 * Usage: pnpm catalog:stats
 */
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "packages",
  "app",
  "src-tauri",
  "resources",
  "catalog-seed",
);
const dbPath = path.join(SEED_DIR, "catalog.sqlite");
if (!existsSync(dbPath)) {
  console.error("catalog.sqlite not found — run pnpm catalog:build first");
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const subjects = db.prepare("SELECT id, zh_name FROM subjects ORDER BY sort").all();

const total = db.prepare("SELECT COUNT(*) n FROM editions").get().n;
const byProvider = db
  .prepare("SELECT provider_id p, COUNT(*) n FROM editions GROUP BY provider_id")
  .all();
const byAvailability = db
  .prepare("SELECT availability a, COUNT(*) n FROM editions GROUP BY availability")
  .all();
const byLanguage = db
  .prepare("SELECT language l, COUNT(*) n FROM editions GROUP BY language ORDER BY n DESC LIMIT 12")
  .all();
const distinctWorks = db
  .prepare("SELECT COUNT(DISTINCT work_key) n FROM editions WHERE work_key IS NOT NULL")
  .get().n;
const bundledZh = db
  .prepare("SELECT COUNT(*) n FROM editions WHERE availability='bundled' AND language LIKE 'zh%'")
  .get().n;
const verifiedOnline = db
  .prepare(
    "SELECT COUNT(*) n FROM editions WHERE availability='online' AND resource_download_url IS NOT NULL",
  )
  .get().n;

const subjectCounts = Object.fromEntries(subjects.map((s) => [s.id, 0]));
for (const { subject_ids } of db.prepare("SELECT subject_ids FROM editions").all()) {
  for (const id of JSON.parse(subject_ids)) if (id in subjectCounts) subjectCounts[id] += 1;
}

console.log("=== catalog.sqlite real statistics ===");
console.log("total editions:", total);
console.log("distinct works (heuristic):", distinctWorks);
console.log("by provider:", byProvider.map((r) => `${r.p}=${r.n}`).join(", "));
console.log("by availability:", byAvailability.map((r) => `${r.a}=${r.n}`).join(", "));
console.log("bundled Chinese editions:", bundledZh);
console.log("online with real download/landing URL:", verifiedOnline);
console.log("by language (top):", byLanguage.map((r) => `${r.l}=${r.n}`).join(", "));
console.log("by subject:");
for (const s of subjects) console.log(`  ${s.zh} (${s.id}): ${subjectCounts[s.id]}`);
const manifest = JSON.parse(readFileSync(path.join(SEED_DIR, "manifest.json"), "utf8"));
console.log("bundled files:", manifest.books.length);
for (const b of manifest.books) {
  console.log(
    `  ${b.file} ${b.format} ${(b.sizeBytes / 1048576).toFixed(1)}MB sha256=${b.sha256.slice(0, 12)}… [${b.licenseId}]`,
  );
}
db.close();
