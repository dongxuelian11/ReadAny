// Teaching trigger — app-layer adapter assembling the engine deps for the
// Agent 带读 flow: curriculum steps are taught from the canonical ReadAny
// chapter text (fallback extraction, capped by the core), answers are graded
// deterministically and recorded through applyEvidenceEvent. No UI here.
//
// Iter-2: generation deps (whole-book extraction + model client) and answer
// deps (stores only) are split. Answering a step never re-extracts the book
// or builds a model client, and the extraction is cached per book so
// delivering each step does not re-parse the EPUB.

import { extractBookChapters } from "@/lib/rag/book-extractor";
import { resolveDesktopDataPath } from "@/lib/storage/desktop-library-root";
import { useSettingsStore } from "@/stores/settings-store";
import { createBookSkillLlmClient } from "@readany/core/book-skill";
import {
  answerCurrentStep as coreAnswerCurrentStep,
  deliverCurrentStep as coreDeliverCurrentStep,
  getActiveTeachingSession as coreGetActiveTeachingSession,
  startTeachingSession as coreStartTeachingSession,
  createSqliteLearnerStores,
} from "@readany/core/learner";
import type { TeachingLlmClient } from "@readany/core/learner";
import type { PersonalCurriculum, TeachingSession } from "@readany/core/learner";
import type { Book } from "@readany/core/types";

interface CachedExtraction {
  chapters: Map<number, string>;
}

/** Per-book chapter-text cache. The path is stable per book row (re-importing
 * an EPUB creates a new book id), and the cache is bounded so a long session
 * across many books cannot grow unbounded. */
const extractionCache = new Map<string, CachedExtraction>();
const EXTRACTION_CACHE_MAX = 4;

async function cachedChapterTexts(book: Book): Promise<Map<number, string>> {
  const cached = extractionCache.get(book.id);
  if (cached) return cached.chapters;
  const chapters = await extractBookChapters(await resolveDesktopDataPath(book.filePath));
  const textByIndex = new Map(chapters.map((chapter) => [chapter.index, chapter.content]));
  if (extractionCache.size >= EXTRACTION_CACHE_MAX) {
    const oldest = extractionCache.keys().next().value;
    if (oldest !== undefined) extractionCache.delete(oldest);
  }
  extractionCache.set(book.id, { chapters: textByIndex });
  return textByIndex;
}

function chapterTextProvider(textByIndex: Map<number, string>) {
  return async (conceptId: string): Promise<string> => {
    const match = /readany:book:[^:]+:chapter:(\d+)$/.exec(conceptId);
    const text = match ? (textByIndex.get(Number(match[1])) ?? "") : "";
    if (!text.trim()) throw new Error(`No canonical chapter text available for ${conceptId}`);
    return text;
  };
}

/** Full generation deps: cached chapter text + model client. Only content
 * generation needs this — answering must never touch it. */
export async function createTeachingGenerationDeps(book: Book) {
  const textByIndex = await cachedChapterTexts(book);
  const llm: TeachingLlmClient = await createBookSkillLlmClient(
    useSettingsStore.getState().aiConfig,
  );
  return {
    clock: { now: (): Date => new Date() },
    ...createSqliteLearnerStores(),
    llm,
    chapterText: chapterTextProvider(textByIndex),
  };
}

/** Answer-path deps: deterministic stores only. No book extraction, no model
 * client — grading is local and must stay cheap and offline-safe. */
async function createTeachingAnswerDeps() {
  return {
    clock: { now: (): Date => new Date() },
    ...createSqliteLearnerStores(),
  };
}

/** Start (or supersede) the teaching session for a book's curriculum. */
export async function startTeachingForBook(
  book: Book,
  curriculum: PersonalCurriculum,
): Promise<TeachingSession> {
  return coreStartTeachingSession(await createTeachingGenerationDeps(book), curriculum);
}

/** Generate content for the current step (idempotent per step). */
export async function deliverTeachingStep(
  book: Book,
  session: TeachingSession,
): Promise<TeachingSession> {
  return coreDeliverCurrentStep(await createTeachingGenerationDeps(book), session, book.meta.title);
}

/** Grade the current step's check and record evidence. The resumable engine
 * (iter-1) makes a retry after a mid-apply crash complete the step exactly
 * once. Takes the book for call-site symmetry with the generation flow, but
 * never touches it: grading is local. */
export async function answerTeachingStep(
  _book: Book,
  session: TeachingSession,
  selectedOption: number,
): Promise<TeachingSession> {
  return coreAnswerCurrentStep(await createTeachingAnswerDeps(), session, selectedOption);
}

/** The active teaching session for any book, if one is in progress. */
export async function getActiveTeaching(): Promise<TeachingSession | null> {
  const stores = createSqliteLearnerStores();
  const deps = {
    clock: { now: (): Date => new Date() },
    ...stores,
  };
  return coreGetActiveTeachingSession(
    deps as unknown as Parameters<typeof coreGetActiveTeachingSession>[0],
  );
}
