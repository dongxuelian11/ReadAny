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
  });
  return result;
}

/** Load an already-generated skill without any LLM calls; null when absent. */
export async function loadExistingBookSkill(book: Book): Promise<BookSkillResult | null> {
  const fs = createTauriBookSkillFs();
  return loadBookSkill(fs, await resolveSkillDir(book.id));
}

export async function deleteBookSkill(bookId: string): Promise<void> {
  const fs = createTauriBookSkillFs();
  await fs.remove(await resolveSkillDir(bookId));
  useBookSkillStore.getState().removeEntry(bookId);
}
