// KB-01 followup / F03 regression: cancelling a queued acquisition must NOT
// let it import, become ready, or auto-open. A occupies the (single) import
// slot; B finishes downloading and waits; cancelAcquire(B) must prevent B's
// importBooks call entirely once the slot frees. Also covers: cancel during
// the network phase stays effective, and canceling after the import has
// already started is refused (the write is not interruptible).

import type { CatalogEdition } from "@readany/core/catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  importBooksCalls: [] as string[],
  finished: [] as string[],
  failed: [] as string[],
  opened: [] as string[],
  aImportGate: null as null | (() => void),
}));

vi.mock("@readany/core/db", () => ({
  initDatabase: vi.fn(async () => {}),
}));

vi.mock("@readany/core/db/catalog-acquire-queries", () => ({
  ensureCatalogAcquireTask: vi.fn(async (id: string, url: string) => ({
    catalogEditionId: id,
    status: "downloading",
    resourceUrl: url,
    bytesDownloaded: 0,
    createdAt: 1,
    updatedAt: 1,
  })),
  getCatalogAcquireTask: vi.fn(async () => null),
  getAllCatalogAcquireTasks: vi.fn(async () => []),
  updateCatalogAcquireProgress: vi.fn(async () => {}),
  finishCatalogAcquireTask: vi.fn(async (id: string) => {
    state.finished.push(id);
  }),
  failCatalogAcquireTask: vi.fn(async (id: string) => {
    state.failed.push(id);
  }),
  resetStaleDownloadingTasks: vi.fn(async () => 0),
}));

vi.mock("@/lib/catalog/acquire-download", () => ({
  downloadAndVerifyCatalogFile: vi.fn(async (edition: CatalogEdition) => ({
    tempPath: `tmp/catalog-${edition.catalogEditionId}.epub`,
    sizeBytes: 100,
    sha256: "sha",
    format: "epub" as const,
  })),
  cleanupAcquireTempFile: vi.fn(async () => {}),
  AcquireError: class extends Error {},
}));

const importBooksMock = vi.fn(async (paths: string[]) => {
  state.importBooksCalls.push(paths[0]);
  if (paths[0].includes("edition-a")) {
    // A holds the import slot until the test releases it.
    await new Promise<void>((resolve) => {
      state.aImportGate = resolve;
    });
  }
  const bookId = paths[0].includes("edition-a") ? "book-a" : "book-b";
  return {
    imported: [{ id: bookId, meta: { title: bookId } }],
    skippedDuplicates: [],
    failures: [],
  };
});

vi.mock("@/stores/library-store", () => ({
  useLibraryStore: {
    getState: () => ({
      books: [],
      importBooks: importBooksMock,
    }),
  },
}));

vi.mock("@/lib/library/open-book", () => ({
  openDesktopBook: vi.fn(async ({ book }: { book: { id: string } }) => {
    state.opened.push(book.id);
    return true;
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { acquireOnlineEdition, cancelAcquire } from "@/lib/catalog/acquire";
import { downloadAndVerifyCatalogFile } from "@/lib/catalog/acquire-download";

function edition(id: string): CatalogEdition {
  return {
    catalogEditionId: id,
    titleZh: id,
    originalTitle: id,
    authors: [],
    language: "en",
    subjectIds: [],
    level: "unknown",
    toc: [],
    resource: {
      availability: "online",
      downloadUrl: `https://example.com/${id}.epub`,
      format: "epub",
    },
  } as unknown as CatalogEdition;
}

const t = ((key: string) => key) as unknown as Parameters<typeof acquireOnlineEdition>[1];

beforeEach(() => {
  state.importBooksCalls.length = 0;
  state.finished.length = 0;
  state.failed.length = 0;
  state.opened.length = 0;
  state.aImportGate = null;
  importBooksMock.mockClear();
  vi.mocked(downloadAndVerifyCatalogFile).mockClear();
});

describe("acquire cancellation boundaries (F03)", () => {
  it("queued import does NOT import/ready/open after cancellation", async () => {
    const promiseA = acquireOnlineEdition(edition("edition-a"), t);
    // Wait until A is INSIDE importBooks (holding the single import slot).
    await vi.waitFor(() => expect(state.importBooksCalls.length).toBe(1));

    const promiseB = acquireOnlineEdition(edition("edition-b"), t);
    // B finishes its download and waits for the import slot — give it a tick.
    await vi.waitFor(() =>
      expect(vi.mocked(downloadAndVerifyCatalogFile)).toHaveBeenCalledTimes(2),
    );

    expect(cancelAcquire("edition-b")).toBe(true);

    // Release A; A completes normally.
    state.aImportGate?.();
    const resultA = await promiseA;
    expect(resultA.status).toBe("opened");
    expect(state.finished).toContain("edition-a");

    const resultB = await promiseB;
    // REGRESSION (pre-fix): B proceeded to import, became ready and opened.
    expect(resultB.status).toBe("failed");
    expect(state.importBooksCalls.length).toBe(1); // only A was imported
    expect(state.finished).not.toContain("edition-b");
    expect(state.failed).toContain("edition-b");
    expect(state.opened).not.toContain("book-b");
  });

  it("cancel during the network phase still aborts the download", async () => {
    // Slow network: the download promise never resolves until aborted.
    vi.mocked(downloadAndVerifyCatalogFile).mockImplementationOnce(
      (_edition, _onProgress, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const promise = acquireOnlineEdition(edition("edition-net"), t);
    await vi.waitFor(() =>
      expect(vi.mocked(downloadAndVerifyCatalogFile)).toHaveBeenCalledTimes(1),
    );
    expect(cancelAcquire("edition-net")).toBe(true);
    const result = await promise;
    expect(result.status).toBe("failed");
    expect(state.failed).toContain("edition-net");
    expect(state.finished).not.toContain("edition-net");
  });

  it("cancel after the import has started is refused (non-interruptible write)", async () => {
    const promise = acquireOnlineEdition(edition("edition-a"), t);
    await vi.waitFor(() => expect(state.importBooksCalls.length).toBe(1));

    // A is already inside the (irreversible) import — no cancel is offered.
    expect(cancelAcquire("edition-a")).toBe(false);

    state.aImportGate?.();
    const result = await promise;
    expect(result.status).toBe("opened");
    expect(state.finished).toContain("edition-a");
  });
});
