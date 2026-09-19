import { resolveDesktopDataPath } from "@/lib/storage/desktop-library-root";
import type { CatalogEdition } from "@readany/core/catalog";
import {
  MAX_DOWNLOAD_BYTES,
  sha256Hex,
  verifyBookBytes,
} from "@readany/core/catalog/download-verify";
import { remove, writeFile } from "@tauri-apps/plugin-fs";

/**
 * One-click full-text download for catalog editions (LIB-2 / KB-01).
 *
 * Fetches the edition's verified download URL over HTTPS, enforces the size
 * cap, validates the payload with the core byte gate (magic bytes, HTML
 * masquerade, size floors, sha256 pin) plus the EPUB container check, and
 * stages it as a temp file for the standard importBooks path.
 */

const PROGRESS_EMIT_BYTES = 256 * 1024;

export interface DownloadVerifyResult {
  tempPath: string;
  sizeBytes: number;
  sha256: string;
  format: "epub" | "pdf";
}

export class AcquireError extends Error {}

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

  // ── Verification (core byte gate + EPUB container check) ──
  try {
    await verifyBookBytes(bytes, format, edition.resource.sha256);
  } catch (err) {
    if (err instanceof AcquireError) throw err;
    throw new AcquireError(err instanceof Error ? err.message : String(err));
  }
  if (format === "epub") {
    await verifyEpubContainer(bytes);
  }
  const sha256 = await sha256Hex(bytes);

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
