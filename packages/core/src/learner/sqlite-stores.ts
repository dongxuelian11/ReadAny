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
import type {
  PlacementItem,
  PlacementResponse,
  PlacementSession,
  PlacementSessionStatus,
  PlacementStore,
} from "./placement";
import { DuplicateEvidenceIdError } from "./stores";
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

export interface SqliteLearnerStores {
  evidence: LearnerEvidenceStore;
  mastery: LearnerMasteryStore;
  reviews: LearnerReviewStore;
  placements: PlacementStore;
}

export function createSqliteLearnerStores(database?: IDatabase): SqliteLearnerStores {
  return {
    evidence: new SqliteLearnerEvidenceStore(database),
    mastery: new SqliteLearnerMasteryStore(database),
    reviews: new SqliteLearnerReviewStore(database),
    placements: new SqlitePlacementStore(database),
  };
}
