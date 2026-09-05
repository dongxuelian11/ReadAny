import { describe, expect, it } from "vitest";
import { applyEvidenceEvent } from "./engine";
import type { EvidenceEventInput, LearnerEngineDeps } from "./engine";
import { MAX_OUTBOX_ATTEMPTS, createInMemoryEvidenceOutbox, drainEvidenceOutbox } from "./outbox";
import { createInMemoryLearnerStores } from "./stores";

const NOW = new Date("2026-09-05T00:00:00.000Z");

function createDeps(): {
  deps: LearnerEngineDeps;
  stores: ReturnType<typeof createInMemoryLearnerStores>;
} {
  const stores = createInMemoryLearnerStores();
  return {
    stores,
    deps: {
      clock: { now: () => NOW },
      evidence: stores.evidence,
      mastery: stores.mastery,
      reviews: stores.reviews,
    },
  };
}

const EVENT: EvidenceEventInput = {
  conceptId: "stats/mean",
  source: "READ_BOX_QUIZ",
  taskType: "quiz",
  questionType: "mc",
  result: "correct",
  confidence: 1,
};

describe("durable evidence outbox", () => {
  it("pins the event id at enqueue time so replays cannot double-apply", async () => {
    const outbox = createInMemoryEvidenceOutbox();
    const first = await outbox.enqueue({ ...EVENT }, 1);
    expect(first.event.id).toBeTruthy();

    const second = await outbox.enqueue({ ...EVENT }, 2);
    expect(second.event.id).not.toBe(first.event.id);

    const replay = await outbox.enqueue({ ...EVENT, id: "pinned" }, 3);
    expect(replay.event.id).toBe("pinned");
  });

  it("drains pending rows through the engine and marks them done", async () => {
    const outbox = createInMemoryEvidenceOutbox();
    const { deps, stores } = createDeps();
    await outbox.enqueue({ ...EVENT }, 1);
    await outbox.enqueue({ ...EVENT, id: "second", result: "incorrect" }, 2);

    const report = await drainEvidenceOutbox(deps, outbox);
    expect(report).toEqual({ applied: 2, alreadyApplied: 0, failed: 0, skipped: 0 });
    expect(stores.events()).toHaveLength(2);
    expect(await outbox.listPending()).toEqual([]);

    const final = await deps.mastery.get("stats/mean");
    expect(final?.evidenceCount).toBe(2);
  });

  it("treats a replayed duplicate id as already applied, not failed", async () => {
    const outbox = createInMemoryEvidenceOutbox();
    const { deps, stores } = createDeps();
    const { event } = await outbox.enqueue({ ...EVENT }, 1);
    // Simulate a crash after apply but before markDone.
    await applyEvidenceEvent(deps, event);

    const report = await drainEvidenceOutbox(deps, outbox);
    expect(report.alreadyApplied).toBe(1);
    expect(report.failed).toBe(0);
    expect(stores.events()).toHaveLength(1);
    expect(await outbox.listPending()).toEqual([]);
  });

  it("keeps a failed row pending with attempts recorded, then applies it once the store recovers", async () => {
    const outbox = createInMemoryEvidenceOutbox();
    const stores = createInMemoryLearnerStores();
    const broken: LearnerEngineDeps = {
      clock: { now: () => NOW },
      evidence: {
        ...stores.evidence,
        append: async () => {
          throw new Error("disk on fire");
        },
      },
      mastery: stores.mastery,
      reviews: stores.reviews,
    };
    await outbox.enqueue({ ...EVENT }, 1);

    const failed = await drainEvidenceOutbox(broken, outbox);
    expect(failed.applied).toBe(0);
    expect(failed.failed).toBe(1);
    const pending = await outbox.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].attempts).toBe(1);
    expect(pending[0].lastError).toBe("disk on fire");

    const { deps } = createDeps();
    const recovered = await drainEvidenceOutbox(deps, outbox);
    expect(recovered.applied).toBe(1);
    expect(await outbox.listPending()).toEqual([]);
  });

  it("skips poison rows after the attempt cap without wedging the queue", async () => {
    const outbox = createInMemoryEvidenceOutbox();
    const stores = createInMemoryLearnerStores();
    // The store only fails for the poison event: the healthy event behind it
    // must still apply while the poison row keeps failing.
    const broken: LearnerEngineDeps = {
      clock: { now: () => NOW },
      evidence: {
        ...stores.evidence,
        append: async (event) => {
          if (event.id === "poison") throw new Error("still burning");
          return stores.evidence.append(event);
        },
      },
      mastery: stores.mastery,
      reviews: stores.reviews,
    };
    await outbox.enqueue({ ...EVENT, id: "poison" }, 1);
    await outbox.enqueue({ ...EVENT, id: "healthy", conceptId: "stats/variance" }, 2);

    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS; i += 1) {
      await drainEvidenceOutbox(broken, outbox);
    }
    // The healthy row applied on the first drain despite the poison row ahead.
    expect(stores.events().map((event) => event.id)).toContain("healthy");

    const { deps } = createDeps();
    const report = await drainEvidenceOutbox(deps, outbox);
    // The poison row is skipped (not retried forever), still pending.
    expect(report.skipped).toBe(1);
    expect(report.applied).toBe(0);
    expect((await outbox.listPending()).map((row) => row.event.id)).toEqual(["poison"]);
  });
});
