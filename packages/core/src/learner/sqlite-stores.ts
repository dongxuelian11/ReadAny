// SQLite adapters for the deterministic learner core (PR-005 wiring). These
// implement the PR-004 store interfaces over the shared IDatabase surface
// (plugin-sql on desktop, expo-sqlite on mobile, better-sqlite3 on the CLI),
// so the learner Authority persists in the same readany.db as the rest of the
// deterministic state. Enforced invariants, mirroring learner/stores.ts:
// evidence ids are append-only (duplicate ids throw DuplicateEvidenceIdError
// via the primary key), nothing is deleted, review logs are idempotent per
// (concept, review) via a UNIQUE constraint.

import { getDB } from "../db/db-core";
import { runWithDbRetry } from "../db/write-retry";
import type { IDatabase } from "../services/platform";
import type { EvidenceEventInput } from "./engine";
import type { GoalSpec } from "./goal";
import type { GoalStore } from "./goal-store";
import type { LearnerEvidenceOutboxStore, PinnedEvidenceEvent } from "./outbox";
import type {
  PlacementItem,
  PlacementResponse,
  PlacementSession,
  PlacementSessionStatus,
  PlacementStore,
} from "./placement";
import { DuplicateEvidenceIdError } from "./stores";
import type { TeachingSession, TeachingStep } from "./teaching";
import type { TeachingStore } from "./teaching-store";
import type {
  ConceptMastery,
  EvidenceEvent,
  EvidenceQuestionType,
  EvidenceResult,
  EvidenceSource,
  EvidenceTaskType,
  LearnerEvidenceStore,
  LearnerMasteryStore,
  LearnerReviewCardData,
  LearnerReviewLogEntry,
  LearnerReviewStore,
  MasteryStatus,
} from "./types";

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|primary key must be unique/i.test(message);
}

export class SqliteLearnerEvidenceStore implements LearnerEvidenceStore {
  constructor(private readonly database?: IDatabase) {}

  private async db(): Promise<IDatabase> {
    return this.database ?? (await getDB());
  }

  async append(event: EvidenceEvent): Promise<void> {
    const database = await this.db();
    try {
      await runWithDbRetry(() =>
        database.execute(
          `INSERT INTO learner_evidence_events
            (id, concept_id, source, task_type, question_type, difficulty, result, confidence,
             timestamp, source_book_id, source_chapter_index, source_cfi)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            event.id,
            event.conceptId,
            event.source,
            event.taskType,
            event.questionType ?? null,
            event.difficulty ?? null,
            event.result,
            event.confidence,
            event.timestamp,
            event.sourceLocator?.bookId ?? null,
            event.sourceLocator?.chapterIndex ?? null,
            event.sourceLocator?.cfi ?? null,
          ],
        ),
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new DuplicateEvidenceIdError(event.id);
      throw error;
    }
  }

  async listByConcept(conceptId: string): Promise<EvidenceEvent[]> {
    const database = await this.db();
    const rows = await database.select<Record<string, unknown>>(
      `SELECT id, concept_id, source, task_type, question_type, difficulty, result, confidence,
              timestamp, source_book_id, source_chapter_index, source_cfi
       FROM learner_evidence_events
       WHERE concept_id = ?
       ORDER BY timestamp ASC, id ASC`,
      [conceptId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      conceptId: String(row.concept_id),
      source: row.source as EvidenceSource,
      taskType: row.task_type as EvidenceTaskType,
      questionType: (row.question_type as EvidenceQuestionType | null) ?? undefined,
      difficulty: (row.difficulty as 1 | 2 | 3 | null) ?? undefined,
      result: row.result as EvidenceResult,
      confidence: Number(row.confidence),
      timestamp: Number(row.timestamp),
      sourceLocator:
        row.source_book_id === null && row.source_chapter_index === null && row.source_cfi === null
          ? undefined
          : {
              bookId: (row.source_book_id as string | null) ?? undefined,
              chapterIndex: (row.source_chapter_index as number | null) ?? undefined,
              cfi: (row.source_cfi as string | null) ?? undefined,
            },
    }));
  }

  async countByConcept(conceptId: string): Promise<number> {
    const database = await this.db();
    const rows = await database.select<{ id: string }>(
      "SELECT id FROM learner_evidence_events WHERE concept_id = ?",
      [conceptId],
    );
    return rows.length;
  }
}

export class SqliteLearnerMasteryStore implements LearnerMasteryStore {
  constructor(private readonly database?: IDatabase) {}

  private async db(): Promise<IDatabase> {
    return this.database ?? (await getDB());
  }

  async get(conceptId: string): Promise<ConceptMastery | null> {
    const database = await this.db();
    const rows = await database.select<Record<string, unknown>>(
      `SELECT concept_id, mastery, confidence, retention, transfer, last_verified, next_review,
              status, evidence_count, updated_at
       FROM learner_concept_mastery
       WHERE concept_id = ?`,
      [conceptId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      conceptId: String(row.concept_id),
      mastery: Number(row.mastery),
      confidence: Number(row.confidence),
      retention: row.retention === null ? null : Number(row.retention),
      transfer: row.transfer === null ? null : Number(row.transfer),
      lastVerified: row.last_verified === null ? null : Number(row.last_verified),
      nextReview: row.next_review === null ? null : Number(row.next_review),
      status: row.status as MasteryStatus,
      evidenceCount: Number(row.evidence_count),
      updatedAt: Number(row.updated_at),
    };
  }

  async put(mastery: ConceptMastery): Promise<void> {
    const database = await this.db();
    await runWithDbRetry(() =>
      database.execute(
        `INSERT OR REPLACE INTO learner_concept_mastery
          (concept_id, mastery, confidence, retention, transfer, last_verified, next_review,
           status, evidence_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          mastery.conceptId,
          mastery.mastery,
          mastery.confidence,
          mastery.retention,
          mastery.transfer,
          mastery.lastVerified,
          mastery.nextReview,
          mastery.status,
          mastery.evidenceCount,
          mastery.updatedAt,
        ],
      ),
    );
  }
}

export class SqliteLearnerReviewStore implements LearnerReviewStore {
  constructor(private readonly database?: IDatabase) {}

