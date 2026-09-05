// Placement session lifecycle over the deterministic CAT core. Session state
// is persisted through the PlacementStore so a placement survives app
// restarts; finalize writes placement-estimated mastery rows (overwrite-guarded
// to never touch concepts with real practice evidence) and appends ledger
// evidence ONLY for concepts the learner actually answered. Placement does not
// route through applyEvidenceEvent (no BKT re-estimation on top of the theta
// estimate) and does not create FSRS cards (reviews start with real practice).

import { deriveMasteryStatus } from "./engine";
import {
  PLACEMENT_INITIAL_THETA,
  type PlacementItem,
  type PlacementPerConceptVerdict,
  type PlacementResponse,
  type PlacementSession,
  type PlacementStore,
  type PlacementVerdict,
  placementInferredMastery,
  placementShouldStop,
  placementStandardError,
  placementTestedMastery,
  selectNextPlacementItem,
  updatePlacementTheta,
} from "./placement";
import { DuplicateEvidenceIdError } from "./stores";
import type {
  ConceptMastery,
  LearnerClock,
  LearnerEvidenceStore,
  LearnerMasteryStore,
  LearnerReviewStore,
} from "./types";
import { withLearnerWriteLock } from "./write-lock";

export interface PlacementEngineDeps {
  clock: LearnerClock;
  mastery: LearnerMasteryStore;
  evidence: LearnerEvidenceStore;
  reviews: LearnerReviewStore;
  placements: PlacementStore;
}

export class PlacementPoolTooSmallError extends Error {
  constructor(available: number, minimum: number) {
    super(`Placement pool has ${available} item(s); the CAT engine requires at least ${minimum}`);
    this.name = "PlacementPoolTooSmallError";
  }
}

/** Start a placement: persist a new active session and mark any previously
 * active sessions abandoned (fail-safe supersession). The abandon-then-create
 * cycle runs under the learner write lock (PR-012). */
export async function startPlacementSession(
  deps: PlacementEngineDeps,
  items: PlacementItem[],
): Promise<PlacementSession> {
  if (items.length < 5) {
    throw new PlacementPoolTooSmallError(items.length, 5);
  }
  const now = deps.clock.now();
  return withLearnerWriteLock(async () => {
    const active = await deps.placements.getActive();
    if (active) {
      await deps.placements.put({ ...active, status: "abandoned", finalizedAt: now.getTime() });
    }
    const session: PlacementSession = {
      id: crypto.randomUUID(),
      status: "active",
      theta: PLACEMENT_INITIAL_THETA,
      startedAt: now.getTime(),
      finalizedAt: null,
      items,
      responses: [],
    };
    await deps.placements.put(session);
    return session;
  });
}

/** Load a session by id. */
export async function getPlacementSession(
  deps: PlacementEngineDeps,
  sessionId: string,
): Promise<PlacementSession | null> {
  return deps.placements.get(sessionId);
}

/** The active session, if one is in progress. */
export async function getActivePlacementSession(
  deps: PlacementEngineDeps,
): Promise<PlacementSession | null> {
  return deps.placements.getActive();
}

/** Apply one answer to the active session: records the response, updates
 * theta. Fail-closed on wrong item, foreign item, or non-active session. */
