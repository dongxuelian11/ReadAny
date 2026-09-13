import { readFileSync } from "node:fs";
import path from "node:path";
/**
 * Recompute editions.search_text for the current catalog.sqlite from its own
 * rows (no network). Used when the term lists in subjects.json change — e.g.
 * the zh↔en subject keyword mapping — so the shipped snapshot stays in sync
 * without re-fetching the sources.
 *
 * Usage: node scripts/catalog/refresh-search-text.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { buildCatalogIndexText } from "../../packages/core/src/catalog/normalize.ts";

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
const SUBJECTS = JSON.parse(
  readFileSync(
    path.resolve(__dirname, "..", "..", "packages", "core", "src", "catalog", "subjects.json"),
    "utf8",
  ),
);

function subjectSearchTerms(subjectIds) {
  return (subjectIds || []).map((id) => {
    const s = SUBJECTS.find((x) => x.id === id);
    return s ? `${s.zh} ${s.en} ${s.keywords.join(" ")}` : "";
  });
}

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

const db = new DatabaseSync(path.join(SEED_DIR, "catalog.sqlite"));
const rows = db
  .prepare(
    "SELECT catalog_edition_id, title_zh, original_title, authors, publisher, subject_ids, language, toc FROM editions",
  )
  .all();
const update = db.prepare("UPDATE editions SET search_text=? WHERE catalog_edition_id=?");
db.exec("BEGIN");
let n = 0;
for (const row of rows) {
  const terms = buildCatalogIndexText([
    row.title_zh,
    row.original_title,
    parseJsonArray(row.authors).join(" "),
    row.publisher,
    ...subjectSearchTerms(parseJsonArray(row.subject_ids)),
    ...parseJsonArray(row.toc).slice(0, 25),
    row.language,
  ]);
  update.run(terms, row.catalog_edition_id);
  n++;
}
db.exec("COMMIT");
db.close();
console.log(`refreshed search_text for ${n} editions`);
