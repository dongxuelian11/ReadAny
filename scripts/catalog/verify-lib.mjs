/**
 * Shared resource verification for catalog build scripts.
 *
 * Extracted from build-seed.mjs so build-seed (bundled books) and
 * expand-catalog (verified online entries) apply identical rules:
 * real ZIP/EPUB structure, real text content (rejects HTML error pages
 * served with 200), sane PDF page counts.
 */
import { strFromU8, unzipSync } from "fflate";

export const MIN_EPUB_BYTES = 30_000;
export const MIN_PDF_BYTES = 500_000;
export const MIN_TEXT_SAMPLE_CHARS = 200;

export function decodeEntities(s) {
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

export function stripTags(xml) {
  return decodeEntities(xml.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function verifyEpub(buf) {
  if (buf.length < MIN_EPUB_BYTES) throw new Error(`EPUB too small: ${buf.length} bytes`);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error("not a ZIP/EPUB (bad magic)");
  const files = unzipSync(new Uint8Array(buf));
  const container = files["META-INF/container.xml"];
  if (!container) throw new Error("EPUB missing META-INF/container.xml");
  const containerXml = strFromU8(container);
  const opfMatch = containerXml.match(/full-path="([^"]+)"/);
  if (!opfMatch) throw new Error("container.xml has no rootfile full-path");
  const opfPath = opfMatch[1];
  const opf = files[opfPath];
  if (!opf) throw new Error(`OPF missing: ${opfPath}`);
  const opfXml = strFromU8(opf);

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

  const toc = [];
  const navItem = [...itemMap.values()].find((i) => /properties="[^"]*\bnav\b/.test(i.tag));
  if (navItem) {
    const navEntry = files[baseDir + decodeHref(navItem.href)] ?? files[decodeHref(navItem.href)];
    if (navEntry) {
      const navXml = strFromU8(navEntry);
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

export function verifyPdf(buf) {
  if (buf.length < MIN_PDF_BYTES) throw new Error(`PDF too small: ${buf.length} bytes`);
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("not a PDF (bad magic)");
  const head = buf.subarray(0, Math.min(buf.length, 4_000_000)).toString("latin1");
  const pageObjects = (head.match(/\/Type\s*\/Page[^s]/g) || []).length;
  if (pageObjects < 10) {
    throw new Error(`PDF looks wrong: only ${pageObjects} /Type /Page objects in first 4MB`);
  }
  return { format: "pdf", sizeBytes: buf.length, pageObjects, textSampleChars: 0, toc: [] };
}
