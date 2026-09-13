import { resolveDesktopDataPath } from "@/lib/storage/desktop-library-root";
import type { CatalogEdition } from "@readany/core/catalog";
import { remove, writeFile } from "@tauri-apps/plugin-fs";

/**
 * One-click full-text download for catalog editions (LIB-2).
 *
 * Fetches the edition's verified download URL over HTTPS, enforces a size cap,
 * validates the payload is a real book file (magic bytes, EPUB container,
 * optional sha256 from the catalog manifest) and stages it as a temp file for
 * the standard importBooks path. HTML error pages served with a 200 status are
 * rejected by the magic-byte check.
 */

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const MIN_EPUB_BYTES = 30_000;
const MIN_PDF_BYTES = 500_000;
const PROGRESS_EMIT_BYTES = 256 * 1024;

export interface DownloadVerifyResult {
  tempPath: string;
  sizeBytes: number;
  sha256: string;
  format: "epub" | "pdf";
}

export class AcquireError extends Error {}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function extensionFor(edition: CatalogEdition): "epub" | "pdf" {
  const url = (edition.resource.downloadUrl || "").toLowerCase();
  if (edition.resource.format === "pdf" || url.endsWith(".pdf")) return "pdf";
  return "epub";
}

function safeFileStem(editionId: string): string {
  return editionId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80);
}

/** Reject anything that is not a plain https URL (no file:, no redirects we cannot audit). */
function assertSafeHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AcquireError(`Invalid download URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new AcquireError(`Only https download URLs are allowed: ${raw}`);
  }
  return url;
}

async function verifyEpubContainer(bytes: Uint8Array): Promise<void> {
  try {
    // Same zip.js path as library-store metadata extraction (foliate's vendored
    // fflate is a minimal build without zip support).
    const { configure, ZipReader, BlobReader } = await import("@zip.js/zip.js");
    configure({ useWebWorkers: false });
    const reader = new ZipReader(new BlobReader(new Blob([bytes as unknown as BlobPart])));
    try {
      const entries = await reader.getEntries();
      const hasContainer = entries.some((e) => e.filename === "META-INF/container.xml");
      if (!hasContainer) {
        throw new AcquireError("Downloaded EPUB is missing its container metadata");
      }
    } finally {
      await reader.close();
    }
  } catch (err) {
    if (err instanceof AcquireError) throw err;
    throw new AcquireError("Downloaded file is not a readable EPUB");
  }
}

/**
 * Download `edition.resource.downloadUrl` and verify it. Resolves with the
 * staged temp file path (inside the user data dir) ready for importBooks.
 */
export async function downloadAndVerifyCatalogFile(
  edition: CatalogEdition,
  onProgress?: (bytesDownloaded: number, totalBytes?: number) => void,
  signal?: AbortSignal,
): Promise<DownloadVerifyResult> {
  const downloadUrl = edition.resource.downloadUrl;
  if (!downloadUrl) throw new AcquireError("该条目没有可用的下载地址");
  assertSafeHttpsUrl(downloadUrl);

  const format = extensionFor(edition);
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  // Default plugin-http config already validates TLS certificates — no danger
  // overrides.
  const response = await tauriFetch(downloadUrl, { signal });
  if (!response.ok) {
    throw new AcquireError(`下载失败：HTTP ${response.status}`);
  }

  const contentLengthHeader = response.headers.get("content-length");
  const totalBytes = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  if (totalBytes && totalBytes > MAX_DOWNLOAD_BYTES) {
    throw new AcquireError(`文件超过大小上限（${Math.round(totalBytes / 1048576)}MB）`);
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastEmit = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > MAX_DOWNLOAD_BYTES) {
          await reader.cancel().catch(() => {});
          throw new AcquireError("文件超过大小上限（200MB）");
        }
        chunks.push(value);
        if (received - lastEmit >= PROGRESS_EMIT_BYTES) {
          lastEmit = received;
          onProgress?.(received, totalBytes);
        }
      }
    }
  } else {
    const buffer = await response.arrayBuffer();
    received = buffer.byteLength;
    if (received > MAX_DOWNLOAD_BYTES) throw new AcquireError("文件超过大小上限（200MB）");
    chunks.push(new Uint8Array(buffer));
  }
  onProgress?.(received, totalBytes ?? received);

  // Concatenate chunks.
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // ── Verification ──
  const isPk = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  const looksHtml =
    bytes.length > 15 &&
    (bytes[0] === 0x3c ||
      new TextDecoder().decode(bytes.subarray(0, 200)).match(/<html|<!doctype/i));
  if (looksHtml) throw new AcquireError("下载内容是网页而不是书籍文件（来源可能已失效）");

  if (format === "epub") {
    if (!isPk) throw new AcquireError("下载内容不是有效的 EPUB 文件");
    if (bytes.length < MIN_EPUB_BYTES) throw new AcquireError("EPUB 文件过小，内容不完整");
    await verifyEpubContainer(bytes);
  } else {
    if (!isPdf) throw new AcquireError("下载内容不是有效的 PDF 文件");
    if (bytes.length < MIN_PDF_BYTES) throw new AcquireError("PDF 文件过小，内容不完整");
  }

  const sha256 = await sha256Hex(bytes);
  const expected = edition.resource.sha256?.toLowerCase();
  if (expected && expected !== sha256) {
    throw new AcquireError("下载内容与目录记录的校验值不符，已拒绝导入");
  }

  // Stage as temp file in the user data dir.
  const tempRelative = `tmp/catalog-${safeFileStem(edition.catalogEditionId)}.${format}`;
  const tempPath = await resolveDesktopDataPath(tempRelative);
  const { mkdir } = await import("@tauri-apps/plugin-fs");
  const tmpDir = await resolveDesktopDataPath("tmp");
  try {
    await mkdir(tmpDir, { recursive: true });
  } catch {
    /* already exists */
  }
  try {
    await remove(tempPath);
  } catch {
    /* not present */
  }
  await writeFile(tempPath, bytes);
  return { tempPath, sizeBytes: bytes.length, sha256, format };
}

export async function cleanupAcquireTempFile(tempPath: string): Promise<void> {
  try {
    await remove(tempPath);
  } catch {
    /* already gone */
  }
}
