// Teaching trigger — app-layer adapter assembling the engine deps for the
// Agent 带读 flow: curriculum steps are taught from the canonical ReadAny
// chapter text (fallback extraction, capped by the core), answers are graded
// deterministically and recorded through applyEvidenceEvent. No UI here.

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
import type { PersonalCurriculum, TeachingSession } from "@readany/core/learner";
import type { Book } from "@readany/core/types";

async function createTeachingEngineDeps(book: Book) {
  const chapters = await extractBookChapters(await resolveDesktopDataPath(book.filePath));
  const textByIndex = new Map(chapters.map((chapter) => [chapter.index, chapter.content]));
  return {
    clock: { now: (): Date => new Date() },
    ...createSqliteLearnerStores(),
    llm: await createBookSkillLlmClient(useSettingsStore.getState().aiConfig),
    chapterText: async (conceptId: string) => {
      const match = /readany:book:[^:]+:chapter:(\d+)$/.exec(conceptId);
      const text = match ? (textByIndex.get(Number(match[1])) ?? "") : "";
      if (!text.trim()) throw new Error(`No canonical chapter text available for ${conceptId}`);
      return text;
    },
  };
}

/** Start (or supersede) the teaching session for a book's curriculum. */
export async function startTeachingForBook(
  book: Book,
  curriculum: PersonalCurriculum,
): Promise<TeachingSession> {
  return coreStartTeachingSession(await createTeachingEngineDeps(book), curriculum);
}

/** Generate content for the current step (idempotent per step). */
export async function deliverTeachingStep(
  book: Book,
  session: TeachingSession,
): Promise<TeachingSession> {
  return coreDeliverCurrentStep(await createTeachingEngineDeps(book), session, book.meta.title);
}

/** Grade the current step's check and record evidence. */
export async function answerTeachingStep(
  book: Book,
  session: TeachingSession,
  selectedOption: number,
): Promise<TeachingSession> {
  return coreAnswerCurrentStep(await createTeachingEngineDeps(book), session, selectedOption);
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