export async function answerPlacementItem(
  deps: PlacementEngineDeps,
  session: PlacementSession,
  itemId: string,
  correct: boolean,
): Promise<PlacementSession> {
  if (session.status !== "active") {
    throw new Error("The placement session is not active");
  }
  const item = session.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Unknown placement item: ${itemId}`);
  if (session.responses.some((response) => response.itemId === itemId)) {
    throw new Error(`Placement item already answered: ${itemId}`);
  }
  const theta = updatePlacementTheta(session, item, correct);
  const response: PlacementResponse = {
    itemId,
    conceptId: item.conceptId,
    correct,
    difficulty: item.difficulty,
  };
  const updated: PlacementSession = {
    ...session,
    theta,
    responses: [...session.responses, response],
  };
  await deps.placements.put(updated);
  return updated;
}

/** The next item to ask, or null when the audited stop rules are satisfied. */
export function nextPlacementItem(session: PlacementSession): PlacementItem | null {
  if (session.status !== "active") return null;
  if (placementShouldStop(session.responses)) return null;
  return selectNextPlacementItem(session);
}

/**
 * Finalize a placement: write placement-estimated mastery rows for all pool
 * concepts (guarded — concepts with existing evidence keep their real practice
 * data), append ledger evidence only for actually-answered items, and mark the
 * session completed. The guarded read-modify-write sweep runs under the
 * learner write lock (PR-012); it appends evidence directly rather than
 * through the locked applyEvidenceEvent, so the lock never nests.
 */
export function finalizePlacement(
  deps: PlacementEngineDeps,
  session: PlacementSession,
): Promise<PlacementVerdict> {
  return withLearnerWriteLock(() => finalizePlacementLocked(deps, session));
}

async function finalizePlacementLocked(
  deps: PlacementEngineDeps,
  session: PlacementSession,
): Promise<PlacementVerdict> {
  if (session.status !== "active") {
    throw new Error("The placement session is not active");
  }
  const now = deps.clock.now();
  const timestamp = now.getTime();

  const answeredByConcept = new Map<string, boolean>();
  for (const response of session.responses) {
    answeredByConcept.set(response.conceptId, response.correct);
  }

  const perConcept: PlacementPerConceptVerdict[] = [];
  let masteryWritten = 0;

  for (const item of session.items) {
    const tested = answeredByConcept.has(item.conceptId);
    const mastery = tested
      ? placementTestedMastery(session.theta, answeredByConcept.get(item.conceptId) === true)
      : placementInferredMastery(session.theta, item.difficulty);

    const existing = await deps.mastery.get(item.conceptId);
    // Overwrite guard (audited): only concepts without real practice evidence
    // receive placement estimates.
    if (existing && existing.evidenceCount > 0) {
      perConcept.push({
        conceptId: item.conceptId,
        conceptTitle: item.conceptTitle,
        mastery: existing.mastery,
        tested,
      });
      continue;
    }

    const row: ConceptMastery = {
      conceptId: item.conceptId,
      mastery,
      confidence: tested ? 1 : 0,
      retention: null,
      transfer: null,
      lastVerified: timestamp,
      nextReview: null,
      status: deriveMasteryStatus({
        evidenceCount: tested ? 1 : 0,
        mastery,
        retention: null,
        lastVerified: timestamp,
      }),
      evidenceCount: tested ? 1 : 0,
      updatedAt: timestamp,
    };
    await deps.mastery.put(row);
    masteryWritten += 1;
    perConcept.push({
      conceptId: item.conceptId,
      conceptTitle: item.conceptTitle,
      mastery,
      tested,
    });
  }

  // Ledger evidence only for actually-answered items; deterministic ids make
  // re-finalization idempotent at the evidence layer.
  for (const response of session.responses) {
    await deps.evidence
      .append({
        id: `${session.id}:${response.itemId}`,
        conceptId: response.conceptId,
        source: "PLACEMENT",
        taskType: "placement",
        result: response.correct ? "correct" : "incorrect",
        confidence: 1,
        timestamp,
      })
      .catch((error) => {
        if (!(error instanceof DuplicateEvidenceIdError)) throw error;
      });
  }

  const finalized: PlacementSession = {
    ...session,
    status: "completed",
    finalizedAt: timestamp,
  };
  await deps.placements.put(finalized);

  return {
    sessionId: session.id,
    questionsAsked: session.responses.length,
    correct: session.responses.filter((r) => r.correct).length,
    theta: session.theta,
    standardError: placementStandardError(session.responses),
    conceptsAssessed: perConcept.length,
    masteryWritten,
    perConcept,
  };
}