  private async db(): Promise<IDatabase> {
    return this.database ?? (await getDB());
  }

  async getCard(conceptId: string): Promise<LearnerReviewCardData | null> {
    const database = await this.db();
    const rows = await database.select<Record<string, unknown>>(
      `SELECT concept_id, due, stability, difficulty, learning_steps, reps, lapses, state, last_review
       FROM learner_review_cards
       WHERE concept_id = ?`,
      [conceptId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      conceptId: String(row.concept_id),
      due: Number(row.due),
      stability: Number(row.stability),
      difficulty: Number(row.difficulty),
      learningSteps: Number(row.learning_steps),
      reps: Number(row.reps),
      lapses: Number(row.lapses),
      state: Number(row.state),
      lastReview: row.last_review === null ? null : Number(row.last_review),
    };
  }

  async putCard(card: LearnerReviewCardData): Promise<void> {
    const database = await this.db();
    await runWithDbRetry(() =>
      database.execute(
        `INSERT OR REPLACE INTO learner_review_cards
          (concept_id, due, stability, difficulty, learning_steps, reps, lapses, state, last_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          card.conceptId,
          card.due,
          card.stability,
          card.difficulty,
          card.learningSteps,
          card.reps,
          card.lapses,
          card.state,
          card.lastReview,
        ],
      ),
    );
  }

  async appendLog(entry: LearnerReviewLogEntry): Promise<void> {
    const database = await this.db();
    await runWithDbRetry(() =>
      database.execute(
        `INSERT INTO learner_review_logs
          (concept_id, rating, state, due, stability, difficulty, scheduled_days, learning_steps, review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.conceptId,
          entry.rating,
          entry.state,
          entry.due,
          entry.stability,
          entry.difficulty,
          entry.scheduledDays,
          entry.learningSteps,
          entry.review,
        ],
      ),
    );
  }

  async listCardsDueBefore(timestamp: number, limit?: number): Promise<LearnerReviewCardData[]> {
    const database = await this.db();
    const bound = limit ?? -1;
    const rows = await database.select<Record<string, unknown>>(
      `SELECT concept_id, due, stability, difficulty, learning_steps, reps, lapses, state, last_review
       FROM learner_review_cards
       WHERE due <= ?
       ORDER BY due ASC
       ${bound >= 0 ? "LIMIT ?" : ""}`,
      bound >= 0 ? [timestamp, bound] : [timestamp],
    );
    return rows.map((row) => ({
      conceptId: String(row.concept_id),
      due: Number(row.due),
      stability: Number(row.stability),
      difficulty: Number(row.difficulty),
      learningSteps: Number(row.learning_steps),
      reps: Number(row.reps),
      lapses: Number(row.lapses),
      state: Number(row.state),
      lastReview: row.last_review === null ? null : Number(row.last_review),
    }));
  }
}

export class SqlitePlacementStore implements PlacementStore {
  constructor(private readonly database?: IDatabase) {}

  private async db(): Promise<IDatabase> {
    return this.database ?? (await getDB());
  }

