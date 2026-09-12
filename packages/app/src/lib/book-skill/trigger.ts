// Book Skill trigger — app-layer adapter bridging platform concerns (Zustand
// stores, canonical chapter extraction, Tauri fs) with the core pipeline.
// Mirrors the vectorize-trigger pattern: read stores, extract chapters, run
// the core pipeline, write results back.

import { createTauriBookSkillFs } from "@/lib/book-skill/fs-adapter";
import { useBookSkillStore } from "@/stores/book-skill-store";
import { useSettingsStore } from "@/stores/settings-store";
import { fallbackContentService } from "@readany/core/ai";
import {
  createBookSkillLlmClient,
  estimateBookSkillCost,
  generateBookSkill,
  loadBookSkill,
} from "@readany/core/book-skill";
import type { BookSkillProgress, BookSkillResult } from "@readany/core/book-skill";
import { getPlatformService } from "@readany/core/services";
import type { Book } from "@readany/core/types";

export interface BookSkillEstimateResult {
  chapterCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  existing: boolean;
}

/** Why a loaded skill was rejected as stale (PR-018). */
export type BookSkillStaleReason = "book-file-changed" | "genre-changed";

async function resolveSkillDir(bookId: string): Promise<string> {
  const platform = getPlatformService();
  const appData = await platform.getAppDataDir();
  return platform.joinPath(appData, "book-skills", bookId);
}

async function canonicalChapters(book: Book) {
  const chapters = await fallbackContentService.getChapters(book);
  const usable = chapters.filter((chapter) => chapter.content.trim().length > 0);
  if (usable.length === 0) {
    throw new Error("The book has no extractable chapter content");
  }
  return usable;
}

export async function estimateBookSkillForBook(book: Book): Promise<BookSkillEstimateResult> {
  const chapters = await canonicalChapters(book);
  const estimate = estimateBookSkillCost(
    chapters.map((chapter) => ({ title: chapter.title, content: chapter.content })),
  );
  const fs = createTauriBookSkillFs();
  const existing = await loadBookSkill(fs, await resolveSkillDir(book.id));
  return {
    chapterCount: estimate.chapterCount,
    estimatedInputTokens: estimate.estimatedInputTokens,
    estimatedOutputTokens: estimate.estimatedOutputTokens,
    existing: existing !== null,
  };
}

export async function generateBookSkillForBook(
  book: Book,
  onProgress?: (progress: BookSkillProgress) => void,
): Promise<BookSkillResult> {
  const [chapters, skillDir] = await Promise.all([
    canonicalChapters(book),
    resolveSkillDir(book.id),
  ]);
  const aiConfig = useSettingsStore.getState().aiConfig;
  const genre = useBookSkillStore.getState().getGenrePreference(book.id);

  const client = await createBookSkillLlmClient(aiConfig);
  const fs = createTauriBookSkillFs();
  const result = await generateBookSkill({
    request: {
      book: { id: book.id, title: book.meta.title, author: book.meta.author || undefined },
      chapters: chapters.map((chapter) => ({
        index: chapter.index,
        title: chapter.title,
        content: chapter.content,
      })),
      genre,
    },
    client,
    fs,
    skillDir,
    concurrency: 4,
    onProgress,
  });

  useBookSkillStore.getState().setEntry(book.id, {
    genre,
    builtAt: result.manifest.built_at,
    contentVersion: result.manifest.readany.content_version,
    chapters: result.manifest.readany.chapters,
    fileFingerprint: await bookFileFingerprint(book),
  });
  return result;
}

/** Cheap staleness probe: the source file's size + mtime (O(1) stat — no
 * chapter re-extraction). Null when the file cannot be statted; a probe
 * failure never invalidates a skill on its own. */
async function bookFileFingerprint(
  book: Book,
): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const { stat } = await import("@tauri-apps/plugin-fs");
    // WP-B (S27): resolve through the shared desktop-library-root resolver —
    // book.filePath may be a managed relative path that a bare stat misses.
    const { resolveDesktopDataPath } = await import("@/lib/storage/desktop-library-root");
    const info = await stat(await resolveDesktopDataPath(book.filePath));
    return { size: info.size, mtimeMs: info.mtime?.getTime() ?? 0 };
  } catch {
    return undefined;
  }
}

/** The loaded skill is stale when the store remembers a different source-file
 * fingerprint (the book was re-imported or edited) or the user's genre
 * preference changed after generation. Legacy entries without a fingerprint
 * are never reported stale (documented transitional gap). */

/** Load an already-generated skill without any LLM calls; null when absent or
 * STALE (fail-closed: data consumers fall back to canonical extraction rather
 * than reading a skill built from different book content). */
export async function loadExistingBookSkill(book: Book): Promise<BookSkillResult | null> {
  const fs = createTauriBookSkillFs();
  const result = await loadBookSkill(fs, await resolveSkillDir(book.id));
  if (!result) return null;
  const store = useBookSkillStore.getState();
  const entry = store.getEntry(book.id);
  if (entry) {
    if (entry.genre !== store.getGenrePreference(book.id)) return null;
    if (entry.fileFingerprint) {
      const current = await bookFileFingerprint(book);
      if (
        current &&
        (current.size !== entry.fileFingerprint.size ||
          current.mtimeMs !== entry.fileFingerprint.mtimeMs)
      ) {
        return null;
      }
    }
  }
  return result;
}

/** Load + staleness classification for the panel: unlike
 * `loadExistingBookSkill` (which silently hides a stale skill), this reports
 * WHY the skill is gone so the UI can offer regeneration. */
export async function inspectBookSkill(book: Book): Promise<{
  result: BookSkillResult | null;
  staleReason: BookSkillStaleReason | null;
}> {
  const fs = createTauriBookSkillFs();
  const result = await loadBookSkill(fs, await resolveSkillDir(book.id));
  if (!result) return { result: null, staleReason: null };
  const store = useBookSkillStore.getState();
  const entry = store.getEntry(book.id);
  if (entry && entry.genre !== store.getGenrePreference(book.id)) {
    return { result, staleReason: "genre-changed" };
  }
  if (entry?.fileFingerprint) {
    const current = await bookFileFingerprint(book);
    if (
      current &&
      (current.size !== entry.fileFingerprint.size ||
        current.mtimeMs !== entry.fileFingerprint.mtimeMs)
    ) {
      return { result, staleReason: "book-file-changed" };
    }
  }
  return { result, staleReason: null };
}

export async function deleteBookSkill(bookId: string): Promise<void> {
  const fs = createTauriBookSkillFs();
  await fs.remove(await resolveSkillDir(bookId));
  useBookSkillStore.getState().removeEntry(bookId);
}
