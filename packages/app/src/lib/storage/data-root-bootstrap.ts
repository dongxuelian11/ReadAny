import { getPlatformService } from "@readany/core/services";
import { join } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  getDefaultDesktopLibraryRoot,
  getDesktopLibraryRoot,
  setDesktopLibraryRoot,
} from "./desktop-library-root";

/**
 * Data-root placement for the desktop library.
 *
 * The bulk of the library's disk usage — imported book files, covers, the
 * catalog snapshot copy and the SQLite databases — lives under the data root
 * (see desktop-library-root.ts / core db-core getDesktopDataRoot). By default
 * that is the per-user AppData directory on the system drive, which users do
 * not want filling up with large book data.
 *
 * On the first run after install this bootstrap moves/places the data root on
 * a fixed data drive (D: by preference) once:
 *  - A user-configured root always wins and is never touched.
 *  - A fresh install (no data yet) is simply pointed at the new root.
 *  - An existing install is migrated once through the app's own supported
 *    migration path (books, covers, fonts and DB files are copied to the new
 *    root before the old files are removed).
 *  - Every decision is recorded in a KV marker so it never runs twice, and
 *    any failure falls back to the default location without blocking startup.
 */

const AUTO_MARKER_KEY = "readany-data-root-auto-placed";
const CANDIDATE_DRIVE_LETTERS = ["D", "E", "F"];
const ROOT_DIR_NAME = "ReadAnyData";

async function probeWritableRoot(driveLetter: string): Promise<string | null> {
  const root = `${driveLetter}:\\${ROOT_DIR_NAME}`;
  try {
    await mkdir(root, { recursive: true });
    const probe = await join(root, ".readany-write-probe");
    await writeTextFile(probe, "ok");
    await remove(probe);
    return root;
  } catch {
    return null;
  }
}

async function hasExistingLibraryDataAt(root: string): Promise<boolean> {
  try {
    if (await exists(await join(root, "readany.db"))) return true;
    const booksDir = await join(root, "books");
    if (!(await exists(booksDir))) return false;
    const entries = await readDir(booksDir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

export async function ensureDesktopDataRootPlacement(): Promise<void> {
  const platform = getPlatformService();
  try {
    if ((await platform.kvGetItem(AUTO_MARKER_KEY)) === "1") return;

    const [currentRoot, defaultRoot] = await Promise.all([
      getDesktopLibraryRoot(),
      getDefaultDesktopLibraryRoot(),
    ]);
    if (
      currentRoot.replace(/[\\/]+$/, "").toLowerCase() !==
      defaultRoot.replace(/[\\/]+$/, "").toLowerCase()
    ) {
      // The user (or a previous setup) already configured a data root.
      await platform.kvSetItem(AUTO_MARKER_KEY, "1");
      return;
    }

    let targetRoot: string | null = null;
    for (const driveLetter of CANDIDATE_DRIVE_LETTERS) {
      targetRoot = await probeWritableRoot(driveLetter);
      if (targetRoot) break;
    }
    if (!targetRoot) {
      console.info("[Storage] No alternative data drive found; keeping default data root.");
      await platform.kvSetItem(AUTO_MARKER_KEY, "1");
      return;
    }

    if (await hasExistingLibraryDataAt(defaultRoot)) {
      const { migrateDesktopLibraryRoot } = await import("./desktop-library-root");
      const result = await migrateDesktopLibraryRoot(targetRoot);
      console.log(
        `[Storage] Migrated library data to ${targetRoot} (moved ${result.movedFiles} files).`,
      );
    } else {
      await setDesktopLibraryRoot(targetRoot);
      console.log(`[Storage] Library data root placed at ${targetRoot}.`);
    }
    await platform.kvSetItem(AUTO_MARKER_KEY, "1");
  } catch (err) {
    // Never block startup on placement — the default root keeps working.
    console.warn("[Storage] Data root placement failed, using default location:", err);
    try {
      await platform.kvSetItem(AUTO_MARKER_KEY, "1");
    } catch {
      /* ignore */
    }
  }
}
