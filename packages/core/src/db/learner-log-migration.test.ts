// PR32-followup (F03): the review-log uniqueness migration against REAL
// SQLite (node:sqlite), including close-and-reopen. The reviewer probe proved
// the old constraint silently swallowed a second legitimate attempt; this
// test asserts the migrated shape keeps every row and accepts same-instant
// attempts.

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrateLearnerReviewLogsIdentity } from "./learner-log-migration";
import type { IDatabase } from "../services/platform";

const LEGACY_DDL = `
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
    event_id TEXT,
    UNIQUE(concept_id, review)
  )
`;

const REBUILT_DDL = LEGACY_DDL.replace(",\n    UNIQUE(concept_id, review)", "");

/** Minimal IDatabase over a real SQLite file/in-memory database. */
function adapt(db: DatabaseSync): IDatabase {
  return {
    async execute(sql: string, params: unknown[] = []) {
      db.prepare(sql).run(...params);
    },
    async select<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async close() {
      db.close();
    },
  };
}

describe("learner review-log identity migration (F03, real SQLite)", () => {
  it("a legacy table is rebuilt without the time-unique constraint and keeps every row", () => {
    const db = new DatabaseSync(":memory:");
    const database = adapt(db);
    db.exec(LEGACY_DDL);
    // One pre-event-id legacy row and one modern row.
    db.prepare(
      "INSERT INTO learner_review_logs (concept_id, rating, state, due, stability, difficulty, scheduled_days, learning_steps, review, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("c1", 3, 0, 1000, 1.0, 5.0, 1, 0, 1000, null);
    db.prepare(
      "INSERT INTO learner_review_logs (concept_id, rating, state, due, stability, difficulty, scheduled_days, learning_steps, review, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("c1", 3, 0, 2000, 2.0, 5.0, 1, 0, 2000, "ev-2");

    const migrated = (async () =>
      migrateLearnerReviewLogsIdentity(database, { backupFilePath: null }))();
    return (async () => {
      expect(await migrated).toBe(true);

      const rows = db
        .prepare("SELECT concept_id, review, event_id FROM learner_review_logs ORDER BY id")
        .all() as Array<{ concept_id: string; review: number; event_id: string | null }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ concept_id: "c1", review: 1000, event_id: null });
      expect(rows[1]).toEqual({ concept_id: "c1", review: 2000, event_id: "ev-2" });
      // The legacy AUTOINCREMENT ids are preserved.
      const ids = db.prepare("SELECT id FROM learner_review_logs ORDER BY id").all() as Array<{
        id: number;
      }>;
      expect(ids.map((entry) => entry.id)).toEqual([1, 2]);

      const constraints = db
        .prepare("SELECT name FROM pragma_index_list('learner_review_logs') WHERE origin = 'u'")
        .all();
      expect(constraints).toHaveLength(0);
      const eventIndex = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_learner_review_logs_event'",
        )
        .all();
      expect(eventIndex).toHaveLength(1);

      // The point of the migration: two legitimate attempts at the same
      // instant BOTH get their log row.
      db.prepare(
        "INSERT INTO learner_review_logs (concept_id, rating, state, due, stability, difficulty, scheduled_days, learning_steps, review, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("c1", 3, 0, 3000, 3.0, 5.0, 1, 0, 3000, "ev-3a");
      db.prepare(
        "INSERT INTO learner_review_logs (concept_id, rating, state, due, stability, difficulty, scheduled_days, learning_steps, review, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("c1", 3, 0, 3000, 3.0, 5.0, 1, 0, 3000, "ev-3b");
      const after = db.prepare("SELECT COUNT(*) AS n FROM learner_review_logs").all() as Array<{
        n: number;
      }>;
      expect(after[0].n).toBe(4);
      // Same event id is still deduplicated by the unique index.
      expect(() =>
        db
          .prepare(
            "INSERT INTO learner_review_logs (concept_id, rating, state, due, stability, difficulty, scheduled_days, learning_steps, review, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run("c1", 3, 0, 3000, 3.0, 5.0, 1, 0, 3000, "ev-3b"),
      ).toThrow();
    })();
  });

  it("a fresh database without the legacy constraint is untouched", async () => {
    const db = new DatabaseSync(":memory:");
    const database = adapt(db);
    db.exec(REBUILT_DDL);
    db.exec(
      "CREATE UNIQUE INDEX idx_logs_event ON learner_review_logs(event_id) WHERE event_id IS NOT NULL",
    );
    await expect(migrateLearnerReviewLogsIdentity(database)).resolves.toBe(false);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM learner_review_logs").all() as Array<{
      n: number;
    }>;
    expect(rows[0].n).toBe(0);
  });

  it("an interrupted scratch table from a previous run does not block the rebuild", async () => {
    const db = new DatabaseSync(":memory:");
    const database = adapt(db);
    db.exec(LEGACY_DDL);
    db.exec("CREATE TABLE learner_review_logs_identity (id INTEGER PRIMARY KEY)");
    await expect(
      migrateLearnerReviewLogsIdentity(database, { backupFilePath: null }),
    ).resolves.toBe(true);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM learner_review_logs").all() as Array<{
      n: number;
    }>;
    expect(rows[0].n).toBe(0);
  });
});
