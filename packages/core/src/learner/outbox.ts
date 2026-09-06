// Durable evidence outbox (PR-012) — the write-ahead side of the learner
// Authority. UI-triggered evidence used to be fire-and-forget: a failed or
// interrupted persistence silently lost the event. The outbox inverts the
// order: enqueue a durable row first (pinning the event id AND the answer
// timestamp), apply it through the resumable engine, then mark it done.
// Since iter-1 the engine apply is idempotent per step via commit markers, so
// a replay of a partially applied event finishes exactly once instead of the
// duplicate ledger id masking the missing BKT/FSRS updates as "already done".

import { applyEvidenceEventResult } from "./engine";
import type { EvidenceEventInput, LearnerEngineDeps } from "./engine";

/** An evidence event whose id is pinned: the outbox assigns one at enqueue
 * time so a replay can never mint a fresh random id and double-apply. */
export type PinnedEvidenceEvent = EvidenceEventInput & { id: string };

export interface LearnerEvidenceOutboxEntry {
  outboxId: string;
  event: PinnedEvidenceEvent;
  createdAt: number;
  attempts: number;
  status: "pending" | "done";
  lastError: string | null;
}

export interface LearnerEvidenceOutboxStore {
  /** Durable enqueue; pins the event id when missing. */
  enqueue(
    event: EvidenceEventInput,
    createdAt: number,
  ): Promise<{ outboxId: string; event: PinnedEvidenceEvent }>;
  listPending(limit?: number): Promise<LearnerEvidenceOutboxEntry[]>;
  markDone(outboxId: string): Promise<void>;
  /** Records one failed apply attempt; the entry stays pending for replay. */
  markError(outboxId: string, message: string): Promise<void>;
}

export interface EvidenceOutboxDrainReport {
  applied: number;
  alreadyApplied: number;
  failed: number;
  skipped: number;
}

/** A row that failed this many apply attempts is left pending but skipped by
 * later drains, so one poison row can never wedge the queue. */
export const MAX_OUTBOX_ATTEMPTS = 8;

export function createInMemoryEvidenceOutbox(): LearnerEvidenceOutboxStore {
  const rows = new Map<string, LearnerEvidenceOutboxEntry>();
  return {
    async enqueue(event, createdAt) {
      const outboxId = crypto.randomUUID();
      const pinned: PinnedEvidenceEvent = {
        ...event,
        id: event.id ?? crypto.randomUUID(),
        // Pin the answer time at enqueue (iter-1): replays apply with the
        // original timestamp instead of silently moving to the drain instant.
        timestamp: event.timestamp ?? createdAt,
      };
      const entry: LearnerEvidenceOutboxEntry = {
        outboxId,
        event: JSON.parse(JSON.stringify(pinned)) as PinnedEvidenceEvent,
        createdAt,
        attempts: 0,
        status: "pending",
        lastError: null,
      };
      rows.set(outboxId, entry);
      return { outboxId, event: JSON.parse(JSON.stringify(pinned)) as PinnedEvidenceEvent };
    },
    async listPending(limit) {
      return [...rows.values()]
        .filter((row) => row.status === "pending")
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limit ?? Number.POSITIVE_INFINITY)
        .map((row) => JSON.parse(JSON.stringify(row)) as LearnerEvidenceOutboxEntry);
    },
    async markDone(outboxId) {
      const row = rows.get(outboxId);
      if (row) {
        row.status = "done";
        row.lastError = null;
      }
    },
    async markError(outboxId, message) {
      const row = rows.get(outboxId);
      if (row) {
        row.attempts += 1;
        row.lastError = message;
      }
    },
  };
}

export async function drainEvidenceOutbox(
  deps: LearnerEngineDeps,
  outbox: LearnerEvidenceOutboxStore,
  options?: { limit?: number; maxAttempts?: number },
): Promise<EvidenceOutboxDrainReport> {
  const maxAttempts = options?.maxAttempts ?? MAX_OUTBOX_ATTEMPTS;
  const report: EvidenceOutboxDrainReport = {
    applied: 0,
    alreadyApplied: 0,
    failed: 0,
    skipped: 0,
  };
  const pending = await outbox.listPending(options?.limit);
  for (const entry of pending) {
    if (entry.attempts >= maxAttempts) {
      report.skipped += 1;
      continue;
    }
    try {
      // The engine apply is resumable (iter-1): a duplicate ledger id for the
      // same attempt resumes the remaining steps instead of masking a partial
      // apply as done, and `alreadyApplied` is only reported when the commit
      // markers show the event was FULLY applied before this drain.
      const result = await applyEvidenceEventResult(deps, entry.event);
      await outbox.markDone(entry.outboxId);
      if (result.alreadyApplied) report.alreadyApplied += 1;
      else report.applied += 1;
    } catch (error) {
      await outbox.markError(
        entry.outboxId,
        error instanceof Error ? error.message : String(error),
      );
      report.failed += 1;
    }
  }
  return report;
}
