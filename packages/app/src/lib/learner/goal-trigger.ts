// Goal trigger — app-layer adapter assembling the engine deps for the Goal
// Model: free-text goal → validated GoalSpec (LLM co-processor) → persisted
// active goal → deterministic Personal Curriculum over the current learner
// state. No UI here; the frontend owner surfaces the results.

import { loadExistingBookSkill } from "@/lib/book-skill/trigger";
import { useSettingsStore } from "@/stores/settings-store";
import { fallbackContentService } from "@readany/core/ai";
import { createBookSkillLlmClient } from "@readany/core/book-skill";
import {
  buildCurriculum,
  classifyGap,
  createSqliteLearnerStores,
  parseGoal,
  putGoalWithSupersession,
  toGoalSpec,
} from "@readany/core/learner";
import type {
  GoalLlmClient,
  GoalSpec,
  LearnerConceptState,
  PersonalCurriculum,
} from "@readany/core/learner";
import type { Book } from "@readany/core/types";

async function createGoalEngineDeps() {
  return {
    clock: { now: (): Date => new Date() },
    ...createSqliteLearnerStores(),
  };
}

async function bookChapters(book: Book) {
  const skill = await loadExistingBookSkill(book);
  if (skill) {
    return skill.manifest.readany.chapters.map((chapter) => ({
      conceptId: `readany:book:${book.id}:chapter:${chapter.chapterIndex}`,
      title: chapter.title,
    }));
  }
  const chapters = await fallbackContentService.getChapters(book);
  return chapters
    .filter((chapter) => chapter.content.trim().length > 0)
    .map((chapter) => ({
      conceptId: `readany:book:${book.id}:chapter:${chapter.index}`,
      title: chapter.title || `Chapter ${chapter.index + 1}`,
    }));
}

/** Parse a free-text goal against the book's chapters, persist it as the
 * book's active goal, and build the current curriculum. */
export async function startGoalForBook(book: Book, goalText: string): Promise<GoalSpec> {
  const chapters = await bookChapters(book);
  const aiConfig = useSettingsStore.getState().aiConfig;
  const llm: GoalLlmClient = await createBookSkillLlmClient(aiConfig);
  const deps = await createGoalEngineDeps();
  const parse = await parseGoal({ goalText, bookTitle: book.meta.title, chapters, llm });
  const goal = toGoalSpec({
    parse,
    goalId: crypto.randomUUID(),
    bookId: book.id,
    goalText,
    createdAt: deps.clock.now().getTime(),
  });
  await putGoalWithSupersession(deps.goals, goal);
  return goal;
}

/** The active goal for a book, if any. */
export async function getActiveGoal(book: Book): Promise<GoalSpec | null> {
  const deps = await createGoalEngineDeps();
  return deps.goals.getActive(book.id);
}

/** Rebuild the deterministic curriculum for a goal against the current learner
 * state (pure computation — safe to call any time). */
export async function getCurriculumForGoal(goal: GoalSpec): Promise<PersonalCurriculum> {
  const deps = await createGoalEngineDeps();
  const entries = [];
  for (const chapter of goal.chapters) {
    const row = await deps.mastery.get(chapter.conceptId);
    const learner: LearnerConceptState | null = row
      ? {
          mastery: row.mastery,
          status: row.status,
          evidenceCount: row.evidenceCount,
          lastVerified: row.lastVerified,
        }
      : null;
    entries.push(classifyGap(chapter, learner));
  }
  return buildCurriculum(goal, entries, deps.clock.now().getTime());
}
