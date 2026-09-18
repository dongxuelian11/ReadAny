import { getDataRootReady } from "@/lib/storage/data-root-bootstrap";
import { resolveDesktopDataPath } from "@/lib/storage/desktop-library-root";
import { CATALOG_SCHEMA_VERSION } from "@readany/core/catalog";
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
  const dbExists = await exists(dbPath);
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
    // the final swap is a same-volume rename, and the previous catalog stays
    // intact until the verified replacement succeeds.
    const tmpPath = `${dbPath}.tmp`;
    const bakPath = `${dbPath}.bak`;
    try {
      await remove(tmpPath).catch(() => {});
      await copyFile(await join(seedBase, "catalog.sqlite"), tmpPath);
      await verifyStagedDb(tmpPath, manifest.db);

      if (dbExists) {
        await remove(bakPath).catch(() => {});
        await rename(dbPath, bakPath);
        try {
          await rename(tmpPath, dbPath);
        } catch (err) {
          // The new copy failed to take over — restore the previous catalog.
          await rename(bakPath, dbPath).catch(() => {});
          throw err;
        }
        await remove(bakPath).catch(() => {});
      } else {
        await rename(tmpPath, dbPath);
      }
      // Markers only after the replacement verifiably succeeded.
      await platform.kvSetItem(SEED_VERSION_KEY, String(CATALOG_SCHEMA_VERSION));
      await platform.kvSetItem(SEED_BUILT_AT_KEY, manifest.builtAt);
      installed = true;
    } catch (err) {
      if (dbExists) {
        // The stale copy still works — retry the upgrade on the next launch
        // (markers are intentionally NOT updated). Never block the library on
        // a snapshot refresh.
        console.warn("[catalog] snapshot refresh failed, using existing copy:", err);
      } else {
        throw err;
      }
    } finally {
      await remove(tmpPath).catch(() => {});
      await remove(bakPath).catch(() => {});
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
