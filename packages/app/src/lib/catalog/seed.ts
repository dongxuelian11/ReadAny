import { getDataRootReady } from "@/lib/storage/data-root-bootstrap";
import { resolveDesktopDataPath } from "@/lib/storage/desktop-library-root";
import { CATALOG_SCHEMA_VERSION } from "@readany/core/catalog";
import { planSeedSwap, promoteStagedCatalog } from "@readany/core/catalog/seed-recovery";
import { getPlatformService } from "@readany/core/services";
import { join } from "@tauri-apps/api/path";
import {
  copyFile,
  exists,
  mkdir,
  readFile,
  readTextFile,
  remove,
  rename,
} from "@tauri-apps/plugin-fs";

/**
 * First-launch catalog seeding.
 *
 * The installer ships a read-only catalog snapshot under the app resources
 * (resourceDir()/catalog-seed/). On first launch (and whenever the shipped
 * snapshot changes) the catalog.sqlite is copied into the user data dir so
 * it can be opened with plugin-sql without touching Program Files. Bundled
 * book files are read directly from the resource dir — importBooks copies
 * them into the managed library when the user chooses to read one, so the
 * resource files stay pristine and never shadow user data.
 *
 * Snapshot refresh must NEVER destroy the last usable catalog: the copy goes
 * to a temp file in the SAME directory, is verified (sha256 against the
 * manifest when present, SQLite magic as fallback), and only then replaces
 * the previous copy via rename. A failure at any point keeps the previous
 * version usable and leaves the version markers untouched so the next launch
 * retries. The user database (readany.db) is never touched by this module.
 */

export interface CatalogSeedManifestBook {
  catalogEditionId: string;
  file: string;
  format: string;
  sha256: string;
  sizeBytes: number;
  licenseId: string;
  verifiedAt: string;
}

export interface CatalogSeedManifest {
  schemaVersion: number;
  builtAt: string;
  seededAt: string;
  counts: {
    totalEditions: number;
    bundled: number;
    online: number;
    metadataOnly: number;
  };
  books: CatalogSeedManifestBook[];
  /** Integrity expectation for catalog.sqlite itself (added by newer seeds). */
  db?: {
    sha256: string;
    sizeBytes: number;
  };
}

const SEED_VERSION_KEY = "readany-catalog-seed-version";
const SEED_BUILT_AT_KEY = "readany-catalog-seed-builtat";

const SQLITE_MAGIC = "SQLite format 3\0";

let seedBasePromise: Promise<string> | null = null;

/** Absolute path of the shipped catalog-seed directory (inside app resources). */
export async function getCatalogSeedBase(): Promise<string> {
  if (!seedBasePromise) {
    seedBasePromise = (async () => {
      const { resourceDir } = await import("@tauri-apps/api/path");
      const base = await join(await resourceDir(), "catalog-seed");
      if (await exists(await join(base, "catalog.sqlite"))) {
        return base;
      }
      throw new Error(
        `Catalog seed not found at ${base}. Rebuild it with: pnpm catalog:build && pnpm catalog:seed`,
      );
    })();
  }
  return seedBasePromise;
}

export interface CatalogSeedResult {
  dbPath: string;
  seedBase: string;
  manifest: CatalogSeedManifest;
  /** True when the DB was (re)copied this launch. */
  installed: boolean;
}

/**
 * Ensure the read-only catalog snapshot exists in the user data dir and is
 * up to date with the shipped version. Single-flight: concurrent callers
 * (page effects + the DB opener) share one run — two concurrent copies of the
 * same target file fail with a sharing violation on Windows.
 */
let seedPromise: Promise<CatalogSeedResult> | null = null;

