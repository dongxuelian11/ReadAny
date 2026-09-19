import { openDesktopBook } from "@/lib/library/open-book";
import { useLibraryStore } from "@/stores/library-store";
import type { CatalogEdition } from "@readany/core/catalog";
import { initDatabase } from "@readany/core/db";
import {
  type CatalogAcquireTask,
  ensureCatalogAcquireTask,
  failCatalogAcquireTask,
  finishCatalogAcquireTask,
  getAllCatalogAcquireTasks,
  getCatalogAcquireTask,
  updateCatalogAcquireProgress,
} from "@readany/core/db/catalog-acquire-queries";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import { cleanupAcquireTempFile, downloadAndVerifyCatalogFile } from "./acquire-download";
import { getCatalogSeedBase } from "./seed";

/**
 * Install a bundled catalog edition into the user library and open it in the
 * existing Reader. Everything runs through the standard importBooks path —
 * hash-based dedupe, managed books/ storage, metadata extraction — so a
 * bundled book behaves exactly like a locally imported one afterwards.
 *
 * LIB-1 scope: bundled editions only. Network acquisition for online
 * editions arrives with LIB-2; for now those entries open the official
 * landing page instead.
 */

export async function getBundledBookPath(edition: CatalogEdition): Promise<string> {
  if (!edition.bundledFile) {
    throw new Error(`edition ${edition.catalogEditionId} is not bundled`);
  }
  const { join: joinPath } = await import("@tauri-apps/api/path");
  return joinPath(await getCatalogSeedBase(), "books", edition.bundledFile);
}

/** Find the user book that came from this bundled resource via its file hash. */
export async function findInstalledBundledBook(edition: CatalogEdition) {
  const sha = edition.resource.sha256;
  if (!sha) return undefined;
  return useLibraryStore.getState().books.find((b) => b.fileHash === sha);
}

export type InstallCatalogResult =
  | { status: "opened"; bookId: string }
  | { status: "failed"; message: string };

/**
 * Install (once) and open a bundled book. Repeated invocations reuse the
 * existing book (hash dedupe in importBooks + the sha256 lookup above);
 * the resource file itself is never modified.
 */
