import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
/**
 * LIB-1 catalog build: fetch REAL metadata from official sources and produce
 * the read-only catalog.sqlite shipped with the app.
 *
 * Sources (probed 2026-09-13):
 *  - Gutendex (https://gutendex.com) — Project Gutenberg catalog mirror.
 *    Politeness: sequential requests with delays and exponential backoff;
 *    the public demo instance rate-limits aggressive clients.
 *  - Open Textbook Library (https://open.umn.edu/opentextbooks/textbooks.json)
 *    — official read-only API, 10 records/page.
 *  - curated-books.json — hand-verified bundled books (see that file).
 *
 * Honesty rules enforced here:
 *  - No entry is invented; every record comes from a fetched source response.
 *  - No Chinese titles/descriptions are generated for bulk entries (titleZh
 *    stays NULL unless hand-curated). Machine-translation is NOT used here.
 *  - Bundled editions are only marked availability='bundled' from curated
 *    entries; sha256/verifiedAt are filled by build-seed.mjs after real
 *    download+verification.
 *
 * Output: packages/app/src-tauri/resources/catalog-seed/catalog.sqlite
 *         scripts/catalog/build-report.json
 *
 * Usage: pnpm catalog:build
 */
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  buildCatalogIndexText,
  normalizeCatalogText,
} from "../../packages/core/src/catalog/normalize.ts";
import { CATALOG_SCHEMA_VERSION } from "../../packages/core/src/catalog/schema-version.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SEED_DIR = path.join(ROOT, "packages", "app", "src-tauri", "resources", "catalog-seed");
const SUBJECTS = JSON.parse(
  readFileSync(path.join(ROOT, "packages", "core", "src", "catalog", "subjects.json"), "utf8"),
);
const CURATED = JSON.parse(readFileSync(path.join(__dirname, "curated-books.json"), "utf8"));

const GUTENDEX_DELAY_MS = 1300;
const OTL_DELAY_MS = 350;
const GUTENDEX_MAX_RETRIES = 5;
const POPULAR_PAGES = 20;
const ZH_PAGES = 15;
const TOPIC_PAGES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, { retries = GUTENDEX_MAX_RETRIES, timeoutMs = 60_000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": "ReadAny-catalog-build/1.0 (desktop reader; repo: dongxuelian11/ReadAny)",
        },
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
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

async function fetchJson(url, opts) {
  const res = await fetchWithRetry(url, opts);
  return res.json();
}

const SUBJECT_BY_KEYWORD = new Map();
for (const s of SUBJECTS) {
  for (const topic of s.gutendexTopics) SUBJECT_BY_KEYWORD.set(topic.toLowerCase(), s.id);
}

/** Match a subject blob (subjects/bookshelves joined text, or OTL subject names) to category ids. */
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

