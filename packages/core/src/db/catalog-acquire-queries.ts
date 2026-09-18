/**
 * Catalog acquire task queries (LIB-2 one-click full-text acquisition).
 *
 * One task per catalog edition, stored in the user library database:
 *  - downloading: a fetch is (or was) in flight; reset to failed on launch
 *  - ready: file verified, imported into the library, book_id linked
 *  - failed: nothing to show in the library; user can retry
 */

import { getDB } from "./db-core";

export type CatalogAcquireStatus = "downloading" | "ready" | "failed";

export interface CatalogAcquireTask {
  catalogEditionId: string;
  status: CatalogAcquireStatus;
  bookId?: string;
  resourceUrl?: string;
  expectedSha256?: string;
  bytesDownloaded: number;
  totalBytes?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

interface CatalogAcquireTaskRow {
  catalog_edition_id: string;
  status: CatalogAcquireStatus;
  book_id: string | null;
  resource_url: string | null;
  expected_sha256: string | null;
  bytes_downloaded: number;
  total_bytes: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToTask(r: CatalogAcquireTaskRow): CatalogAcquireTask {
  return {
    catalogEditionId: r.catalog_edition_id,
    status: r.status,
    bookId: r.book_id ?? undefined,
    resourceUrl: r.resource_url ?? undefined,
    expectedSha256: r.expected_sha256 ?? undefined,
    bytesDownloaded: r.bytes_downloaded,
    totalBytes: r.total_bytes ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getCatalogAcquireTask(
  catalogEditionId: string,
): Promise<CatalogAcquireTask | null> {
  const db = await getDB();
  const rows = await db.select<CatalogAcquireTaskRow>(
    "SELECT * FROM catalog_acquire_tasks WHERE catalog_edition_id = ?",
    [catalogEditionId],
  );
  return rows[0] ? rowToTask(rows[0]) : null;
}

export async function getAllCatalogAcquireTasks(): Promise<CatalogAcquireTask[]> {
  const db = await getDB();
  const rows = await db.select<CatalogAcquireTaskRow>(
    "SELECT * FROM catalog_acquire_tasks ORDER BY updated_at DESC",
  );
  return rows.map(rowToTask);
}

export async function ensureCatalogAcquireTask(
  catalogEditionId: string,
  resourceUrl: string,
  expectedSha256?: string,
): Promise<CatalogAcquireTask> {
  const db = await getDB();
  const now = Date.now();
  await db.execute(
    `INSERT INTO catalog_acquire_tasks
       (catalog_edition_id, status, resource_url, expected_sha256, bytes_downloaded, created_at, updated_at)
     VALUES (?, 'downloading', ?, ?, 0, ?, ?)
     ON CONFLICT(catalog_edition_id) DO UPDATE SET
       status='downloading', resource_url=excluded.resource_url,
       expected_sha256=excluded.expected_sha256, bytes_downloaded=0,
       error=NULL, updated_at=excluded.updated_at`,
    [catalogEditionId, resourceUrl, expectedSha256 ?? null, now, now],
  );
  const task = await getCatalogAcquireTask(catalogEditionId);
  if (!task) throw new Error(`Failed to create acquire task for ${catalogEditionId}`);
  return task;
}

export async function updateCatalogAcquireProgress(
  catalogEditionId: string,
  bytesDownloaded: number,
  totalBytes?: number,
): Promise<void> {
  const db = await getDB();
  await db.execute(
    "UPDATE catalog_acquire_tasks SET bytes_downloaded = ?, total_bytes = ?, updated_at = ? WHERE catalog_edition_id = ?",
    [bytesDownloaded, totalBytes ?? null, Date.now(), catalogEditionId],
  );
}

export async function finishCatalogAcquireTask(
  catalogEditionId: string,
  bookId: string,
): Promise<void> {
  const db = await getDB();
  await db.execute(
    "UPDATE catalog_acquire_tasks SET status = 'ready', book_id = ?, error = NULL, updated_at = ? WHERE catalog_edition_id = ?",
    [bookId, Date.now(), catalogEditionId],
  );
}

export async function failCatalogAcquireTask(
  catalogEditionId: string,
  error: string,
): Promise<void> {
  const db = await getDB();
  await db.execute(
    "UPDATE catalog_acquire_tasks SET status = 'failed', error = ?, updated_at = ? WHERE catalog_edition_id = ?",
    [error.slice(0, 500), Date.now(), catalogEditionId],
  );
}

/**
 * Startup recovery: any task left 'downloading' by a crash/kill becomes
 * 'failed' — nothing is shown as ready until its file passed verification
 * and import in a single live session.
 */
export async function resetStaleDownloadingTasks(): Promise<number> {
  const db = await getDB();
  const rows = await db.select<{ n: number }>(
    "SELECT COUNT(*) AS n FROM catalog_acquire_tasks WHERE status = 'downloading'",
  );
  await db.execute(
    "UPDATE catalog_acquire_tasks SET status = 'failed', error = '中断——请重试下载', updated_at = ? WHERE status = 'downloading'",
    [Date.now()],
  );
  return rows[0]?.n ?? 0;
}
