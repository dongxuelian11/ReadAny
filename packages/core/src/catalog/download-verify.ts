/**
 * Downloaded book byte verification (KB-01).
 *
 * Pure byte-level gate for acquired catalog files: magic bytes, HTML masquerade
 * rejection, size floors/cap, and optional sha256 pinning. The EPUB container
 * check (ZIP structure) stays app-side where the zip.js runtime lives; this
 * module is deliberately dependency-free so the rejection matrix is unit
 * testable in core.
 */

export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
export const MIN_EPUB_BYTES = 30_000;
export const MIN_PDF_BYTES = 500_000;

export class BookBytesError extends Error {}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reject anything that is a web page pretending to be a book (200 + HTML). */
export function looksLikeHtml(bytes: Uint8Array): boolean {
  if (bytes.length <= 15) return false;
  if (bytes[0] === 0x3c) return true;
  const head = new TextDecoder().decode(bytes.subarray(0, 200));
  return /<html|<!doctype/i.test(head);
}

/**
 * Verify raw downloaded bytes against format/size/hash expectations.
 * Throws BookBytesError with a user-presentable message on rejection.
 */
export async function verifyBookBytes(
  bytes: Uint8Array,
  format: "epub" | "pdf",
  expectedSha256?: string,
): Promise<{ sha256: string }> {
  if (bytes.length === 0) throw new BookBytesError("下载内容为空");
  if (bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new BookBytesError(`文件超过大小上限（${Math.round(MAX_DOWNLOAD_BYTES / 1048576)}MB）`);
  }
  if (looksLikeHtml(bytes)) {
    throw new BookBytesError("下载内容是网页而不是书籍文件（来源可能已失效）");
  }

  const isPk = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;

  if (format === "epub") {
    if (!isPk) throw new BookBytesError("下载内容不是有效的 EPUB 文件");
    if (bytes.length < MIN_EPUB_BYTES) throw new BookBytesError("EPUB 文件过小，内容不完整");
  } else {
    if (!isPdf) throw new BookBytesError("下载内容不是有效的 PDF 文件");
    if (bytes.length < MIN_PDF_BYTES) throw new BookBytesError("PDF 文件过小，内容不完整");
  }

  const sha256 = await sha256Hex(bytes);
  const expected = expectedSha256?.toLowerCase();
  if (expected && expected !== sha256) {
    throw new BookBytesError("下载内容与目录记录的校验值不符，已拒绝导入");
  }
  return { sha256 };
}
