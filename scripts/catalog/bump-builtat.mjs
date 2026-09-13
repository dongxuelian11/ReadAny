/**
 * Refresh meta.built_at + manifest.json counts for the current snapshot.
 * Run after any manual in-place snapshot mutation so installed apps re-copy
 * the catalog (the seeding marker compares manifest.builtAt).
 *
 * Usage: node scripts/catalog/bump-builtat.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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

const db = new DatabaseSync(path.join(SEED_DIR, "catalog.sqlite"));
const builtAt = new Date().toISOString();
db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('built_at', ?)").run(builtAt);
const counts = {
  totalEditions: db.prepare("SELECT COUNT(*) AS n FROM editions").get().n,
  bundled: db.prepare("SELECT COUNT(*) AS n FROM editions WHERE availability='bundled'").get().n,
  online: db.prepare("SELECT COUNT(*) AS n FROM editions WHERE availability='online'").get().n,
  metadataOnly: db
    .prepare("SELECT COUNT(*) AS n FROM editions WHERE availability='metadata-only'")
    .get().n,
};
db.close();

const manifestPath = path.join(SEED_DIR, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.builtAt = builtAt;
manifest.counts = counts;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log("built_at:", builtAt, "counts:", JSON.stringify(counts));