export function ensureCatalogSeeded(): Promise<CatalogSeedResult> {
  if (!seedPromise) {
    seedPromise = doEnsureCatalogSeeded().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Verify a staged copy looks like a complete catalog DB before replacing. */
async function verifyStagedDb(tmpPath: string, expected: CatalogSeedManifest["db"]): Promise<void> {
  const bytes = await readFile(tmpPath);
  if (bytes.length === 0) throw new Error("staged catalog copy is empty");
  if (expected) {
    if (expected.sizeBytes && bytes.length !== expected.sizeBytes) {
      throw new Error(`staged catalog size mismatch: ${bytes.length} != ${expected.sizeBytes}`);
    }
    const hash = await sha256Hex(bytes);
    if (hash !== expected.sha256) {
      throw new Error(`staged catalog sha256 mismatch: ${hash.slice(0, 16)}…`);
    }
  } else {
    const magic = String.fromCharCode(...bytes.subarray(0, 16));
    if (magic !== SQLITE_MAGIC) {
      throw new Error("staged catalog is not a SQLite database (bad magic)");
    }
  }
}

async function doEnsureCatalogSeeded(): Promise<CatalogSeedResult> {
  // Wait for the data-root placement/migration so the snapshot lands on the
  // final root (D: drive) instead of racing into the default AppData location.
  await getDataRootReady();
  const seedBase = await getCatalogSeedBase();
  const manifest: CatalogSeedManifest = JSON.parse(
    await readTextFile(await join(seedBase, "manifest.json")),
  );
  const dbPath = await resolveDesktopDataPath("catalog/catalog.sqlite");

  const platform = getPlatformService();
  const [storedVersion, storedBuiltAt] = await Promise.all([
    platform.kvGetItem(SEED_VERSION_KEY),
    platform.kvGetItem(SEED_BUILT_AT_KEY),
  ]);
  let dbExists = await exists(dbPath);
  const bakPath = `${dbPath}.bak`;

  // KB-01/F02: a leftover .bak (previous launch died mid-swap) IS the newest
  // catalog — recover it before any copying, and fail loudly (keeping the
  // backup) if recovery fails, instead of copying over it or faking an OK.
  const plan = planSeedSwap({ dbExists, bakExists: await exists(bakPath) });
  if (plan.phase === "recover-bak") {
    try {
      await rename(bakPath, dbPath);
      dbExists = true;
      console.warn("[catalog] recovered catalog from leftover .bak");
    } catch (err) {
      throw new Error(
        `catalog.sqlite is missing and its backup could not be restored: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const needsInstall =
    !dbExists ||
    storedVersion !== String(manifest.schemaVersion) ||
    storedBuiltAt !== manifest.builtAt;

  let installed = false;
  if (needsInstall) {
    const catalogDir = await resolveDesktopDataPath("catalog");
    try {
      await mkdir(catalogDir, { recursive: true });
    } catch {
      /* already exists */
    }

    // Stage → verify → replace. Everything happens in the same directory so
    // the final swap is a same-volume rename. The backup is removed ONLY once
    // the new snapshot verifiably took over; a promotion+restore double
    // failure keeps it for the next launch's recovery (planSeedSwap).
    const tmpPath = `${dbPath}.tmp`;
    try {
      await remove(tmpPath).catch(() => {});
      await copyFile(await join(seedBase, "catalog.sqlite"), tmpPath);
      await verifyStagedDb(tmpPath, manifest.db);

      if (dbExists) {
        await remove(bakPath).catch(() => {});
        await rename(dbPath, bakPath);
        const swap = await promoteStagedCatalog({
          promote: () => rename(tmpPath, dbPath),
          restore: () => rename(bakPath, dbPath),
        });
        if (swap.outcome === "promoted") {
          await remove(bakPath).catch(() => {});
        } else if (swap.outcome === "restored") {
          // Old copy is back in place; markers stay stale so the next launch
          // retries the refresh. Surface the real cause.
          console.warn(
            `[catalog] snapshot promote failed, old copy restored: ${swap.promoteError}`,
          );
        } else {
          // Double failure: the .bak is the ONLY recoverable copy — never
          // delete it here. The next launch recovers via planSeedSwap.
          throw new Error(
            `catalog swap failed (promote: ${swap.promoteError}) AND restore failed (${swap.restoreError}) — backup kept at ${bakPath}`,
          );
        }
      } else {
        await rename(tmpPath, dbPath);
      }
      // Markers only after the replacement verifiably succeeded.
      await platform.kvSetItem(SEED_VERSION_KEY, String(CATALOG_SCHEMA_VERSION));
      await platform.kvSetItem(SEED_BUILT_AT_KEY, manifest.builtAt);
      installed = true;
    } catch (err) {
      if (dbExists && (await exists(dbPath).catch(() => false))) {
        // The old copy is still in place — retry the upgrade on the next
        // launch (markers are intentionally NOT updated). Never block the
        // library on a snapshot refresh.
        console.warn("[catalog] snapshot refresh failed, using existing copy:", err);
      } else if (dbExists) {
        // The old copy was moved away and did not come back — say so instead
        // of pretending an existing copy is in use.
        throw new Error(
          `catalog.sqlite is missing after a failed swap; backup may exist at ${bakPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } else {
        throw err;
      }
    } finally {
      await remove(tmpPath).catch(() => {});
    }
  }

  // One-click downloads interrupted by a crash/kill never show a phantom
  // "ready" — they become retryable failures on the next launch.
  const { resetStaleDownloadingTasks } = await import("@readany/core/db/catalog-acquire-queries");
  const { initDatabase } = await import("@readany/core/db");
  try {
    await initDatabase();
    const reset = await resetStaleDownloadingTasks();
    if (reset > 0) console.log(`[catalog] reset ${reset} interrupted download task(s)`);
  } catch (err) {
    console.warn("[catalog] stale download reset failed:", err);
  }

  return { dbPath, seedBase, manifest, installed };
}