export async function installAndOpenBundledBook(
  edition: CatalogEdition,
  t: TFunction,
): Promise<InstallCatalogResult> {
  try {
    const existing = await findInstalledBundledBook(edition);
    if (existing) {
      const ok = await openDesktopBook({ book: existing, t });
      return ok ? { status: "opened", bookId: existing.id } : { status: "failed", message: "open" };
    }

    const srcPath = await getBundledBookPath(edition);
    const result = await useLibraryStore.getState().importBooks([srcPath]);

    const imported = result.imported[0];
    if (imported) {
      const ok = await openDesktopBook({ book: imported, t });
      return ok ? { status: "opened", bookId: imported.id } : { status: "failed", message: "open" };
    }
    // importBooks skipped the file as a duplicate of an existing book.
    const duplicate = result.skippedDuplicates[0]?.existingBook;
    if (duplicate) {
      const ok = await openDesktopBook({ book: duplicate, t });
      return ok
        ? { status: "opened", bookId: duplicate.id }
        : { status: "failed", message: "open" };
    }
    const failure = result.failures[0];
    const message = failure?.error ?? t("catalog.installUnknownError", "安装失败，请稍后再试。");
    toast.error(`${t("catalog.installFailed", "无法加入书库")}: ${message}`);
    return { status: "failed", message };
  } catch (err) {
    console.error("[catalog] install failed:", err);
    toast.error(
      `${t("catalog.installFailed", "无法加入书库")}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { status: "failed", message: String(err) };
  }
}

// ── LIB-2: one-click acquisition of online (non-bundled) editions ─────────

const inFlightEditions = new Set<string>();
const progressListeners = new Set<(tasks: Record<string, CatalogAcquireTask>) => void>();
let tasksCache: Record<string, CatalogAcquireTask> = {};

/**
 * KB-01/F04: bounded global concurrency. The per-edition in-flight set above
 * only prevents duplicate runs of the SAME edition; without a global cap a
 * bulk batch could start unbounded parallel downloads (each buffering up to
 * 200MiB in memory) and unbounded parallel imports. First version: 2 network
 * downloads, 1 import/parse (imports are serialized so the same content
 * downloaded via two editions dedupes into ONE library book instead of
 * racing two importBooks calls).
 */
const MAX_CONCURRENT_DOWNLOADS = 2;
const MAX_CONCURRENT_IMPORTS = 1;

/** Cancellation handles per edition (cancelAcquire aborts the network phase). */
const activeControllers = new Map<string, AbortController>();

export function cancelAcquire(catalogEditionId: string): boolean {
  const controller = activeControllers.get(catalogEditionId);
  if (!controller) return false;
  controller.abort(new Error("用户取消了下载"));
  return true;
}

function makeSlot(maxRunning: number) {
  let running = 0;
  const waiters: Array<() => void> = [];
  return async function run<T>(job: () => Promise<T>): Promise<T> {
    while (running >= maxRunning) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    running++;
    try {
      return await job();
    } finally {
      running--;
      waiters.shift()?.();
    }
  };
}

const withDownloadSlot = makeSlot(MAX_CONCURRENT_DOWNLOADS);
const withImportSlot = makeSlot(MAX_CONCURRENT_IMPORTS);

export function subscribeAcquireTasks(
  listener: (tasks: Record<string, CatalogAcquireTask>) => void,
): () => void {
  progressListeners.add(listener);
  listener(tasksCache);
  return () => progressListeners.delete(listener);
}

function emitTasks() {
  for (const listener of progressListeners) listener(tasksCache);
}

async function setTask(task: CatalogAcquireTask | null, editionId: string) {
  if (task) tasksCache = { ...tasksCache, [editionId]: task };
  else {
    const next = { ...tasksCache };
    delete next[editionId];
    tasksCache = next;
  }
  emitTasks();
}

/** Refresh task states (called once when the catalog UI loads). */
export async function refreshAcquireTasks(): Promise<void> {
  try {
    await initDatabase();
    const tasks = await getAllCatalogAcquireTasks();
    const next: Record<string, CatalogAcquireTask> = {};
    for (const task of tasks) next[task.catalogEditionId] = task;
    tasksCache = next;
    emitTasks();
  } catch (err) {
    console.warn("[catalog] acquire task refresh failed:", err);
  }
}

export type AcquireOnlineResult =
  | { status: "opened"; bookId: string }
  | { status: "failed"; message: string };

/**
 * Download an online edition's full text, verify it, import it through the
 * standard importBooks path and open it. One task per edition; repeated
 * clicks while a download is in flight are ignored; failures leave the task
 * in 'failed' (retryable) and never fake a library entry.
 */
export async function acquireOnlineEdition(
  edition: CatalogEdition,
  t: TFunction,
): Promise<AcquireOnlineResult> {
  const editionId = edition.catalogEditionId;
  if (inFlightEditions.has(editionId)) {
    return { status: "failed", message: "downloading" };
  }
  inFlightEditions.add(editionId);
  const controller = new AbortController();
  activeControllers.set(editionId, controller);
  let tempPath: string | null = null;
  try {
    await initDatabase();
    // Already acquired → open the linked book instead of re-downloading.
    const existingTask = await getCatalogAcquireTask(editionId);
    if (existingTask?.status === "ready" && existingTask.bookId) {
      const owned = useLibraryStore.getState().books.find((b) => b.id === existingTask.bookId);
      if (owned) {
        const ok = await openDesktopBook({ book: owned, t });
        return ok ? { status: "opened", bookId: owned.id } : { status: "failed", message: "open" };
      }
    }
    const task = await ensureCatalogAcquireTask(
      editionId,
      edition.resource.downloadUrl ?? "",
      edition.resource.sha256,
    );
    await setTask(task, editionId);

    // Global download slot (2) + cancellation: the abort signal reaches the
    // real network fetch; a user cancel fails the task without fake progress.
    const temp = await withDownloadSlot(() =>
      downloadAndVerifyCatalogFile(
        edition,
        (bytes, total) => {
          const snapshot: CatalogAcquireTask = {
            ...task,
            status: "downloading",
            bytesDownloaded: bytes,
            totalBytes: total,
          };
          void setTask(snapshot, editionId);
          updateCatalogAcquireProgress(editionId, bytes, total).catch(() => {});
        },
        controller.signal,
      ),
    );
    tempPath = temp.tempPath;

    const result = await withImportSlot(() =>
      useLibraryStore.getState().importBooks([temp.tempPath]),
    );
    await cleanupAcquireTempFile(temp.tempPath);
    tempPath = null;

    const book = result.imported[0] ?? result.skippedDuplicates[0]?.existingBook;
    if (!book) {
      const message =
        result.failures[0]?.error ?? t("catalog.installUnknownError", "安装失败，请稍后再试。");
      const failedTask = { ...task, status: "failed" as const, error: message };
      await failCatalogAcquireTask(editionId, message);
      await setTask(failedTask, editionId);
      toast.error(`${t("catalog.acquireFailed", "获取失败")}: ${message}`);
      return { status: "failed", message };
    }

    await finishCatalogAcquireTask(editionId, book.id);
    const doneTask: CatalogAcquireTask = {
      ...task,
      status: "ready",
      bookId: book.id,
      bytesDownloaded: temp.sizeBytes,
      totalBytes: temp.sizeBytes,
      error: undefined,
    };
    await setTask(doneTask, editionId);

    const ok = await openDesktopBook({ book, t });
    return ok ? { status: "opened", bookId: book.id } : { status: "failed", message: "open" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[catalog] acquire failed:", err);
    await failCatalogAcquireTask(editionId, message).catch(() => {});
    await refreshAcquireTasks();
    toast.error(`${t("catalog.acquireFailed", "获取失败")}: ${message}`);
    return { status: "failed", message };
  } finally {
    // The staged temp file must never leak — even when importBooks threw.
    if (tempPath) await cleanupAcquireTempFile(tempPath);
    activeControllers.delete(editionId);
    inFlightEditions.delete(editionId);
  }
}
