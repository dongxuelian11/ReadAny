// KB-01 acceptance: byte-level rejection matrix over REAL samples — the
// bundled quant EPUB (valid), a truncated copy (corrupt), HTML masquerade,
// undersized payload, and sha256 mismatch.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BookBytesError, verifyBookBytes } from "./download-verify";

const QUANT_EPUB = path.resolve(
  __dirname,
  "../../../app/src-tauri/resources/catalog-seed/books/quant-for-beginners-zh.epub",
);

function pdfLike(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0x25; // %
  bytes[1] = 0x50; // P
  bytes[2] = 0x44; // D
  bytes[3] = 0x46; // F
  return bytes;
}

describe("verifyBookBytes (KB-01 acceptance samples)", () => {
  it("ACCEPTS the real bundled quant EPUB", async () => {
    const bytes = readFileSync(QUANT_EPUB);
    const { sha256 } = await verifyBookBytes(new Uint8Array(bytes), "epub");
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("REJECTS a truncated/corrupt EPUB copy (size floor)", async () => {
    const bytes = readFileSync(QUANT_EPUB).subarray(0, 20_000);
    await expect(verifyBookBytes(new Uint8Array(bytes), "epub")).rejects.toBeInstanceOf(
      BookBytesError,
    );
  });

  it("REJECTS an HTML page masquerading as a book (200-response trap)", async () => {
    const html = new TextEncoder().encode(
      `<!doctype html><html><body>${"x".repeat(40000)}</body></html>`,
    );
    await expect(verifyBookBytes(html, "epub")).rejects.toThrow(/网页/);
  });

  it("REJECTS an undersized PDF", async () => {
    await expect(verifyBookBytes(pdfLike(400_000), "pdf")).rejects.toThrow(/过小/);
  });

  it("REJECTS a sha256 mismatch against the catalog record", async () => {
    const bytes = new Uint8Array(readFileSync(QUANT_EPUB));
    const wrongSha = "0".repeat(64);
    await expect(verifyBookBytes(bytes, "epub", wrongSha)).rejects.toThrow(/校验值不符/);
  });

  it("ACCEPTS with matching sha256 pin", async () => {
    const bytes = new Uint8Array(readFileSync(QUANT_EPUB));
    const first = await verifyBookBytes(bytes, "epub");
    const second = await verifyBookBytes(bytes, "epub", first.sha256);
    expect(second.sha256).toBe(first.sha256);
  });
});