  private static rowToSession(row: Record<string, unknown>): PlacementSession {
    return {
      id: String(row.id),
      status: row.status as PlacementSessionStatus,
      theta: Number(row.theta),
      startedAt: Number(row.started_at),
      finalizedAt: row.finalized_at === null ? null : Number(row.finalized_at),
      items: JSON.parse(String(row.items_json)) as PlacementItem[],
      responses: JSON.parse(String(row.responses_json) || "[]") as PlacementResponse[],
    };
  }

  async get(id: string): Promise<PlacementSession | null> {
    const database = await this.db();
    const rows = await database.select<Record<string, unknown>>(
      "SELECT * FROM learner_placement_sessions WHERE id = ?",
      [id],
    );
    const row = rows[0];
    return row ? SqlitePlacementStore.rowToSession(row) : null;
  }

  async put(session: PlacementSession): Promise<void> {
    const database = await this.db();
    await runWithDbRetry(() =>
      database.execute(
        `INSERT OR REPLACE INTO learner_placement_sessions
          (id, status, theta, started_at, finalized_at, items_json, responses_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id,
          session.status,
          session.theta,
          session.startedAt,
          session.finalizedAt,
          JSON.stringify(session.items),
          JSON.stringify(session.responses),
        ],
      ),
    );
  }

  async getActive(): Promise<PlacementSession | null> {
    const database = await this.db();
    const rows = await database.select<Record<string, unknown>>(
      "SELECT * FROM learner_placement_sessions WHERE status = 'active' ORDER BY started_at DESC",
    );
    const row = rows[0];
    return row ? SqlitePlacementStore.rowToSession(row) : null;
  }
}

export class SqliteTeachingStore implements TeachingStore {
  constructor(private readonly database?: IDatabase) {}

  private async db(): Promise<IDatabase> {
    return this.database ?? (await getDB());
  }

  private static rowToSession(row: Record<string, unknown>): TeachingSession {
    return {
      id: String(row.id),
      goalId: String(row.goal_id),
      bookId: String(row.book_id),
      status: row.status as TeachingSession["status"],
      steps: JSON.parse(String(row.steps_json)) as TeachingStep[],
      currentIndex: Number(row.current_index),
      startedAt: Number(row.started_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
    };
  }

  async get(id: string): Promise<TeachingSession | null> {
    const database = await this.db();
    const rows = await database.select<Record<string, unknown>>(
      "SELECT * FROM learner_teaching_sessions WHERE id = ?",
      [id],
    );
    const row = rows[0];
    return row ? SqliteTeachingStore.rowToSession(row) : null;
  }

  async put(session: TeachingSession): Promise<void> {
    const database = await this.db();
    await runWithDbRetry(() =>
      database.execute(
        `INSERT OR REPLACE INTO learner_teaching_sessions
          (id, goal_id, book_id, status, steps_json, current_index, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id,
          session.goalId,
          session.bookId,
          session.status,
          JSON.stringify(session.steps),
          session.currentIndex,
          session.startedAt,
          session.completedAt,
        ],
      ),
    );
  }

  async getActive(): Promise<TeachingSession | null> {
    const database = await this.db();
    const rows = await database.select<Record<string, unknown>>(
      "SELECT * FROM learner_teaching_sessions WHERE status = 'active' ORDER BY started_at DESC",
    );
    const row = rows[0];
    return row ? SqliteTeachingStore.rowToSession(row) : null;
  }
}

export class SqliteGoalStore implements GoalStore {
  constructor(private readonly database?: IDatabase) {}

  private async db(): Promise<IDatabase> {
    return this.database ?? (await getDB());
  }

  private static rowToGoal(row: Record<string, unknown>): GoalSpec {
    return {
      goalId: String(row.goal_id),
      bookId: String(row.book_id),
      goalText: String(row.goal_text),
      restatedGoal: String(row.restated_goal),
      targetCapabilities: JSON.parse(String(row.target_capabilities_json)) as string[],
      chapters: JSON.parse(String(row.chapters_json)) as GoalSpec["chapters"],
      milestones: JSON.parse(String(row.milestones_json)) as string[],
      completionCriteria: JSON.parse(String(row.completion_criteria_json)) as string[],
      createdAt: Number(row.created_at),
      active: Number(row.active) === 1,
    };
  }

  async get(goalId: string): Promise<GoalSpec | null> {
    const database = await this.db();
    const rows = await database.select<Record<string, unknown>>(
      "SELECT * FROM learner_goals WHERE goal_id = ?",
      [goalId],
    );
    const row = rows[0];
    return row ? SqliteGoalStore.rowToGoal(row) : null;
  }

