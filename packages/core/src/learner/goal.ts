// PR-008 Goal Model — chapter-scoped GoalSpec and the deterministic Knowledge
// Gap → Personal Curriculum computation (handoff §10; LearnGraph gap taxonomy;
// gen-mentor parse boundary as design, per the PR-003 audit).
//
// Authority rules: the LLM only drafts a goal parse; every field is validated
// deterministically and chapter references must resolve against the real book
// list. Gap analysis and curriculum ordering are pure code — a model output can
// never place a chapter into the plan that the learner state does not support.

export type TargetDepth = "familiar" | "working" | "mastery";

export interface GoalChapterTarget {
  conceptId: string;
  title: string;
  depth: TargetDepth;
}

export interface GoalSpec {
  goalId: string;
  bookId: string;
  goalText: string;
  /** Free-text restatement produced/confirmed during parsing. */
  restatedGoal: string;
  targetCapabilities: string[];
  chapters: GoalChapterTarget[];
  milestones: string[];
  completionCriteria: string[];
  createdAt: number;
  active: boolean;
}

export type GoalGapKind = "missing" | "partial" | "lapsed" | "satisfied";

export interface GoalGapEntry {
  conceptId: string;
  title: string;
  depth: TargetDepth;
  kind: GoalGapKind;
  /** Current mastery value, when the learner state has one. */
  mastery: number | null;
}

export interface CurriculumStep {
  conceptId: string;
  title: string;
  depth: TargetDepth;
  action: "learn" | "review";
  reason: string;
  /** The gap kind this step answers (PR-021): the UI-localized reason is
   * derived from it — `reason` stays as the English reference text. */
  kind: GoalGapKind;
  index: number;
}

export interface PersonalCurriculum {
  goalId: string;
  bookId: string;
  steps: CurriculumStep[];
  satisfiedCount: number;
  gapCount: number;
  builtAt: number;
}

/** Depth ordering used by the gap rule: a concept satisfies a target when its
 * status is stable AND its mastery reaches the depth floor. */
export const DEPTH_FLOOR: Record<TargetDepth, number> = {
  familiar: 0.4,
  working: 0.7,
  mastery: 0.85,
};

export interface LearnerConceptState {
  mastery: number | null;
  status: "unseen" | "learning" | "stable" | "needs_review";
  evidenceCount: number;
  lastVerified: number | null;
}

/** Classify one required chapter against the learner state (deterministic).
 * Placement-only estimates (evidenceCount 0, no lastVerified) are treated as
 * unseen: an estimate is not evidence. */
export function classifyGap(
  target: GoalChapterTarget,
  learner: LearnerConceptState | null,
): GoalGapEntry {
  if (!learner || learner.evidenceCount === 0) {
    return {
      conceptId: target.conceptId,
      title: target.title,
      depth: target.depth,
      kind: "missing",
      mastery: learner?.mastery ?? null,
    };
  }
  if (learner.status === "needs_review") {
    return {
      conceptId: target.conceptId,
      title: target.title,
      depth: target.depth,
      kind: "lapsed",
      mastery: learner.mastery,
    };
  }
  const floor = DEPTH_FLOOR[target.depth];
  if (learner.status === "stable" && learner.mastery !== null && learner.mastery >= floor) {
    return {
      conceptId: target.conceptId,
      title: target.title,
      depth: target.depth,
      kind: "satisfied",
      mastery: learner.mastery,
    };
  }
  return {
    conceptId: target.conceptId,
    title: target.title,
    depth: target.depth,
    kind: "partial",
    mastery: learner.mastery,
  };
}

/** Build the ordered personal curriculum from the gap list. Book order is
 * preserved (the defensible default until a prerequisite graph exists);
 * review steps come before learn steps within the same chapter is NOT applied
 * — each chapter appears at most once, as its gap kind dictates. */
export function buildCurriculum(
  goal: GoalSpec,
  entries: GoalGapEntry[],
  builtAt: number,
): PersonalCurriculum {
  const byConcept = new Map(entries.map((entry) => [entry.conceptId, entry]));
  const steps: CurriculumStep[] = [];
  for (const target of goal.chapters) {
    const entry = byConcept.get(target.conceptId);
    if (!entry || entry.kind === "satisfied") continue;
    steps.push({
      conceptId: entry.conceptId,
      title: entry.title,
      depth: entry.depth,
      action: entry.kind === "lapsed" ? "review" : "learn",
      kind: entry.kind,
      reason:
        entry.kind === "missing"
          ? "not started yet"
          : entry.kind === "partial"
            ? "started but below the target depth"
            : "learned before but retention lapsed",
      index: steps.length,
    });
  }
  const satisfiedCount = entries.filter((entry) => entry.kind === "satisfied").length;
  return {
    goalId: goal.goalId,
    bookId: goal.bookId,
    steps,
    satisfiedCount,
    gapCount: steps.length,
    builtAt,
  };
}

/**
 * PR-026: reorder curriculum steps so prerequisite chapters come first, using
 * prerequisite edges mined from the concept registry (chapter A participates
 * in a concept that requires chapter B's concept → B before A). Pure and
 * deterministic: Kahn's algorithm with book-order tiebreak; any cycle falls
 * back to book order for its remaining members (a curriculum must always be
 * complete). Steps without chapter-shaped ids keep their relative position.
 */
export function orderStepsByPrerequisites(
  steps: CurriculumStep[],
  edges: Array<{ before: number; after: number }>,
): CurriculumStep[] {
  const parseChapter = (conceptId: string): number | null => {
    const match = /^readany:book:(.*):chapter:(\d+)$/.exec(conceptId);
    return match ? Number.parseInt(match[2], 10) : null;
  };
  const chapterToPosition = new Map<number, number>();
  steps.forEach((step, position) => {
    const chapter = parseChapter(step.conceptId);
    if (chapter !== null && !chapterToPosition.has(chapter)) {
      chapterToPosition.set(chapter, position);
    }
  });

  const prerequisitesOf = steps.map(() => new Set<number>()); // position -> chapters that must come first
  for (const edge of edges) {
    const beforePos = chapterToPosition.get(edge.before);
    const afterPos = chapterToPosition.get(edge.after);
    if (beforePos === undefined || afterPos === undefined || beforePos === afterPos) continue;
    prerequisitesOf[afterPos].add(beforePos);
  }

  const emitted = new Set<number>();
  const ordered: CurriculumStep[] = [];
  while (ordered.length < steps.length) {
    const next = steps.findIndex(
      (_step, position) =>
        !emitted.has(position) && [...prerequisitesOf[position]].every((pre) => emitted.has(pre)),
    );
    if (next === -1) {
      // Cycle (or stale edges): emit the remaining steps in book order.
      steps.forEach((step, position) => {
        if (!emitted.has(position)) {
          ordered.push({ ...step, index: ordered.length });
          emitted.add(position);
        }
      });
      break;
    }
    ordered.push({ ...steps[next], index: ordered.length });
    emitted.add(next);
  }
  return ordered;
}
