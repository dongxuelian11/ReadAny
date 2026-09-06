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

  // ---- Mid-apply fault injection (iter-1) ----
  // The ledger append is idempotent by primary key, so a crash AFTER it used
  // to be masked as "already applied", silently dropping the BKT/FSRS writes.
  // The resumable engine must instead complete the remaining steps exactly
  // once on the next drain.

  interface ThrowOnceOptions {
    method: "putCard" | "appendLog" | "putMastery";
    failForEventId: string;
  }

  function depsWithMidApplyFault(
    stores: ReturnType<typeof createInMemoryLearnerStores>,
    options: ThrowOnceOptions,
  ): LearnerEngineDeps {
    return {
      clock: { now: () => NOW },
      evidence: stores.evidence,
      mastery:
        options.method === "putMastery"
          ? {
              ...stores.mastery,
              put: async (row) => {
                if (row.lastEventId === options.failForEventId) {
                  throw new Error("mastery write failed");
                }
                return stores.mastery.put(row);
              },
            }
          : stores.mastery,
      reviews:
        options.method === "putCard" || options.method === "appendLog"
          ? {
              ...stores.reviews,
              putCard: async (card) => {
                if (options.method === "putCard" && card.lastEventId === options.failForEventId) {
                  throw new Error("card write failed");
                }
                return stores.reviews.putCard(card);
              },
              appendLog: async (entry) => {
                if (options.method === "appendLog" && entry.eventId === options.failForEventId) {
                  throw new Error("log write failed");
                }
                return stores.reviews.appendLog(entry);
              },
            }
          : stores.reviews,
    };
  }

  it.each(["putCard", "appendLog", "putMastery"] as const)(
    "completes exactly once after a crash at %s (ledger row already written)",
    async (method) => {
      const outbox = createInMemoryEvidenceOutbox();
      const stores = createInMemoryLearnerStores();
      await outbox.enqueue({ ...EVENT, id: "mid-crash" }, 1);

      const broken = depsWithMidApplyFault(stores, { method, failForEventId: "mid-crash" });
      const failed = await drainEvidenceOutbox(broken, outbox);
      expect(failed.failed).toBe(1);
      expect((await outbox.listPending())).toHaveLength(1);
      // The ledger row from the failed attempt stays (append-only).
      expect(stores.events().map((event) => event.id)).toEqual(["mid-crash"]);

      const { deps } = createDeps();
      const recovered = {
        ...deps,
        evidence: stores.evidence,
        mastery: stores.mastery,
        reviews: stores.reviews,
      };
      const report = await drainEvidenceOutbox(recovered, outbox);
      expect(report.applied).toBe(1);
      expect(await outbox.listPending()).toEqual([]);

      // Exactly-once: one ledger row, one review log, one FSRS review, and a
      // mastery posterior that reflects exactly ONE BKT update.
      expect(stores.events()).toHaveLength(1);
      expect(stores.logs()).toHaveLength(1);
      expect(stores.logs()[0].eventId).toBe("mid-crash");
      const card = await stores.reviews.getCard("stats/mean");
      expect(card?.reps).toBe(1);
      expect(card?.lastEventId).toBe("mid-crash");
      const mastery = await stores.mastery.get("stats/mean");
      expect(mastery?.evidenceCount).toBe(1);
      expect(mastery?.lastEventId).toBe("mid-crash");
    },
  );

  it("a second drain after success is a no-op: one BKT update, one FSRS review total", async () => {
    const outbox = createInMemoryEvidenceOutbox();
    const stores = createInMemoryLearnerStores();
    await outbox.enqueue({ ...EVENT, id: "once" }, 1);

    const { deps } = createDeps();
    const recovered = {
      ...deps,
      evidence: stores.evidence,
      mastery: stores.mastery,
      reviews: stores.reviews,
    };
    const first = await drainEvidenceOutbox(recovered, outbox);
    expect(first.applied).toBe(1);

    // Simulate a duplicate transport: the row is marked done, so nothing
    // re-applies; enqueueing the SAME pinned event again finds the markers.
    const masteryBefore = (await stores.mastery.get("stats/mean"))?.mastery;
    await applyEvidenceEvent(recovered, { ...EVENT, id: "once" });
    const masteryAfter = (await stores.mastery.get("stats/mean"))?.mastery;
    expect(masteryAfter).toBe(masteryBefore);
    expect(stores.logs()).toHaveLength(1);
    expect((await stores.reviews.getCard("stats/mean"))?.reps).toBe(1);
  });
});
