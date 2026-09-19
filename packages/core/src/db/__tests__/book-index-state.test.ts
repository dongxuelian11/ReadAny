// KB-01 followup / F01 regression: vectorizeError must survive a real storage
// roundtrip — written through updateBook into SQLite, read back through
// rowToBook, and cleared on retry. Runs against a REAL node:sqlite file
// database via the actual db-core schema/migrations and book-queries layer
// (no hand-built Book objects in assertions, no mocked query layer).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Real SQLite-backed platform service (desktop adapter stand-in) --------

const kv = new Map<string, string>();
let tempRoot = "";
let openedDatabases: DatabaseSync[] = [];
let executeLog: string[] = [];

vi.mock("../../services/platform", () => ({
  getPlatformService: () => platform,
}));

const platform = {
  isDesktop: true,
  async getAppDataDir() {
    return tempRoot;
  },
  async joinPath(...parts: string[]) {
    return path.join(...parts);
  },
  async exists(_p: string) {
    // No desktop-data-root.json override in tests
    return false;
  },
  async readTextFile() {
    throw new Error("not expected in this test");
  },
  async kvGetItem(key: string) {
    return kv.get(key) ?? null;
  },
  async kvSetItem(key: string, value: string) {
    kv.set(key, value);
  },
  async kvRemoveItem(key: string) {
    kv.delete(key);
  },
  async loadDatabase(location: string) {
    const file = location.replace(/^sqlite:/, "");
    const db = new DatabaseSync(file);
    openedDatabases.push(db);
    const _originalExecute = db.exec.bind(db);
    return {
      async execute(sql: string, params: unknown[] = []) {
        executeLog.push(sql.replace(/\s+/g, " ").trim());
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA")) {
          db.prepare(sql).all(...params);
          return;
        }
        db.prepare(sql).run(...params);
      },
      async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
        executeLog.push(sql.replace(/\s+/g, " ").trim());
        return db.prepare(sql).all(...params) as T[];
      },
      async close() {
        db.close();
      },
    };
  },
};

import type { Book } from "../../types";
import { closeDB, getBook, initDatabase, insertBook, updateBook } from "../database";

function makeBook(): Book {
  return {
    id: "book-vec-1",
    filePath: "books/book-vec-1.epub",
    format: "epub",
    meta: { title: "索引状态回归书", author: "" },
    addedAt: 1,
    updatedAt: 1,
    progress: 0.25,
    isVectorized: false,
    vectorizeProgress: 0,
    tags: [],
    syncStatus: "local",
  };
}

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "readany-vecerr-"));
  openedDatabases = [];
  executeLog = [];
  kv.clear();
});

afterEach(async () => {
  await closeDB();
  for (const db of openedDatabases) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  openedDatabases = [];
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("vectorizeError storage roundtrip (F01)", () => {
  it("PERSISTS a vectorizeError through updateBook and reads it back after reopen", async () => {
    await initDatabase();
    await insertBook(makeBook());

    executeLog = [];
    await updateBook("book-vec-1", { vectorizeError: "embedding model unavailable" });
    const wroteColumn = executeLog.some(
      (sql) => sql.startsWith("UPDATE books") && sql.includes("vectorize_error"),
    );
    expect(wroteColumn).toBe(true);

    // Simulate app restart: close, reopen the same file, read through getBook.
    await closeDB();
    await initDatabase();
    const book = await getBook("book-vec-1");
    expect(book?.vectorizeError).toBe("embedding model unavailable");
    expect(book?.progress).toBe(0.25);
  });

  it("CLEARS the error on retry start (explicit undefined writes NULL), survives reopen", async () => {
    await initDatabase();
    await insertBook(makeBook());
    await updateBook("book-vec-1", { vectorizeError: "boom" });

    await updateBook("book-vec-1", { vectorizeError: undefined });
    await closeDB();
    await initDatabase();
    const book = await getBook("book-vec-1");
    expect(book?.vectorizeError).toBeUndefined();
  });

  it("does NOT touch vectorize_error when the field is omitted", async () => {
    await initDatabase();
    await insertBook(makeBook());
    await updateBook("book-vec-1", { vectorizeError: "boom" });

    executeLog = [];
    await updateBook("book-vec-1", { progress: 0.9 });
    expect(executeLog.some((sql) => sql.includes("vectorize_error"))).toBe(false);

    await closeDB();
    await initDatabase();
    const book = await getBook("book-vec-1");
    expect(book?.vectorizeError).toBe("boom");
    expect(book?.progress).toBe(0.9);
  });

  it("keeps legacy books readable after migration (no error, no data loss)", async () => {
    await initDatabase();
    await insertBook(makeBook());
    await closeDB();
    await initDatabase();
    const book = await getBook("book-vec-1");
    expect(book).not.toBeNull();
    expect(book?.meta.title).toBe("索引状态回归书");
    expect(book?.vectorizeError).toBeUndefined();
  });
});
