// PR-006 Placement — deterministic CAT engine ported from the audited OpenTutor
// cat_pretest.py (pinned 0307042): adaptive item selection, theta updates,
// stop rules, and finalize formulas are line-faithful; the estimator rewrite
// mandated by the PR-003 audit is the TypeScript functional form. The LLM is
// only an item-content co-processor (see placement-generation.ts) — selection,
// scoring, and placement-mastery estimation are pure.

export const PLACEMENT_MIN_ITEMS = 5;
export const PLACEMENT_MAX_ITEMS = 20;
export const PLACEMENT_SE_THRESHOLD = 0.15;
/** theta starts at the scale midpoint (OpenTutor CATState default). */
export const PLACEMENT_INITIAL_THETA = 0.5;

/** Diagnostic difficulty layer (OpenTutor taxonomy): 1=recall, 2=application, 3=trap. */
export type PlacementLayer = 1 | 2 | 3;

export interface PlacementConcept {
  conceptId: string;
  title: string;
}

export interface PlacementItem {
  id: string;
  conceptId: string;
  conceptTitle: string;
  prompt: string;
  options: string[];
  /** Index of the single correct option. */
  correctIndex: number;
  explanation: string;
  /** Layer 1=recall, 2=application, 3=trap (drives the Bloom level). */
  layer: PlacementLayer;
  /** Bloom level 1-6 the item was written for. */
  bloomLevel: number;
  /** Difficulty in [0.1, 0.9] via the audited Bloom mapping. */
  difficulty: number;
}

export interface PlacementResponse {
  itemId: string;
  conceptId: string;
  correct: boolean;
  difficulty: number;
}

export type PlacementSessionStatus = "active" | "completed" | "abandoned";

export interface PlacementSession {
  id: string;
  status: PlacementSessionStatus;
  theta: number;
  /** Epoch millis. */
  startedAt: number;
  finalizedAt: number | null;
  items: PlacementItem[];
  responses: PlacementResponse[];
}

/** Layer -> Bloom level for item generation (recall/application/trap). */
export const LAYER_BLOOM: Record<PlacementLayer, number> = { 1: 2, 2: 3, 3: 5 };

/** Audited Bloom -> difficulty mapping: min(max((bloom-1)/5, 0.1), 0.9). */
export function bloomToDifficulty(bloomLevel: number): number {
  return Math.min(Math.max((bloomLevel - 1) / 5, 0.1), 0.9);
}

/** Standard error of the ability estimate (audited binomial form). */
export function placementStandardError(responses: PlacementResponse[]): number {
  if (responses.length < 2) return 1.0;
  const p = Math.min(
    Math.max(responses.filter((r) => r.correct).length / responses.length, 0.01),
    0.99,
  );
  return Math.sqrt((p * (1 - p)) / responses.length);
}

export function placementShouldStop(responses: PlacementResponse[]): boolean {
  if (responses.length >= PLACEMENT_MAX_ITEMS) return true;
  if (
    responses.length >= PLACEMENT_MIN_ITEMS &&
    placementStandardError(responses) < PLACEMENT_SE_THRESHOLD
  ) {
    return true;
  }
  return false;
}

/** Maximum-information selection: the untested item whose difficulty is
 * closest to the current theta (audited heuristic). */
export function selectNextPlacementItem(session: PlacementSession): PlacementItem | null {
  const asked = new Set(session.responses.map((r) => r.itemId));
  const untested = session.items.filter((item) => !asked.has(item.id));
  if (untested.length === 0) return null;
  let best: PlacementItem | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const item of untested) {
    const distance = Math.abs(item.difficulty - session.theta);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return best;
}

/** Audited ability update after one response. Returns the new theta. */
export function updatePlacementTheta(
  session: PlacementSession,
  item: PlacementItem,
  correct: boolean,
): number {
  const total = session.responses.length + 1;
  const step = 0.3 / Math.sqrt(total);
  let theta = session.theta;
  if (correct) {
    theta =
      theta < item.difficulty
        ? theta + step * (item.difficulty - theta + 0.1)
        : Math.min(theta + step * 0.2, 1.0);
  } else {
    theta =
      theta > item.difficulty
        ? theta - step * (theta - item.difficulty + 0.1)
        : Math.max(theta - step * 0.2, 0.0);
  }
  return Math.max(0.0, Math.min(1.0, theta));
}

/** Audited tested-concept mastery: correct → min(0.4 + theta*0.4, 0.85),
 * incorrect → max(theta*0.3, 0.05). */
export function placementTestedMastery(theta: number, correct: boolean): number {
  return correct ? Math.min(0.4 + theta * 0.4, 0.85) : Math.max(theta * 0.3, 0.05);
}

/** Audited untested-concept inference (theta-vs-difficulty branch only; the
 * prerequisite-edge inference hook is deferred until an edge model exists). */
export function placementInferredMastery(theta: number, difficulty: number): number {
  return theta >= difficulty
    ? Math.min(0.3 + (theta - difficulty) * 0.5, 0.7)
    : Math.max(0.1, theta * 0.4);
}

export interface PlacementPerConceptVerdict {
  conceptId: string;
  conceptTitle: string;
  mastery: number;
  tested: boolean;
}

export interface PlacementVerdict {
  sessionId: string;
  questionsAsked: number;
  correct: number;
  theta: number;
  standardError: number;
  conceptsAssessed: number;
  masteryWritten: number;
  perConcept: PlacementPerConceptVerdict[];
}

/** Session persistence contract (in-memory for tests, SQLite in the app). */
export interface PlacementStore {
  get(id: string): Promise<PlacementSession | null>;
  put(session: PlacementSession): Promise<void>;
  /** The latest non-completed session, if any. */
  getActive(): Promise<PlacementSession | null>;
}
