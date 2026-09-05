// Cross-book ask trigger — app-layer adapter that enumerates the shelf of
// generated Book Skills (library store × derived skill files) and routes one
// question across them via the core askAcrossBooks engine. No UI here.

import { loadExistingBookSkill } from "@/lib/book-skill/trigger";
import { resolveDesktopDataPath } from "@/lib/storage/desktop-library-root";
import { useLibraryStore } from "@/stores/library-store";
import { useSettingsStore } from "@/stores/settings-store";
import { askAcrossBooks, createSqliteAskHistoryStore } from "@readany/core/book-skill";
import type {
  CrossBookAnswer,
  InstalledBookSkill,
  StoredAskAnswer,
} from "@readany/core/book-skill";
import { createBookSkillLlmClient } from "@readany/core/book-skill";
import type { Book } from "@readany/core/types";

async function shelfSkill(book: Book): Promise<InstalledBookSkill | null> {
  const skill = await loadExistingBookSkill(book);
  if (!skill) return null;
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  const skillMd = await readTextFile(`${skill.skillDir}/SKILL.md`);
  const chapters = [];
  for (const chapter of skill.manifest.chapters) {
    if (chapter.status !== "extracted") continue;
    try {
      const toolkit = await readTextFile(`${skill.skillDir}/${chapter.file}`);
      chapters.push({ bookNumber: chapter.book_number, title: chapter.title, toolkit });
    } catch {
      // A missing toolkit file shrinks that chapter's context; never blocks the ask.
    }
  }
  return {
    bookId: book.id,
    slug: skill.manifest.skill_slug,
    title: book.meta.title,
    skillMd,
    chapters,
  };
}

/** Enumerate every generated Book Skill on the shelf (library order). */
export async function getShelfSkills(): Promise<InstalledBookSkill[]> {
  const books = useLibraryStore.getState().books;
  const skills: InstalledBookSkill[] = [];
  for (const book of books) {
    try {
      await resolveDesktopDataPath(book.filePath);
      const skill = await shelfSkill(book);
      if (skill) skills.push(skill);
    } catch {
      // A book whose derived skill cannot be read is skipped, not fatal.
    }
  }
  return skills;
}

/** Ask one question across every installed Book Skill on the shelf. Semantic
 * routing (PR-011) activates from three books up — the case where keyword
 * matching actually struggles; below that the deterministic keyword router is
 * exact and saves the extra routing call (PR-017). */
export async function askTheShelf(question: string): Promise<CrossBookAnswer> {
  const skills = await getShelfSkills();
  const aiConfig = useSettingsStore.getState().aiConfig;
  const llm = await createBookSkillLlmClient(aiConfig);
  return askAcrossBooks({
    skills,
    question,
    llm,
    semanticRouting: skills.length >= 3,
  });
}

/** Ask + persist (PR-020): an ask costs several LLM calls, so the full
 * grounded report is stored and the refreshed history returned alongside. */
export async function askTheShelfAndSave(
  question: string,
): Promise<{ answer: CrossBookAnswer; history: StoredAskAnswer[] }> {
  const answer = await askTheShelf(question);
  const store = createSqliteAskHistoryStore();
  const entry: StoredAskAnswer = {
    id: crypto.randomUUID(),
    question,
    createdAt: Date.now(),
    answer,
  };
  await store.save(entry);
  const history = await store.list();
  return { answer, history };
}

/** The persisted ask history, newest first. */
export async function getAskHistory(limit?: number): Promise<StoredAskAnswer[]> {
  return createSqliteAskHistoryStore().list(limit);
}
