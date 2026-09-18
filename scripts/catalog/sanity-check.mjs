// One-off sanity check of the built catalog snapshot (read-only).
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("packages/app/src-tauri/resources/catalog-seed/catalog.sqlite", {
  readOnly: true,
});
const meta = db.prepare("SELECT key, value FROM meta").all();
console.log("meta:", meta.map((r) => `${r.key}=${r.value.slice(0, 80)}`).join(" | "));
const rows = db
  .prepare(
    "SELECT catalog_edition_id, original_title, title_zh, language, bundled_file, resource_download_url, sha256 FROM editions WHERE availability='bundled' ORDER BY catalog_edition_id",
  )
  .all();
for (const r of rows) {
  console.log(
    r.catalog_edition_id,
    "|",
    r.title_zh || r.original_title.slice(0, 36),
    "|",
    r.language,
    "|",
    r.bundled_file,
    "|",
    r.resource_download_url ? "url-ok" : "NO-URL",
    "|",
    r.sha256 ? "sha-ok" : "sha-pending",
  );
}
const zh = db
  .prepare(
    "SELECT catalog_edition_id, title_zh, original_title FROM editions WHERE search_text LIKE '%红楼%' AND search_text LIKE '%楼梦%' LIMIT 5",
  )
  .all();
console.log(
  "zh query 红楼梦 ->",
  zh
    .map((x) => `${x.catalog_edition_id}:${x.title_zh || x.original_title.slice(0, 18)}`)
    .join(" ; "),
);
const zhT = db
  .prepare(
    "SELECT catalog_edition_id, original_title FROM editions WHERE search_text LIKE '%紅樓%' LIMIT 5",
  )
  .all();
console.log(
  "zh-TW query 紅樓夢 ->",
  zhT.map((x) => x.catalog_edition_id).join(" ; "),
  `n=${zhT.length}`,
);
const linear = db
  .prepare("SELECT catalog_edition_id FROM editions WHERE search_text LIKE '%线性%'")
  .all();
console.log(
  "zh query 线性 ->",
  `n=${linear.length}`,
  linear
    .slice(0, 3)
    .map((x) => x.catalog_edition_id)
    .join("; "),
);
const la = db
  .prepare(
    "SELECT catalog_edition_id FROM editions WHERE search_text LIKE '%linear algebra%' LIMIT 4",
  )
  .all();
console.log("en query linear algebra ->", la.map((x) => x.catalog_edition_id).join(" ; "));
const subj = db
  .prepare("SELECT COUNT(*) n FROM editions WHERE subject_ids LIKE '%\"math\"%'")
  .get();
console.log("subject math rows:", subj.n);
db.close();
