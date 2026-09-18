import { createHash } from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("packages/app/src-tauri/resources/catalog-seed/catalog.sqlite");
const row = db
  .prepare(
    "SELECT catalog_edition_id, title_zh, language, level, availability, bundled_file, sha256, size_bytes, verified_at, resource_format FROM editions WHERE catalog_edition_id='curated:quant-for-beginners-zh'",
  )
  .get();
console.log("row:", JSON.stringify(row, null, 1));
const file = fs.readFileSync(
  `packages/app/src-tauri/resources/catalog-seed/books/${row.bundled_file}`,
);
const hash = createHash("sha256").update(file).digest("hex");
console.log(
  "file sha256 match:",
  hash === row.sha256,
  "| size match:",
  file.length === row.size_bytes,
);
const counts = db
  .prepare("SELECT availability, COUNT(*) n FROM editions GROUP BY availability")
  .all();
console.log("availability counts:", counts.map((c) => `${c.availability}=${c.n}`).join(", "));
const manifest = JSON.parse(
  fs.readFileSync("packages/app/src-tauri/resources/catalog-seed/manifest.json", "utf8"),
);
console.log(
  "manifest books:",
  manifest.books.length,
  "| db hash present:",
  !!manifest.db,
  "| builtAt:",
  manifest.builtAt,
);
const dbHash = createHash("sha256")
  .update(fs.readFileSync("packages/app/src-tauri/resources/catalog-seed/catalog.sqlite"))
  .digest("hex");
console.log("manifest db hash matches file:", manifest.db.sha256 === dbHash);
console.log(
  "manifest quant entry:",
  JSON.stringify(
    manifest.books.find((b) => b.catalogEditionId === "curated:quant-for-beginners-zh"),
  ),
);
db.close();
