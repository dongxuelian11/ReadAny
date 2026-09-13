/**
 * LIB-1 seed build: download the curated bundled books, VERIFY each file is a
 * real, readable book (not an HTML error page, not a truncated download),
 * record sha256/size/verification date, and stage the resources directory the
 * installer ships (catalog.sqlite + books/ + manifest.json + t2s-chars.json).
 *
 * Verification performed here (per file):
 *  - EPUB: PK magic + valid ZIP + META-INF/container.xml + OPF + spine items
 *          present + text extracted from the first content docs is non-trivial
 *          (catches "200 response that is actually an HTML error page").
 *  - PDF:  %PDF magic + "/Type /Page" object count ≥ 10 + sane size.
 *  - sha256 recorded for every file.
 *  - EPUB table of contents (nav/ncx top-level titles) extracted into the
 *    catalog row — real TOC evidence, never invented.
 *
 * Usage: pnpm catalog:seed     (run AFTER pnpm catalog:build)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import * as OpenCC from "opencc-js";
import { buildCatalogIndexText } from "../../packages/core/src/catalog/normalize.ts";
import { CATALOG_SCHEMA_VERSION } from "../../packages/core/src/catalog/schema-version.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SEED_DIR = path.join(ROOT, "packages", "app", "src-tauri", "resources", "catalog-seed");
const BOOKS_DIR = path.join(SEED_DIR, "books");

const MIN_EPUB_BYTES = 30_000;
const MIN_PDF_BYTES = 500_000;
const MIN_TEXT_SAMPLE_CHARS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, { retries = 4, timeoutMs = 300_000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
        headers: {
          "user-agent": "ReadAny-catalog-build/1.0 (desktop reader; repo: dongxuelian11/ReadAny)",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return buf;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const backoff = Math.round(3000 * 2 ** attempt + Math.random() * 2000);
      console.warn(`  [retry ${attempt + 1}/${retries}] ${err.message} — waiting ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(xml) {
  return decodeEntities(xml.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function verifyEpub(buf) {
  if (buf.length < MIN_EPUB_BYTES) throw new Error(`EPUB too small: ${buf.length} bytes`);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error("not a ZIP/EPUB (bad magic)");
  const files = unzipSync(new Uint8Array(buf));
  const _names = Object.keys(files);
  const container = files["META-INF/container.xml"];
  if (!container) throw new Error("EPUB missing META-INF/container.xml");
  const containerXml = strFromU8(container);
  const opfMatch = containerXml.match(/full-path="([^"]+)"/);
  if (!opfMatch) throw new Error("container.xml has no rootfile full-path");
  const opfPath = opfMatch[1];
  const opf = files[opfPath];
  if (!opf) throw new Error(`OPF missing: ${opfPath}`);
  const opfXml = strFromU8(opf);

  // Content items from the spine (real documents, not just images).
  const itemMap = new Map();
  for (const m of opfXml.matchAll(/<item\b[^>]*>/g)) {
    const tag = m[0];
    const id = tag.match(/id="([^"]+)"/)?.[1];
    const href = tag.match(/href="([^"]+)"/)?.[1];
    if (id && href) itemMap.set(id, { href, tag });
  }
  const spineIds = [...opfXml.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
  if (spineIds.length === 0) throw new Error("OPF spine has no itemref");

  const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const decodeHref = (h) => decodeURIComponent(h);

  // Text sample from the first few content docs.
  let sample = "";
  for (const id of spineIds) {
    const item = itemMap.get(id);
    if (!item) continue;
    const isXhtml = /\.x?html?(\?.*)?$/i.test(item.href);
    if (!isXhtml) continue;
    const entry =
      files[baseDir + decodeHref(item.href)] ??
      files[decodeHref(item.href)] ??
      files[baseDir + item.href];
    if (!entry) continue;
    sample += ` ${stripTags(strFromU8(entry))}`;
    if (sample.length > MIN_TEXT_SAMPLE_CHARS) break;
  }
  if (sample.replace(/\s/g, "").length < MIN_TEXT_SAMPLE_CHARS) {
    throw new Error(
      `EPUB text sample too small (${sample.length} chars) — likely not real book content`,
    );
  }

  // TOC: EPUB3 nav first, then EPUB2 NCX. Top-level titles only.
  const toc = [];
  const navItem = [...itemMap.values()].find((i) => /properties="[^"]*\bnav\b/.test(i.tag));
  if (navItem) {
    const navEntry = files[baseDir + decodeHref(navItem.href)] ?? files[decodeHref(navItem.href)];
    if (navEntry) {
      const navXml = strFromU8(navEntry);
      const navRoot = navItem.href.includes("/")
        ? navItem.href.slice(0, navItem.href.lastIndexOf("/") + 1)
        : "";
      const links = [...navXml.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].filter(
        (m) => !m[1].startsWith("#"),
      );
      const seen = new Set();
      for (const m of links) {
        const text = stripTags(m[2]);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        toc.push(text);
        if (toc.length >= 40) break;
      }
      void navRoot;
    }
  }
  if (toc.length === 0) {
    const ncxPath = opfXml.match(
      /<item\b[^>]*media-type="application\/x-dtbncx\+xml"[^>]*href="([^"]+)"/,
    )?.[1];
    if (ncxPath) {
      const ncx = files[baseDir + decodeHref(ncxPath)] ?? files[decodeHref(ncxPath)];
      if (ncx) {
        const ncxXml = strFromU8(ncx);
        const seen = new Set();
        for (const m of ncxXml.matchAll(/<navPoint\b[^>]*>/g)) {
          const start = m.index;
          const end = ncxXml.indexOf("</navPoint>", start);
          const block = ncxXml.slice(start, end === -1 ? undefined : end);
          const text = stripTags(block.match(/<text[^>]*>([\s\S]*?)<\/text>/)?.[1] ?? "");
          if (!text || seen.has(text)) continue;
          seen.add(text);
          toc.push(text);
          if (toc.length >= 40) break;
        }
      }
    }
  }

  return {
    format: "epub",
    sizeBytes: buf.length,
    spineItems: spineIds.length,
    textSampleChars: sample.length,
    toc,
  };
}

function verifyPdf(buf) {
  if (buf.length < MIN_PDF_BYTES) throw new Error(`PDF too small: ${buf.length} bytes`);
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("not a PDF (bad magic)");
  const head = buf.subarray(0, Math.min(buf.length, 4_000_000)).toString("latin1");
  const pageObjects = (head.match(/\/Type\s*\/Page[^s]/g) || []).length;
  if (pageObjects < 10) {
    throw new Error(`PDF looks wrong: only ${pageObjects} /Type /Page objects in first 4MB`);
  }
  return { format: "pdf", sizeBytes: buf.length, pageObjects, textSampleChars: 0, toc: [] };
}

async function main() {
  console.log("=== LIB-1 seed build (download + verify bundled books) ===");
  const dbPath = path.join(SEED_DIR, "catalog.sqlite");
  if (!existsSync(dbPath)) {
    throw new Error("catalog.sqlite not found — run pnpm catalog:build first");
  }
  const db = new DatabaseSync(dbPath);
  mkdirSync(BOOKS_DIR, { recursive: true });

  const bundled = db
    .prepare(
      "SELECT catalog_edition_id, original_title, title_zh, resource_download_url, bundled_file FROM editions WHERE availability='bundled' ORDER BY catalog_edition_id",
    )
    .all();
  if (bundled.length < 12) {
    throw new Error(
      `only ${bundled.length} bundled editions in catalog — expected ≥12; refusing to ship a thin seed`,
    );
  }

  const manifestBooks = [];
  for (const row of bundled) {
    const url = row.resource_download_url;
    if (!url) throw new Error(`bundled edition ${row.catalog_edition_id} has no download URL`);
    const file = row.bundled_file;
    const dest = path.join(BOOKS_DIR, file);
    console.log(`[seed] ${row.catalog_edition_id}: ${row.title_zh || row.original_title}`);
    console.log(`       from ${url}`);
    const buf = await download(url);

    const isEpub = file.toLowerCase().endsWith(".epub");
    let verified;
    try {
      verified = isEpub ? verifyEpub(buf) : verifyPdf(buf);
    } catch (err) {
      throw new Error(
        `VERIFICATION FAILED for ${row.catalog_edition_id} (${file}): ${err.message}`,
      );
    }
    const hash = sha256(buf);
    writeFileSync(dest, buf);
    console.log(
      `       OK ${verified.format} ${verified.sizeBytes} bytes sha256=${hash.slice(0, 16)}… spine=${verified.spineItems ?? "-"} sample=${verified.textSampleChars}ch toc=${verified.toc.length}`,
    );

    db.prepare(
      "UPDATE editions SET sha256=?, size_bytes=?, verified_at=?, toc=?, search_text=? WHERE catalog_edition_id=?",
    ).run(
      hash,
      verified.sizeBytes,
      new Date().toISOString().slice(0, 10),
      verified.toc.length ? JSON.stringify(verified.toc) : null,
      buildCatalogIndexText([row.title_zh, row.original_title, ...verified.toc.slice(0, 25)]),
      row.catalog_edition_id,
    );
    manifestBooks.push({
      catalogEditionId: row.catalog_edition_id,
      file,
      format: verified.format,
      sha256: hash,
      sizeBytes: verified.sizeBytes,
      licenseId: db
        .prepare("SELECT license_id FROM editions WHERE catalog_edition_id=?")
        .get(row.catalog_edition_id).license_id,
      verifiedAt: new Date().toISOString().slice(0, 10),
    });
  }

  // ── traditional→simplified char map (full common set, generated by OpenCC) ──
  console.log("[t2s] generating char map via OpenCC…");
  const conv = OpenCC.Converter({ from: "t", to: "cn" });
  const map = {};
  const ranges = [
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xf900, 0xfaff],
  ];
  for (const [lo, hi] of ranges) {
    for (let cp = lo; cp <= hi; cp++) {
      const ch = String.fromCodePoint(cp);
      const simplified = conv(ch);
      if (simplified && simplified !== ch) map[ch] = simplified;
    }
  }
  writeFileSync(path.join(SEED_DIR, "t2s-chars.json"), JSON.stringify(map));
  console.log(`[t2s] ${Object.keys(map).length} mapped chars`);

  // ── manifest ──
  const counts = {
    totalEditions: db.prepare("SELECT COUNT(*) AS n FROM editions").get().n,
    bundled: db.prepare("SELECT COUNT(*) AS n FROM editions WHERE availability='bundled'").get().n,
    online: db.prepare("SELECT COUNT(*) AS n FROM editions WHERE availability='online'").get().n,
    metadataOnly: db
      .prepare("SELECT COUNT(*) AS n FROM editions WHERE availability='metadata-only'")
      .get().n,
  };
  const meta = Object.fromEntries(
    db
      .prepare("SELECT key, value FROM meta")
      .all()
      .map((r) => [r.key, r.value]),
  );
  const manifest = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    builtAt: meta.built_at,
    seededAt: new Date().toISOString(),
    counts,
    books: manifestBooks,
  };
  writeFileSync(path.join(SEED_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  db.close();
  console.log(`=== seed done: ${manifestBooks.length} bundled books verified ===`);
}

main().catch((err) => {
  console.error("seed build FAILED:", err);
  process.exit(1);
});