  async put(goal: GoalSpec): Promise<void> {
    const database = await this.db();
    await runWithDbRetry(() =>
      database.execute(
        `INSERT OR REPLACE INTO learner_goals
          (goal_id, book_id, goal_text, restated_goal, target_capabilities_json, chapters_json,
           milestones_json, completion_criteria_json, created_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          goal.goalId,
          goal.bookId,
          goal.goalText,
          goal.restatedGoal,
          JSON.stringify(goal.targetCapabilities),
          JSON.stringify(goal.chapters),
          JSON.stringify(goal.milestones),
          JSON.stringify(goal.completionCriteria),
          goal.createdAt,
          goal.active ? 1 : 0,
        ],
      ),
    );
  }

  async listByBook(bookId: string): Promise<GoalSpec[]> {
    const database = await this.db();
    const rows = await database.select<Record<string, unknown>>(
      "SELECT * FROM learner_goals WHERE book_id = ? ORDER BY created_at DESC",
      [bookId],
    );
    return rows.map((row) => SqliteGoalStore.rowToGoal(row));
  }

  async getActive(bookId: string): Promise<GoalSpec | null> {
    const database = await this.db();
    const rows = await database.select<Record<string, unknown>>(
      "SELECT * FROM learner_goals WHERE book_id = ? AND active = 1 ORDER BY created_at DESC",
      [bookId],
    );
    const row = rows[0];
    return row ? SqliteGoalStore.rowToGoal(row) : null;
  }
}

export interface SqliteLearnerStores {
  evidence: LearnerEvidenceStore;
  mastery: LearnerMasteryStore;
  reviews: LearnerReviewStore;
  placements: PlacementStore;
  goals: GoalStore;
  teachings: TeachingStore;
}

export function createSqliteLearnerStores(database?: IDatabase): SqliteLearnerStores {
  return {
    evidence: new SqliteLearnerEvidenceStore(database),
    mastery: new SqliteLearnerMasteryStore(database),
    reviews: new SqliteLearnerReviewStore(database),
    placements: new SqlitePlacementStore(database),
    goals: new SqliteGoalStore(database),
    teachings: new SqliteTeachingStore(database),
  };
}

/** Durable evidence outbox adapter (PR-012): the event is stored as JSON with
 * its id already pinned, so a replayed row applies byte-identically and hits
 * the append-only ledger's duplicate rejection instead of double-applying. */
export class SqliteEvidenceOutboxStore implements LearnerEvidenceOutboxStore {
  constructor(private readonly database?: IDatabase) {}

  private async db(): Promise<IDatabase> {
    return this.database ?? (await getDB());
  }

  async enqueue(
    event: EvidenceEventInput,
    createdAt: number,
  ): Promise<{ outboxId: string; event: PinnedEvidenceEvent }> {
    const database = await this.db();
    const outboxId = crypto.randomUUID();
    const pinned: PinnedEvidenceEvent = { ...event, id: event.id ?? crypto.randomUUID() };
    await runWithDbRetry(() =>
      database.execute(
        `INSERT INTO learner_evidence_outbox (id, event_json, created_at, attempts, status, last_error)
         VALUES (?, ?, ?, 0, 'pending', NULL)`,
        [outboxId, JSON.stringify(pinned), createdAt],
      ),
    );
    return { outboxId, event: pinned };
  }

  async listPending(limit?: number) {
    const database = await this.db();
    const rows = await database.select<Record<string, unknown>>(
      `SELECT id, event_json, created_at, attempts, status, last_error
       FROM learner_evidence_outbox
       WHERE status = 'pending'
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      [limit ?? -1],
    );
    return rows.map((row) => ({
      outboxId: String(row.id),
      event: JSON.parse(String(row.event_json)) as PinnedEvidenceEvent,
      createdAt: Number(row.created_at),
      attempts: Number(row.attempts),
      status: row.status as "pending" | "done",
      lastError: (row.last_error as string | null) ?? null,
    }));
  }

  async markDone(outboxId: string): Promise<void> {
    const database = await this.db();
    await runWithDbRetry(() =>
      database.execute(
        "UPDATE learner_evidence_outbox SET status = 'done', last_error = NULL WHERE id = ?",
        [outboxId],
      ),
    );
  }

  async markError(outboxId: string, message: string): Promise<void> {
    const database = await this.db();
    await runWithDbRetry(() =>
      database.execute(
        "UPDATE learner_evidence_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?",
        [message, outboxId],
      ),
    );
  }
}

export function createSqliteEvidenceOutbox(database?: IDatabase): LearnerEvidenceOutboxStore {
  return new SqliteEvidenceOutboxStore(database);
}
