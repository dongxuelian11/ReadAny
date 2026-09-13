import { getDataRootReady } from "@/lib/storage/data-root-bootstrap";
import { resolveDesktopDataPath } from "@/lib/storage/desktop-library-root";
import { CATALOG_SCHEMA_VERSION } from "@readany/core/catalog";
import { getPlatformService } from "@readany/core/services";
import { join } from "@tauri-apps/api/path";
import { copyFile, exists, mkdir, readTextFile } from "@tauri-apps/plugin-fs";

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
}

const SEED_VERSION_KEY = "readany-catalog-seed-version";
const SEED_BUILT_AT_KEY = "readany-catalog-seed-builtat";

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
 * up to date with the shipped version. Safe to call repeatedly; cheap when
 * already seeded.
 */
export async function ensureCatalogSeeded(): Promise<CatalogSeedResult> {
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

  if (needsInstall) {
    const catalogDir = await resolveDesktopDataPath("catalog");
    try {
      await mkdir(catalogDir, { recursive: true });
    } catch {
      /* already exists */
    }
    await copyFile(await join(seedBase, "catalog.sqlite"), dbPath);
    await platform.kvSetItem(SEED_VERSION_KEY, String(CATALOG_SCHEMA_VERSION));
    await platform.kvSetItem(SEED_BUILT_AT_KEY, manifest.builtAt);
  }

  return { dbPath, seedBase, manifest, installed: needsInstall };
}
