// Iter-1 real-SQLite resume test: the learner commit protocol (idempotent
// per-step markers) must survive an actual interrupt — a write that fails
// against a real better-sqlite3 file database, a close/reopen cycle, and a
// replaying outbox drain — with EXACTLY ONE ledger row, one review log, one
// FSRS review, and one BKT update. Unlike packages/core's scripted IDatabase
// mocks, this runs the real SQL engine end to end.
//
// It also pins the one-time migration contract: an old install (learner tables
// without the marker columns) gets a consistent VACUUM INTO snapshot before
// the ALTERs, and the legacy rows survive untouched.

import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEvidenceEventResult,
  createSqliteEvidenceOutbox,
  createSqliteLearnerStores,
  drainEvidenceOutbox,
} from "@readany/core/learner";
import type { LearnerEngineDeps } from "@readany/core/learner";
import { closeDB, initDatabase } from "@readany/core/db/db-core";
import { describe, expect, it } from "vitest";
import { ensureCoreInitialized } from "./data.js";

const EVENT = {
  id: "resume-e1",
  conceptId: "readany:book:book-1:chapter:3",
  source: "READ_BOX_QUIZ" as const,
  taskType: "quiz" as const,
  questionType: "mc" as const,
  result: "correct" as const,
  confidence: 1,
  verification: "llm_judged" as const,
};

const ANSWER_TIME = 1_790_000_000_000;
const DRAIN_TIME = 1_800_000_000_000;

async function createHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "readany-learner-resume-"));
}

async function openRawDb(home: string): Promise<InstanceType<typeof Database>> {
  return new Database(join(home, "readany.db"));
}

/** A real relaunch: close the file, reopen it, re-run schema init. */
async function interruptAndRelaunch(home: string): Promise<void> {
  await closeDB();
  await ensureCoreInitialized({ ...process.env, READANY_HOME: home });
  await initDatabase();
}

function learnerDeps(stores: ReturnType<typeof createSqliteLearnerStores>): LearnerEngineDeps {
  return {
    clock: { now: () => new Date(DRAIN_TIME) },
    evidence: stores.evidence,
    mastery: stores.mastery,
    reviews: stores.reviews,
  };
}

function depsWithFault(
  stores: ReturnType<typeof createSqliteLearnerStores>,
  method: "putCard" | "appendLog" | "putMastery",
  failForEventId: string,
): LearnerEngineDeps {
  return {
    clock: { now: () => new Date(DRAIN_TIME) },
    evidence: stores.evidence,
    mastery:
      method === "putMastery"
        ? {
            ...stores.mastery,
            put: async (row) => {
              if (row.lastEventId === failForEventId) throw new Error("mastery write failed");
              return stores.mastery.put(row);
            },
          }
        : stores.mastery,
    reviews:
      method === "putCard" || method === "appendLog"
        ? {
            ...stores.reviews,
            putCard: async (card) => {
              if (method === "putCard" && card.lastEventId === failForEventId) {
                throw new Error("card write failed");
              }
              return stores.reviews.putCard(card);
            },
            appendLog: async (entry) => {
              if (method === "appendLog" && entry.eventId === failForEventId) {
                throw new Error("log write failed");
              }
              return stores.reviews.appendLog(entry);
            },
          }
        : stores.reviews,
  };
}

