// KB-01/F01 regression: importBooks must NOT report success before the Book
// row is actually persisted. A failing db.insertBook / db.updateBook has to
// surface as result.failures (no imported entry, no optimistic store entry,
// no auto-vectorize start), and the acquire path therefore cannot mark the
// task ready. These tests inject the failure into the REAL module.

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbState = vi.hoisted(() => ({
  insertBookError: null as Error | null,
  updateBookError: null as Error | null,
  insertBookCalls: [] as unknown[],
  updateBookCalls: [] as unknown[],
  deletedByHash: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/db/database", () => ({
  initDatabase: vi.fn(async () => {}),
  insertBook: vi.fn(async (book: unknown) => {
    if (dbState.insertBookError) throw dbState.insertBookError;
    dbState.insertBookCalls.push(book);
    return book;
  }),
  updateBook: vi.fn(async (bookId: string, updates: unknown) => {
    if (dbState.updateBookError) throw dbState.updateBookError;
    dbState.updateBookCalls.push([bookId, updates]);
    return { id: bookId, ...(updates as object) };
  }),
  getBook: vi.fn(async () => null),
  getBooks: vi.fn(async () => []),
  getGroups: vi.fn(async () => []),
  deleteBook: vi.fn(async () => {}),
  insertGroup: vi.fn(async () => ({})),
  updateGroup: vi.fn(async () => {}),
  deleteGroup: vi.fn(async () => {}),
  getDeletedBookByFileHash: vi.fn(async (_hash: string) => dbState.deletedByHash),
  getDeletedBookByTitle: vi.fn(async () => null),
}));

vi.mock("@/lib/storage/desktop-library-root", () => ({
  getDesktopLibraryRoot: vi.fn(async () => "C:\\lib"),
  resolveDesktopDataPath: vi.fn(async (p: string) => `C:\\lib\\${p}`),
  isDesktopManagedRelativePath: vi.fn(() => true),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  copyFile: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  readFile: vi.fn(async () => new Uint8Array([1])),
  mkdir: vi.fn(async () => {}),
  exists: vi.fn(async () => false),
  remove: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
  // Same content in every fixture — different filenames must still dedupe.
  invoke: vi.fn(async () => "hash:same-content"),
  convertFileSrc: vi.fn((p: string) => `asset://${p}`),
}));

vi.mock("@tauri-apps/api/path", () => ({
  join: vi.fn(async (...parts: string[]) => parts.filter(Boolean).join("\\")),
}));

// Metadata extraction runs before DOMParser in library-store; an empty
// container keeps it on the early-return path (no DOM needed in node).
vi.mock("@zip.js/zip.js", () => ({
  configure: vi.fn(),
  ZipReader: class {
    async getEntries() {
      return [];
    }
    async close() {}
  },
  BlobReader: class {},
  TextWriter: class {},
  BlobWriter: class {},
}));

vi.mock("@/lib/reader/document-loader", () => ({
  DocumentLoader: class {
    async open() {
      return { book: { metadata: null } };
    }
  },
}));

vi.mock("@/lib/rag/vectorize-trigger", () => ({
  triggerVectorizeBook: vi.fn(async () => {}),
}));

vi.mock("@readany/core/stores/vector-model-store", () => ({
  useVectorModelStore: {
    getState: () => ({
      autoVectorizeOnImport: true,
      vectorModelEnabled: true,
      hasVectorCapability: () => true,
    }),
  },
}));

vi.mock("@readany/core/stores/persist", () => ({
  debouncedSave: vi.fn(),
  loadFromFS: vi.fn(async () => null),
}));

// Reuse the REAL dedupe implementation for duplicate semantics.
vi.mock("@readany/core", async () => {
  const dedupe = await import("../../../core/src/import/import-dedupe");
  return { ...dedupe };
});

import * as db from "@/lib/db/database";
import { triggerVectorizeBook } from "@/lib/rag/vectorize-trigger";
import { useLibraryStore } from "@/stores/library-store";

function makeDeletedBook() {
  return {
    id: "deleted-1",
    filePath: "books/deleted-1.epub",
    format: "epub",
    meta: { title: "Deleted Book", author: "" },
    progress: 0,
    isVectorized: false,
    vectorizeProgress: 0,
    tags: [],
    fileHash: "hash:src.epub",
    deletedAt: 1,
  };
}

beforeEach(() => {
  dbState.insertBookError = null;
  dbState.updateBookError = null;
  dbState.insertBookCalls.length = 0;
  dbState.updateBookCalls.length = 0;
  dbState.deletedByHash = null;
  useLibraryStore.setState({ books: [], isLoaded: true });
  vi.mocked(triggerVectorizeBook).mockClear();
  vi.mocked(db.insertBook).mockClear();
  vi.mocked(db.updateBook).mockClear();
});

describe("importBooks persistence semantics (KB-01/F01)", () => {
  it("reports a failure and does NOT start indexing when insertBook fails", async () => {
    dbState.insertBookError = new Error("disk full");

    const result = await useLibraryStore.getState().importBooks(["C:\\src.epub"]);

    expect(result.imported).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe("src.epub");
    expect(result.failures[0].error).toContain("disk full");
    // No optimistic store entry left behind
    expect(useLibraryStore.getState().books).toHaveLength(0);
    // Auto-vectorize must not start for a book that never persisted
    expect(triggerVectorizeBook).not.toHaveBeenCalled();
  });

  it("returns imported (and starts indexing) only after insertBook succeeds", async () => {
    const result = await useLibraryStore.getState().importBooks(["C:\\src.epub"]);

    expect(result.imported).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
    expect(dbState.insertBookCalls).toHaveLength(1);
    expect(useLibraryStore.getState().books).toHaveLength(1);
    expect(triggerVectorizeBook).toHaveBeenCalledTimes(1);
  });

  it("does not double-insert the same content (hash dedupe)", async () => {
    await useLibraryStore.getState().importBooks(["C:\\src.epub"]);
    const second = await useLibraryStore.getState().importBooks(["C:\\renamed-copy.epub"]);

    expect(second.imported).toHaveLength(0);
    expect(second.skippedDuplicates).toHaveLength(1);
    expect(dbState.insertBookCalls).toHaveLength(1);
  });

  it("reports a failure when restoring a deleted book fails to update the DB", async () => {
    dbState.deletedByHash = makeDeletedBook();
    dbState.updateBookError = new Error("update lost");

    const result = await useLibraryStore.getState().importBooks(["C:\\src.epub"]);

    expect(result.imported).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toContain("update lost");
    expect(useLibraryStore.getState().books).toHaveLength(0);
  });

  it("restores a deleted book (update path) and reports it as imported", async () => {
    dbState.deletedByHash = makeDeletedBook();

    const result = await useLibraryStore.getState().importBooks(["C:\\src.epub"]);

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].id).toBe("deleted-1");
    expect(dbState.updateBookCalls).toHaveLength(1);
    expect(triggerVectorizeBook).toHaveBeenCalledTimes(1);
  });
});
