/**
 * LIB-2 catalog expansion (run against the existing snapshot, no re-fetch of
 * LIB-1 sources):
 *
 *  1. DOAB directory (https://directory.doabooks.org, official DSpace REST)
 *     adds modern open-access academic books with license metadata. Entries
 *     keep availability='online' with the official handle as landing page —
 *     no downloadUrl is fabricated, so the UI shows 打开来源页面, not 一键下载.
 *  2. Online-verified Gutenberg entries: the top EPUB-available editions per
 *     subject are actually downloaded and run through the SAME verification as
 *     bundled books (ZIP container + spine + text sample). Passing entries get
 *     sha256/size/verified_at recorded so the in-app downloader can enforce
 *     hash matching ("格式与hash不匹配要拒绝"). Failures are reported, never
 *     counted.
 *
 * Usage: node scripts/catalog/expand-catalog.mjs [--verify-only] [--doab-only]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  buildCatalogIndexText,
  normalizeCatalogText,
} from "../../packages/core/src/catalog/normalize.ts";
import { verifyEpub } from "./verify-lib.mjs";

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
const CURATED = JSON.parse(readFileSync(path.join(__dirname, "curated-books.json"), "utf8"));

const args = new Set(process.argv.slice(2));
const DOAB_DELAY_MS = 350;
const DOAB_PAGES_PER_KEYWORD = 3; // ×100 records (DOAB responses are slow ~30s/page)
const VERIFY_TARGET_PER_SUBJECT = 22;
const VERIFY_TOTAL_MIN = 300;
const VERIFY_CONCURRENCY = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, { retries = 4, timeoutMs = 60_000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": "ReadAny-catalog-build/1.0 (desktop reader; repo: dongxuelian11/ReadAny)",
        },
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const backoff = Math.round(2000 * 2 ** attempt + Math.random() * 1500);
      console.warn(`  [retry ${attempt + 1}/${retries}] ${err.message} — waiting ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

function matchSubjects(text) {
  const hay = (text || "").toLowerCase();
  const ids = [];
  if (!hay) return ids;
  for (const s of SUBJECTS) {
    for (const kw of s.keywords) {
      if (hay.includes(kw.toLowerCase())) {
        ids.push(s.id);
        break;
      }
    }
  }
  return ids;
}

function subjectSearchTerms(subjectIds) {
  return (subjectIds || []).map((id) => {
    const s = SUBJECTS.find((x) => x.id === id);
    return s ? `${s.zh} ${s.en} ${s.keywords.join(" ")}` : "";
  });
}

function workKeyOf(title, firstAuthor) {
  const t = normalizeCatalogText(title || "").slice(0, 80);
  const a =
    normalizeCatalogText(firstAuthor || "")
      .split(" ")
      .slice(-1)[0] || "";
  return t && a ? `${t}|${a}` : t || a || null;
}

const LANG_MAP = {
  eng: "en",
  spa: "es",
  fre: "fr",
  fra: "fr",
  ger: "de",
  deu: "de",
  chi: "zh",
  zho: "zh",
  jpn: "ja",
  kor: "ko",
  rus: "ru",
  por: "pt",
  ita: "it",
  ara: "ar",
  hin: "hi",
  dut: "nl",
  nld: "nl",
  pol: "pl",
  swe: "sv",
  tur: "tr",
  heb: "he",
  lat: "la",
  gre: "el",
  grc: "el",
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. DOAB directory expansion
// ─────────────────────────────────────────────────────────────────────────────

function doabToRow(item) {
  const metadata = item.metadata || [];
  const get = (key) => metadata.filter((m) => m.key === key).map((m) => m.value);
  const title = (item.name || "").trim();
  const authors = get("dc.contributor.author").length
    ? get("dc.contributor.author")
    : get("dc.contributor.editor");
  const lang = LANG_MAP[get("dc.language.iso")[0]] || get("dc.language.iso")[0] || "unknown";
  const year = Number.parseInt(get("dc.date.issued")[0] ?? "", 10);
  const subjectText = [
    ...get("dc.subject.other"),
    ...get("dc.subject.classification"),
    ...get("dc.subject"),
  ].join("; ");
  const subjectIds = matchSubjects(`${subjectText}; ${title}`);
  const handle = item.handle || "";
  const landing = handle ? `https://directory.doabooks.org/handle/${handle}` : null;
  const rights = get("dc.rights")[0] || "";
  const rightsIsUrl = rights.startsWith("http");

  const row = {
    catalog_edition_id: `doab:${item.uuid}`,
    provider_id: "doab",
    provider_record_id: item.uuid,
    work_key: workKeyOf(title, authors[0]),
    original_title: title,
    title_zh: null,
    title_zh_source: null,
    authors: JSON.stringify(authors),
    language: lang,
    publisher: get("dc.publisher")[0] || null,
    year: Number.isFinite(year) ? year : null,
    subject_ids: JSON.stringify(subjectIds),
    level: "unknown",
    description_zh: null,
    toc: null,
    popularity: 0,
    resource_format: "unknown",
    resource_landing_url: landing,
    resource_download_url: null,
    availability: landing ? "online" : "metadata-only",
    license_id: rights
      ? rightsIsUrl
        ? "See license URL (DOAB record)"
        : rights
      : "Unknown — see source",
    license_url: rightsIsUrl ? rights : landing,
    attribution: get("dc.publisher")[0] ? `${get("dc.publisher")[0]} / DOAB` : "DOAB",
    sha256: null,
    size_bytes: null,
    verified_at: null,
    bundled_file: null,
  };
  row.search_text = buildCatalogIndexText([
    row.original_title,
    authors.join(" "),
    row.publisher,
    subjectText,
    ...subjectSearchTerms(subjectIds),
    row.language,
  ]);
  return row;
}

async function fetchDoab() {
  const byId = new Map();
  let requests = 0;
  for (const s of SUBJECTS) {
    const keywords = s.gutendexTopics.filter((t) => t.length > 3).slice(0, 2);
    for (const keyword of keywords) {
      for (let offset = 0; offset < DOAB_PAGES_PER_KEYWORD * 100; offset += 100) {
        const url = `https://directory.doabooks.org/rest/search?query=${encodeURIComponent(keyword)}&limit=100&offset=${offset}&expand=metadata`;
        let items;
        try {
          const res = await fetchWithRetry(url);
          requests++;
          items = await res.json();
        } catch (err) {
          console.warn(`  doab ${keyword}@${offset} failed: ${err.message}`);
          break;
        }
        if (!Array.isArray(items) || items.length === 0) break;
        for (const item of items) {
          if (!item?.uuid || !item?.name) continue;
          if (!byId.has(item.uuid)) byId.set(item.uuid, { item, keyword });
        }
        if (items.length < 100) break;
        await sleep(DOAB_DELAY_MS);
      }
      await sleep(DOAB_DELAY_MS);
    }
    console.log(`  doab after "${s.en}": ${byId.size} records`);
  }
  return { byId, requests };
}

function upsertEdition(db, row) {
  db.prepare(
    `INSERT INTO editions (
      catalog_edition_id, provider_id, provider_record_id, work_key, original_title,
      title_zh, title_zh_source, authors, language, publisher, year, subject_ids, level,
      description_zh, toc, popularity, resource_format, resource_landing_url,
      resource_download_url, availability, license_id, license_url, attribution,
      sha256, size_bytes, verified_at, bundled_file, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(catalog_edition_id) DO UPDATE SET
      search_text=excluded.search_text, language=excluded.language,
      publisher=excluded.publisher, year=excluded.year`,
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

// ─────────────────────────────────────────────────────────────────────────────
// 2. Online verification of Gutenberg EPUB entries
// ─────────────────────────────────────────────────────────────────────────────

function pickVerifyCandidates(db) {
  const candidates = db
    .prepare(
      `SELECT catalog_edition_id, original_title, subject_ids, resource_download_url, popularity
       FROM editions
       WHERE provider_id='gutenberg' AND availability='online'
         AND resource_download_url LIKE '%.epub%'
       ORDER BY popularity DESC`,
    )
    .all()
    .filter((r) => !r.catalog_edition_id.startsWith("gutenberg:0")); // skip odd ids
  const bundledIds = new Set([
    ...CURATED.books
      .filter((b) => b.provider === "gutenberg")
      .map((b) => `gutenberg:${b.gutenbergId}`),
  ]);

  const chosen = new Map();
  // Round 1: top per subject (category spread first).
  for (const s of SUBJECTS) {
    let taken = 0;
    for (const c of candidates) {
      if (taken >= VERIFY_TARGET_PER_SUBJECT) break;
      if (chosen.has(c.catalog_edition_id) || bundledIds.has(c.catalog_edition_id)) continue;
      if (!JSON.parse(c.subject_ids).includes(s.id)) continue;
      chosen.set(c.catalog_edition_id, c);
      taken++;
    }
  }
  // Round 2: fill to the global minimum by popularity.
  for (const c of candidates) {
    if (chosen.size >= VERIFY_TOTAL_MIN) break;
    if (chosen.has(c.catalog_edition_id) || bundledIds.has(c.catalog_edition_id)) continue;
    chosen.set(c.catalog_edition_id, c);
  }
  return [...chosen.values()];
}

async function downloadBook(url, { retries = 3, timeoutMs = 120_000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithRetry(url, { retries: 0, timeoutMs });
      const buf = Buffer.from(await res.arrayBuffer());
      return buf;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      await sleep(2000 * 2 ** attempt + Math.random() * 1000);
    }
  }
  throw lastErr;
}

async function verifyOnlineEntries(db) {
  const candidates = pickVerifyCandidates(db);
  console.log(`[verify] ${candidates.length} online editions selected for download verification`);
  const queue = [...candidates];
  const results = { verified: 0, failed: [], bySubject: {} };
  const update = db.prepare(
    "UPDATE editions SET sha256=?, size_bytes=?, verified_at=?, resource_format='epub' WHERE catalog_edition_id=?",
  );
  const recordSubject = (row) => {
    for (const id of JSON.parse(row.subject_ids)) {
      results.bySubject[id] = (results.bySubject[id] ?? 0) + 1;
    }
  };

  async function worker() {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      try {
        const buf = await downloadBook(row.resource_download_url);
        const verified = verifyEpub(buf);
        const hash = createHash("sha256").update(buf).digest("hex");
        if (verified.format !== "epub") throw new Error("unexpected format");
        update.run(
          hash,
          verified.sizeBytes,
          new Date().toISOString().slice(0, 10),
          row.catalog_edition_id,
        );
        results.verified++;
        recordSubject(row);
        if (results.verified % 25 === 0) console.log(`  verified ${results.verified}…`);
      } catch (err) {
        results.failed.push({
          id: row.catalog_edition_id,
          title: row.original_title.slice(0, 60),
          error: String(err.message || err),
        });
      }
      await sleep(150);
    }
  }

  await Promise.all(Array.from({ length: VERIFY_CONCURRENCY }, () => worker()));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const doabOnly = args.has("--doab-only");
  const verifyOnly = args.has("--verify-only");
  const dbPath = path.join(SEED_DIR, "catalog.sqlite");
  const db = new DatabaseSync(dbPath);
  const report = { startedAt: new Date().toISOString(), doab: null, verify: null };

  // Verify first: the acceptance-critical part writes per-book as it goes, so
  // a later interruption still leaves verified data in the snapshot.
  if (!doabOnly) {
    console.log("[verify] downloading + verifying online editions…");
    report.verify = await verifyOnlineEntries(db);
    console.log(
      `[verify] verified=${report.verify.verified} failed=${report.verify.failed.length}`,
    );
    for (const f of report.verify.failed.slice(0, 15)) {
      console.log(`  FAIL ${f.id}: ${f.error} — ${f.title}`);
    }
  }

  if (!verifyOnly) {
    console.log("[doab] fetching DOAB directory records…");
    const { byId, requests } = await fetchDoab();
    console.log(`[doab] ${byId.size} unique records from ${requests} requests; upserting…`);
    db.exec("BEGIN");
    let n = 0;
    for (const { item } of byId.values()) {
      upsertEdition(db, doabToRow(item));
      n++;
    }
    db.exec("COMMIT");
    const counts = db
      .prepare("SELECT provider_id p, COUNT(*) n FROM editions GROUP BY provider_id")
      .all();
    report.doab = {
      requests,
      upserted: n,
      byProvider: Object.fromEntries(counts.map((r) => [r.p, r.n])),
    };
    console.log("[doab] done:", report.doab);
  }

  const meta = db.prepare("SELECT value FROM meta WHERE key='sources'").get();
  if (meta) {
    const sources = JSON.parse(meta.value);
    sources.doab = report.doab ? { records: report.doab.upserted } : sources.doab;
    sources.onlineVerified = report.verify
      ? { count: report.verify.verified }
      : sources.onlineVerified;
    db.prepare("UPDATE meta SET value=? WHERE key='sources'").run(JSON.stringify(sources));
  }
  // Bump built_at so installed apps re-copy the expanded snapshot (the seeding
  // marker compares manifest.builtAt). Also refresh manifest counts + hashes.
  const builtAt = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('built_at', ?)").run(builtAt);
  const counts = {
    totalEditions: db.prepare("SELECT COUNT(*) AS n FROM editions").get().n,
    bundled: db.prepare("SELECT COUNT(*) AS n FROM editions WHERE availability='bundled'").get()
      .n,
    online: db.prepare("SELECT COUNT(*) AS n FROM editions WHERE availability='online'").get().n,
    metadataOnly: db
      .prepare("SELECT COUNT(*) AS n FROM editions WHERE availability='metadata-only'")
      .get().n,
  };
  const manifestPath = path.join(SEED_DIR, "manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.builtAt = builtAt;
    manifest.counts = counts;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (err) {
    console.warn("[expand] manifest refresh failed:", err);
  }
  db.close();
  report.finishedAt = new Date().toISOString();
  report.builtAt = builtAt;
  report.counts = counts;
  writeFileSync(path.join(__dirname, "expand-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log("=== expand done ===", JSON.stringify(counts));
}

main().catch((err) => {
  console.error("expand FAILED:", err);
  process.exit(1);
});