function cleanGutenbergTitle(title) {
  return (title || "")
    .replace(/\s*\$[a-z]\s*/g, ": ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Small zh↔en term mapping for subject search (plan §10: e.g. 概率/機率/
 * probability). Matched subjects contribute their display names AND keyword
 * terms into the indexed text so Chinese queries find English-subject books.
 */
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

function gutenbergLicense(copyright) {
  if (copyright === false) return "Public domain (US)";
  if (copyright === true) return "Copyrighted — see source";
  return "Unknown — see source";
}

const OTL_LANG = {
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

function pickFormatUrl(formats, predicate) {
  for (const [mime, url] of Object.entries(formats || {})) {
    if (predicate(mime, url)) return url;
  }
  return null;
}

/** Gutendex record → catalog row fields. */
function gutendexToRow(book, { topicSubject = null, curated = null } = {}) {
  const title = cleanGutenbergTitle(book.title);
  const authors = (book.authors || []).map((a) => a.name);
  const languages = book.languages || [];
  const lang = languages[0] || "unknown";
  const formats = book.formats || {};
  const epubUrl = pickFormatUrl(formats, (m, u) => m.startsWith("application/epub+zip") && u);
  const pdfUrl = pickFormatUrl(formats, (m, u) => m === "application/pdf" && u);
  const txtUrl = pickFormatUrl(formats, (m, u) => m.startsWith("text/plain") && u);

  const subjectBlob = (book.subjects || []).concat(book.bookshelves || []).join("; ");
  const subjectIds = new Set(matchSubjects(subjectBlob));
  if (topicSubject) subjectIds.add(topicSubject);

  let availability = "metadata-only";
  let downloadUrl = null;
  if (epubUrl || pdfUrl || txtUrl) {
    availability = "online";
    downloadUrl = epubUrl || pdfUrl || txtUrl;
  }

  const row = {
    catalog_edition_id: `gutenberg:${book.id}`,
    provider_id: "gutenberg",
    provider_record_id: String(book.id),
    work_key: workKeyOf(title, authors[0]),
    original_title: title,
    title_zh: null,
    title_zh_source: null,
    authors: JSON.stringify(authors),
    language: lang,
    publisher: "Project Gutenberg",
    year: null,
    subject_ids: JSON.stringify([...subjectIds]),
    level: "unknown",
    description_zh: null,
    toc: null,
    popularity: Number.isFinite(book.download_count) ? book.download_count : 0,
    resource_format: epubUrl ? "epub" : pdfUrl ? "pdf" : txtUrl ? "txt" : "unknown",
    resource_landing_url: `https://www.gutenberg.org/ebooks/${book.id}`,
    resource_download_url: downloadUrl,
    availability,
    license_id: gutenbergLicense(book.copyright),
    license_url: "https://www.gutenberg.org/policy/permission.html",
    attribution: `Project Gutenberg (www.gutenberg.org/ebooks/${book.id})`,
    sha256: null,
    size_bytes: null,
    verified_at: null,
    bundled_file: null,
  };

  if (curated) {
    row.title_zh = curated.titleZh ?? null;
    row.title_zh_source = curated.titleZhSource ?? null;
    row.description_zh = curated.descriptionZh ?? null;
    row.level = curated.level ?? "unknown";
    row.subject_ids = JSON.stringify(curated.subjects ?? [...subjectIds]);
    row.availability = "bundled";
    row.bundled_file = `pg${book.id}.epub`;
    row.resource_format = "epub";
  }
  row.search_text = buildCatalogIndexText([
    row.title_zh,
    row.original_title,
    authors.join(" "),
    row.publisher,
    ...subjectSearchTerms(row.subject_ids ? JSON.parse(row.subject_ids) : []),
    languages.join(" "),
  ]);
  return row;
}

/** OTL record → catalog row fields. */
function otlToRow(t) {
  const authors = (t.contributors || [])
    .filter((c) => c.contribution === "Author")
    .map((c) => [c.first_name, c.middle_name, c.last_name].filter(Boolean).join(" "))
    .filter(Boolean);
  const subjectNames = (t.subjects || []).map((s) => s.name).join("; ");
  const subjectIds = matchSubjects(subjectNames);
  const usable = (t.formats || []).filter(
    (f) => ["Online", "PDF", "eBook"].includes(f.type) && f.url,
  );
  const landing = usable[0]?.url || null;
  const directPdf = (t.formats || []).find(
    (f) => f.type === "PDF" && f.url?.toLowerCase().endsWith(".pdf"),
  );

  const row = {
    catalog_edition_id: `otl:${t.id}`,
    provider_id: "otl",
    provider_record_id: String(t.id),
    work_key: workKeyOf(t.title, authors[0]),
    original_title: (t.title || "").trim(),
    title_zh: null,
    title_zh_source: null,
    authors: JSON.stringify(authors),
    language: OTL_LANG[t.language] || t.language || "unknown",
    publisher: t.publishers?.[0]?.name || null,
    year: Number.isInteger(t.copyright_year) ? t.copyright_year : null,
    subject_ids: JSON.stringify(subjectIds),
    level: "unknown",
    description_zh: null,
    toc: null,
    popularity: Number.isFinite(t.textbook_reviews_count) ? t.textbook_reviews_count : 0,
    resource_format: usable.length ? usable[0].type.toLowerCase() : "unknown",
    resource_landing_url: landing,
    resource_download_url: directPdf?.url ?? null,
    availability: usable.length ? "online" : "metadata-only",
    license_id: t.license || "Unknown — see source",
    license_url: `https://open.umn.edu/opentextbooks/textbooks/${t.id}`,
    attribution: t.publishers?.[0]?.name
      ? `${t.publishers[0].name} / Open Textbook Library`
      : "Open Textbook Library",
    sha256: null,
    size_bytes: null,
    verified_at: null,
    bundled_file: null,
  };
  row.search_text = buildCatalogIndexText([
    row.original_title,
    authors.join(" "),
    row.publisher,
    subjectNames,
    ...subjectSearchTerms(subjectIds),
    row.language,
  ]);
  return row;
}

async function fetchGutendexBulk() {
  const byId = new Map();
  const reportSources = { requests: 0, pages: { popular: 0, zh: 0, topics: 0 } };

  async function fetchPages(baseUrl, label, maxPages, topicSubject = null) {
    for (let page = 1; page <= maxPages; page++) {
      const url =
        page === 1 ? baseUrl : `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}page=${page}`;
      const data = await fetchJson(url);
      reportSources.requests++;
      reportSources.pages[label]++;
      for (const book of data.results || []) {
        if (book.media_type !== "Text") continue;
        if (!byId.has(book.id)) byId.set(book.id, { book, topicSubject });
      }
      console.log(
        `  gutendex/${label} page ${page}: +${(data.results || []).length} (total ${byId.size})`,
      );
      if (!data.next || page >= maxPages) break;
      await sleep(GUTENDEX_DELAY_MS);
    }
  }

  console.log("[gutendex] popular (all languages)…");
  await fetchPages("https://gutendex.com/books/?sort=popular", "popular", POPULAR_PAGES);
  console.log("[gutendex] popular Chinese…");
  await fetchPages("https://gutendex.com/books/?languages=zh&sort=popular", "zh", ZH_PAGES);
  console.log("[gutendex] topic pages…");
  for (const s of SUBJECTS) {
    for (const topic of s.gutendexTopics) {
      await fetchPages(
        `https://gutendex.com/books/?sort=popular&topic=${encodeURIComponent(topic)}`,
        "topics",
        TOPIC_PAGES,
        s.id,
      );
      await sleep(GUTENDEX_DELAY_MS);
    }
  }
  return { byId, reportSources };
}

async function fetchOtlAll() {
  const rows = [];
  let page = 1;
  let totalPages = null;
  while (true) {
    const url = `https://open.umn.edu/opentextbooks/textbooks.json?page=${page}`;
    const data = await fetchJson(url, { retries: 4 });
    totalPages = data.links?.total_pages ?? totalPages;
    for (const t of data.data || []) rows.push(otlToRow(t));
    if (page % 20 === 0 || !data.links?.next) {
      console.log(`  otl page ${page}/${totalPages ?? "?"} (total ${rows.length})`);
    }
    if (!data.links?.next || page >= (totalPages ?? Number.POSITIVE_INFINITY)) break;
    page++;
    await sleep(OTL_DELAY_MS);
  }
  return rows;
}

function curatedReleaseRow(entry) {
  const asset = entry.source.asset;
  const ext = asset.toLowerCase().endsWith(".pdf") ? "pdf" : "epub";
  const file = `${entry.catalogEditionId.replace(/^curated:/, "")}.${ext}`;
  const releaseUrl = `https://github.com/${entry.source.repo}/releases/tag/${entry.source.tag}`;
  const row = {
    catalog_edition_id: entry.catalogEditionId,
    provider_id: "curated",
    provider_record_id: `${entry.source.repo}@${entry.source.tag}:${asset}`,
    work_key: normalizeCatalogText(entry.titleZh || entry.originalTitle),
    original_title: entry.originalTitle,
    title_zh: entry.titleZh ?? null,
    title_zh_source: entry.titleZhSource ?? null,
    authors: JSON.stringify(entry.authors),
    language: entry.language,
    publisher: entry.publisher ?? null,
    year: null,
    subject_ids: JSON.stringify(entry.subjects),
    level: entry.level ?? "unknown",
    description_zh: entry.descriptionZh ?? null,
    toc: null,
    popularity: 0,
    resource_format: ext,
    resource_landing_url: entry.landingUrl ?? releaseUrl,
    resource_download_url: `https://github.com/${entry.source.repo}/releases/download/${entry.source.tag}/${asset}`,
    availability: "bundled",
    license_id: entry.licenseId,
    license_url: entry.licenseUrl ?? null,
    attribution: entry.attribution ?? null,
    sha256: null,
    size_bytes: null,
    verified_at: null,
    bundled_file: file,
  };
  row.search_text = buildCatalogIndexText([
    row.title_zh,
    row.original_title,
    entry.authors.join(" "),
    row.publisher,
    ...subjectSearchTerms(entry.subjects),
    row.language,
  ]);
  return row;
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
      title_zh=excluded.title_zh, title_zh_source=excluded.title_zh_source,
      description_zh=excluded.description_zh, level=excluded.level,
      subject_ids=excluded.subject_ids, availability=excluded.availability,
      bundled_file=excluded.bundled_file, resource_format=excluded.resource_format,
      work_key=excluded.work_key, search_text=excluded.search_text`,
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

async function main() {
  console.log("=== LIB-1 catalog build (real sources only) ===");
  const startedAt = new Date().toISOString();

  // ── Gutendex bulk ──
  const { byId, reportSources } = await fetchGutendexBulk();

  // ── Curated gutenberg records (single batch request) ──
  const curatedGutenberg = CURATED.books.filter((b) => b.provider === "gutenberg");
  const curatedIds = curatedGutenberg.map((b) => b.gutenbergId).join(",");
  console.log(`[gutendex] curated ids: ${curatedIds}`);
  const curatedData = await fetchJson(`https://gutendex.com/books/?ids=${curatedIds}`);
  reportSources.requests++;
  const curatedById = new Map(curatedData.results.map((b) => [b.id, b]));
  const missingCurated = curatedGutenberg.filter((b) => !curatedById.has(b.gutenbergId));
  if (missingCurated.length > 0) {
    throw new Error(
      `Curated Gutenberg books missing from Gutendex response: ${missingCurated.map((b) => b.gutenbergId).join(", ")}`,
    );
  }

  // ── OTL (official read-only API) ──
  console.log("[otl] fetching all textbook pages…");
  const otlRows = await fetchOtlAll();

  // ── Build SQLite ──
  mkdirSync(SEED_DIR, { recursive: true });
  const dbPath = path.join(SEED_DIR, "catalog.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=DELETE;");
  db.exec(`
    DROP TABLE IF EXISTS editions;
    DROP TABLE IF EXISTS subjects;
    DROP TABLE IF EXISTS meta;
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE subjects(
      id TEXT PRIMARY KEY, zh_name TEXT NOT NULL, en_name TEXT NOT NULL, sort INTEGER NOT NULL
    );
    CREATE TABLE editions(
      catalog_edition_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      provider_record_id TEXT NOT NULL,
      work_key TEXT,
      original_title TEXT NOT NULL,
      title_zh TEXT,
      title_zh_source TEXT,
      authors TEXT NOT NULL,
      language TEXT NOT NULL,
      publisher TEXT,
      year INTEGER,
      subject_ids TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'unknown',
      description_zh TEXT,
      toc TEXT,
      popularity INTEGER NOT NULL DEFAULT 0,
      resource_format TEXT NOT NULL,
      resource_landing_url TEXT,
      resource_download_url TEXT,
      availability TEXT NOT NULL,
      license_id TEXT NOT NULL,
      license_url TEXT,
      attribution TEXT,
      sha256 TEXT,
      size_bytes INTEGER,
      verified_at TEXT,
      bundled_file TEXT,
      search_text TEXT NOT NULL
    );
    CREATE INDEX idx_editions_availability ON editions(availability);
    CREATE INDEX idx_editions_popularity ON editions(popularity);
  `);
  SUBJECTS.forEach((s, i) =>
    db
      .prepare("INSERT INTO subjects (id, zh_name, en_name, sort) VALUES (?, ?, ?, ?)")
      .run(s.id, s.zh, s.en, i),
  );

  db.exec("BEGIN");
  const bulkRows = [...byId.values()].map(({ book, topicSubject }) =>
    gutendexToRow(book, { topicSubject }),
  );
  for (const row of bulkRows) upsertEdition(db, row);

  // Curated gutenberg editions override their bulk rows and become bundled.
  for (const entry of curatedGutenberg) {
    const book = curatedById.get(entry.gutenbergId);
    upsertEdition(db, gutendexToRow(book, { curated: entry }));
  }
  // Curated release-based books (hello-algo, Happy-LLM).
  for (const entry of CURATED.books.filter((b) => b.provider === "curated")) {
    upsertEdition(db, curatedReleaseRow(entry));
  }
  for (const row of otlRows) upsertEdition(db, row);
  db.exec("COMMIT");

  const counts = {
    total: db.prepare("SELECT COUNT(*) AS n FROM editions").get().n,
    byProvider: Object.fromEntries(
      db
        .prepare("SELECT provider_id, COUNT(*) AS n FROM editions GROUP BY provider_id")
        .all()
        .map((r) => [r.provider_id, r.n]),
    ),
    byAvailability: Object.fromEntries(
      db
        .prepare("SELECT availability, COUNT(*) AS n FROM editions GROUP BY availability")
        .all()
        .map((r) => [r.availability, r.n]),
    ),
    distinctWorkKeys: db
      .prepare("SELECT COUNT(DISTINCT work_key) AS n FROM editions WHERE work_key IS NOT NULL")
      .get().n,
    byLanguageTop: db
      .prepare(
        "SELECT language, COUNT(*) AS n FROM editions GROUP BY language ORDER BY n DESC LIMIT 10",
      )
      .all(),
  };
  // A row contributes to each of its subjects.
  const subjectCounts = Object.fromEntries(SUBJECTS.map((s) => [s.id, 0]));
  for (const { subject_ids } of db.prepare("SELECT subject_ids FROM editions").all()) {
    for (const id of JSON.parse(subject_ids)) subjectCounts[id] = (subjectCounts[id] ?? 0) + 1;
  }

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    "schema_version",
    String(CATALOG_SCHEMA_VERSION),
  );
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("built_at", startedAt);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    "sources",
    JSON.stringify({
      gutendex: { base: "https://gutendex.com/books/", ...reportSources },
      otl: { base: "https://open.umn.edu/opentextbooks/textbooks.json", records: otlRows.length },
      curated: { entries: CURATED.books.length },
    }),
  );
  db.close();

  const report = {
    builtAt: startedAt,
    finishedAt: new Date().toISOString(),
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
    counts: {
      totalEditions: counts.total,
      distinctWorkKeys: counts.distinctWorkKeys,
      byProvider: counts.byProvider,
      byAvailability: counts.byAvailability,
      bySubject: subjectCounts,
      byLanguageTop: counts.byLanguageTop,
    },
    sources: {
      gutendex: reportSources,
      otl: { records: otlRows.length },
      curated: { entries: CURATED.books.length },
    },
  };
  writeFileSync(path.join(__dirname, "build-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log("=== done ===");
  console.log(JSON.stringify(report.counts, null, 2));
}

main().catch((err) => {
  console.error("catalog build FAILED:", err);
  process.exit(1);
});
