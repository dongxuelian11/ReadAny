import { openDesktopBook } from "@/lib/library/open-book";
import { useLibraryStore } from "@/stores/library-store";
import type { CatalogEdition } from "@readany/core/catalog";
import type { TFunction } from "i18next";
import { toast } from "sonner";
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