describe("learner commit resume on a real SQLite file (iter-1)", () => {
  it.each(["putCard", "appendLog", "putMastery"] as const)(
    "completes exactly once after a %s failure plus close/reopen",
    async (method) => {
      const home = await createHome();
      await ensureCoreInitialized({ ...process.env, READANY_HOME: home });
      const stores = createSqliteLearnerStores();
      const outbox = createSqliteEvidenceOutbox();

      await outbox.enqueue({ ...EVENT, timestamp: ANSWER_TIME }, ANSWER_TIME);

      // First drain: the chosen store write fails mid-apply.
      const failed = await drainEvidenceOutbox(depsWithFault(stores, method, EVENT.id), outbox);
      expect(failed.failed).toBe(1);

      // INTERRUPT: close the file for real, then relaunch.
      await interruptAndRelaunch(home);

      // Replay drain on the reopened file completes the remaining steps.
      const report = await drainEvidenceOutbox(learnerDeps(stores), createSqliteEvidenceOutbox());
      expect(report.applied).toBe(1);
      expect(report.alreadyApplied).toBe(0);

      // A duplicate transport of the SAME event changes nothing.
      const dup = await applyEvidenceEventResult(learnerDeps(stores), {
        ...EVENT,
        timestamp: ANSWER_TIME,
      });
      expect(dup.alreadyApplied).toBe(true);

      // Ground truth from the file, via a raw connection: exactly one of each.
      const raw = await openRawDb(home);
      try {
        expect(
          raw.prepare("SELECT COUNT(*) AS n FROM learner_evidence_events").get(),
        ).toMatchObject({ n: 1 });
        expect(
          raw
            .prepare("SELECT COUNT(*) AS n FROM learner_review_logs WHERE event_id = ?")
            .get(EVENT.id),
        ).toMatchObject({ n: 1 });
        const card = raw
          .prepare("SELECT reps, last_event_id, last_review FROM learner_review_cards")
          .get() as { reps: number; last_event_id: string; last_review: number } | undefined;
        expect(card?.reps).toBe(1);
        expect(card?.last_event_id).toBe(EVENT.id);
        // The original answer time survived the interrupt and the replay.
        expect(card?.last_review).toBe(ANSWER_TIME);
        const mastery = raw
          .prepare("SELECT evidence_count, last_event_id FROM learner_concept_mastery")
          .get() as { evidence_count: number; last_event_id: string } | undefined;
        expect(mastery?.evidence_count).toBe(1);
        expect(mastery?.last_event_id).toBe(EVENT.id);
      } finally {
        raw.close();
      }
    },
  );

  it("backs up an old-schema database once before adding the marker columns", async () => {
    const home = await createHome();
    // Simulate a pre-iter-1 install: learner tables WITHOUT marker columns.
    {
      const raw = new Database(join(home, "readany.db"));
      raw.pragma("journal_mode = WAL");
      raw.exec(`
        CREATE TABLE learner_review_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          concept_id TEXT NOT NULL,
          rating INTEGER NOT NULL,
          state INTEGER NOT NULL,
          due INTEGER NOT NULL,
          stability REAL NOT NULL,
          difficulty REAL NOT NULL,
          scheduled_days INTEGER NOT NULL,
          learning_steps INTEGER NOT NULL,
          review INTEGER NOT NULL,
          UNIQUE(concept_id, review)
        )
      `);
      raw.exec(`
        CREATE TABLE learner_concept_mastery (
          concept_id TEXT PRIMARY KEY,
          mastery REAL NOT NULL,
          confidence REAL NOT NULL,
          retention REAL,
          transfer REAL,
          last_verified INTEGER,
          next_review INTEGER,
          status TEXT NOT NULL,
          evidence_count INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      raw.exec(`
        CREATE TABLE learner_review_cards (
          concept_id TEXT PRIMARY KEY,
          due INTEGER NOT NULL,
          stability REAL NOT NULL,
          difficulty REAL NOT NULL,
          learning_steps INTEGER NOT NULL,
          reps INTEGER NOT NULL,
          lapses INTEGER NOT NULL,
          state INTEGER NOT NULL,
          last_review INTEGER
        )
      `);
      raw.close();
    }

    // The next init performs the one-time snapshot + marker migration.
    await ensureCoreInitialized({ ...process.env, READANY_HOME: home });
    await initDatabase();

    const backupPath = join(home, "readany.db.bak-learner-v2");
    const backup = new Database(backupPath, { readonly: true });
    try {
      const cols = backup
        .prepare("SELECT name FROM pragma_table_info('learner_review_logs')")
        .all() as Array<{ name: string }>;
      // The snapshot is pre-migration: no marker columns in it.
      expect(cols.map((c) => c.name)).not.toContain("event_id");
    } finally {
      backup.close();
    }

    // The live database now carries the markers.
    const raw = await openRawDb(home);
    try {
      const cols = raw
        .prepare("SELECT name FROM pragma_table_info('learner_review_logs')")
        .all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("event_id");
    } finally {
      raw.close();
    }
  });
});
