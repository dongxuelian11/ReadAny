import { describe, expect, it } from "vitest";
import { createInMemoryConceptIdentityStore } from "./concept-identity";
import { projectConceptState } from "./concept-projection";
import { applyEvidenceEvent } from "./engine";
import type { EvidenceEventInput, LearnerEngineDeps } from "./engine";
import { getLearnerStateAt } from "./read-model";
import type { LearnerReadDeps } from "./read-model";
import { createInMemoryLearnerStores } from "./stores";

const NOW = new Date("2026-09-06T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// The concept "费用 fees" spans two chapters of one book.
const CONCEPT_ID = "readany:concept:t:abcd1234";
const CH0 = "readany:book:book-1:chapter:0";
const CH1 = "readany:book:book-1:chapter:1";

function createDeps(at: Date = NOW): {
  deps: LearnerEngineDeps &
    LearnerReadDeps & { identity: ReturnType<typeof createInMemoryConceptIdentityStore> };
  stores: ReturnType<typeof createInMemoryLearnerStores>;
  identity: ReturnType<typeof createInMemoryConceptIdentityStore>;
} {
  const stores = createInMemoryLearnerStores();
  const identity = createInMemoryConceptIdentityStore();
  return {
    stores,
    identity,
    deps: {
      clock: { now: () => at },
      evidence: stores.evidence,
      mastery: stores.mastery,
      reviews: stores.reviews,
      identity,
    },
  };
}

function evidence(
  conceptId: string,
  id: string,
  result: "correct" | "incorrect",
): EvidenceEventInput {
  return {
    conceptId,
    source: "READ_BOX_QUIZ",
    taskType: "quiz",
    questionType: "mc",
    result,
    confidence: 1,
    verification: "deterministic_keyed",
    id,
  };
}

async function buildConceptWithChapters(
  deps: LearnerEngineDeps & { identity: ReturnType<typeof createInMemoryConceptIdentityStore> },
  identity: ReturnType<typeof createInMemoryConceptIdentityStore>,
): Promise<void> {
  await identity.registerConcept({
    conceptId: CONCEPT_ID,
    displayName: "费用 fees",
    createdAt: NOW.getTime(),
  });
  await identity.bindConceptSourceUnit(CONCEPT_ID, CH0);
  await identity.bindConceptSourceUnit(CONCEPT_ID, CH1);
  // Practice both chapters: 2 correct on ch0, 1 correct on ch1.
  await applyEvidenceEvent(deps, evidence(CH0, "e0a", "correct"));
  await applyEvidenceEvent(deps, evidence(CH0, "e0b", "correct"));
  await applyEvidenceEvent(deps, evidence(CH1, "e1a", "correct"));
}

describe("concept-state projection (PR-026)", () => {
  it("returns null for a concept with no participating chapters", async () => {
    const { deps, identity } = createDeps();
    await identity.registerConcept({ conceptId: "empty", displayName: "x", createdAt: 0 });
    expect(await projectConceptState(deps, "empty")).toBeNull();
  });

  it("projects the evidence-weighted mean mastery across participating chapters", async () => {
    const { deps } = createDeps();
    await buildConceptWithChapters(deps, deps.identity);
    const projection = await projectConceptState(deps, CONCEPT_ID);
    expect(projection).not.toBeNull();
    expect(projection?.evidenceCount).toBe(3);

    const ch0 = await getLearnerStateAt(deps, [CH0]);
    const ch1 = await getLearnerStateAt(deps, [CH1]);
    const m0 = ch0[0].state?.mastery ?? 0;
    const m1 = ch1[0].state?.mastery ?? 0;
    const expected = (m0 * 2 + m1 * 1) / 3;
    expect(projection?.mastery).toBeCloseTo(expected, 12);
    // Both chapters freshly correct → the worst status is learning (below threshold).
    expect(projection?.status).toBe("learning");
  });

  it("degrades the projection to needs_review when ANY chapter's retention lapses", async () => {
    const { deps, identity } = createDeps();
    await identity.registerConcept({
      conceptId: CONCEPT_ID,
      displayName: "x",
      createdAt: NOW.getTime(),
    });
    await identity.bindConceptSourceUnit(CONCEPT_ID, CH0);
    await identity.bindConceptSourceUnit(CONCEPT_ID, CH1);
    // Drive BOTH chapters above the mastery threshold (6 correct each) so
    // their base status is stable; forgetting is then what shows up.
    for (let i = 0; i < 6; i += 1) {
      await applyEvidenceEvent(deps, evidence(CH0, `a${i}`, "correct"));
      await applyEvidenceEvent(deps, evidence(CH1, `b${i}`, "correct"));
    }

    // 90 days later: both chapters' retrievability decayed below the 0.9
    // request retention — the projection must read needs_review.
    const laterDeps: LearnerReadDeps & {
      identity: ReturnType<typeof createInMemoryConceptIdentityStore>;
    } = {
      ...deps,
      clock: { now: () => new Date(NOW.getTime() + 90 * DAY_MS) },
    };
    const projection = await projectConceptState(laterDeps, CONCEPT_ID);
    expect(projection?.status).toBe("needs_review");
    // But it only takes ONE lapsed chapter to degrade the whole concept:
    // re-practice chapter 0 today and the projection must STILL be
    // needs_review because chapter 1 lapsed.
    const todayDeps: LearnerReadDeps & {
      identity: ReturnType<typeof createInMemoryConceptIdentityStore>;
    } = {
      ...deps,
      clock: { now: () => new Date(NOW.getTime() + 90 * DAY_MS) },
    };
    await applyEvidenceEvent(todayDeps as LearnerEngineDeps, evidence(CH0, "recovery", "correct"));
    const mixed = await projectConceptState(todayDeps, CONCEPT_ID);
    expect(mixed?.status).toBe("needs_review");
  });

  it("ignores participating chapters with no learner state", async () => {
    const { deps, identity } = createDeps();
    await identity.registerConcept({ conceptId: CONCEPT_ID, displayName: "x", createdAt: 0 });
    await identity.bindConceptSourceUnit(CONCEPT_ID, CH0);
    await identity.bindConceptSourceUnit(CONCEPT_ID, "readany:book:book-1:chapter:5");
    await applyEvidenceEvent(deps, evidence(CH0, "only", "correct"));
    const projection = await projectConceptState(deps, CONCEPT_ID);
    expect(projection?.chapters).toHaveLength(2);
    expect(projection?.chapters[1].state).toBeNull();
    expect(projection?.evidenceCount).toBe(1);
  });
});
