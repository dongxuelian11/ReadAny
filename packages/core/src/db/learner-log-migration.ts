// PR32-followup (F03): the learner review-log table predates attempt-scoped
// event ids and still carries UNIQUE(concept_id, review). Two legitimate
// attempts at the same concept in the same millisecond (fixed-clock batch
// replay, fast double input) are NOT duplicates, but the old constraint made
// the second log insert fail — and the atomic commit's OR IGNORE silently
// dropped it while everything else reported success. The table is rebuilt
// WITHOUT that constraint: deduplication for new logs is the event_id unique
// index alone; legacy rows without an event_id are preserved untouched.

import type { IDatabase } from "../services/platform";

const REBUILT_DDL = `
    CREATE TABLE learner_review_logs_identity (
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
      event_id TEXT
    )
  `;

/**
 * Rebuild learner_review_logs without the legacy UNIQUE(concept_id, review)
 * table constraint, preserving every existing row (id, values, and NULL
 * event_ids included). Returns true when a rebuild happened.
 *
 * Detection is the table-constraint autoindex (pragma_index_list origin 'u'),
 * so fresh installs of the already-rebuilt shape are untouched. The rebuild
 * runs in ONE transaction on the caller's connection; the optional backup file
 * (VACUUM INTO, desktop only) is taken BEFORE that transaction starts, since
 * SQLite forbids VACUUM inside one.
 */
export async function migrateLearnerReviewLogsIdentity(
  database: IDatabase,
  options: { backupFilePath?: string | null } = {},
): Promise<boolean> {
  // Idempotency + crash recovery: a leftover scratch table from an interrupted
  // run is dropped before the detection (the real table is untouched at that
  // point, so nothing is lost).
  await database.execute("DROP TABLE IF EXISTS learner_review_logs_identity");

  const legacyConstraints = await database.select<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pragma_index_list('learner_review_logs') WHERE origin = 'u'",
  );
  if ((legacyConstraints[0]?.n ?? 0) === 0) {
    return false;
  }

  if (options.backupFilePath) {
    try {
      await database.execute(
        `VACUUM INTO '${options.backupFilePath.replace(/'/g, "''")}'`,
      );
    } catch {
      // Backup is best-effort (a previous snapshot may already exist): never
      // block the migration.
    }
  }

  await database.execute("BEGIN IMMEDIATE");
  try {
    await database.execute(REBUILT_DDL);
    await database.execute(`
      INSERT INTO learner_review_logs_identity
        (id, concept_id, rating, state, due, stability, difficulty,
         scheduled_days, learning_steps, review, event_id)
      SELECT id, concept_id, rating, state, due, stability, difficulty,
             scheduled_days, learning_steps, review, event_id
      FROM learner_review_logs
    `);
    await database.execute("DROP TABLE learner_review_logs");
    await database.execute(
      "ALTER TABLE learner_review_logs_identity RENAME TO learner_review_logs",
    );
    await database.execute("COMMIT");
  } catch (error) {
    try {
      await database.execute("ROLLBACK");
    } catch {
      // No active transaction — nothing to roll back.
    }
    throw error;
  }
  await database.execute(
    "CREATE INDEX IF NOT EXISTS idx_learner_review_logs_concept ON learner_review_logs(concept_id, review)",
  );
  await database.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_learner_review_logs_event ON learner_review_logs(event_id) WHERE event_id IS NOT NULL",
  );
  return true;
}
