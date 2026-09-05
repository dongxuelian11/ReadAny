// Durable evidence outbox (PR-012) — the write-ahead side of the learner
// Authority. UI-triggered evidence used to be fire-and-forget: a failed or
// interrupted persistence silently lost the event. The outbox inverts the
// order: enqueue a durable row first, apply it through the deterministic
// engine, then mark it done. Replay is idempotent end to end — deterministic
// evidence ids (quiz question hash, teaching session:step, placement
// session:item) make a replayed event hit DuplicateEvidenceIdError, which the
// drain treats as already applied instead of failed.

import { applyEvidenceEvent } from "./engine";
import type { EvidenceEventInput, LearnerEngineDeps } from "./engine";
import { DuplicateEvidenceIdError } from "./stores";

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
      const pinned: PinnedEvidenceEvent = { ...event, id: event.id ?? crypto.randomUUID() };
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
      await applyEvidenceEvent(deps, entry.event);
      await outbox.markDone(entry.outboxId);
      report.applied += 1;
    } catch (error) {
      if (error instanceof DuplicateEvidenceIdError) {
        // The ledger is authoritative: the event was already applied (crash
        // between apply and markDone), so the row is done, not failed.
        await outbox.markDone(entry.outboxId);
        report.alreadyApplied += 1;
      } else {
        await outbox.markError(
          entry.outboxId,
          error instanceof Error ? error.message : String(error),
        );
        report.failed += 1;
      }
    }
  }
  return report;
}
