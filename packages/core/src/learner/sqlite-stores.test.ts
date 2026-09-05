import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteEvidenceOutbox, createSqliteLearnerStores } from "./sqlite-stores";
import { DuplicateEvidenceIdError } from "./stores";
import type { EvidenceEvent, LearnerReviewCardData, LearnerReviewLogEntry } from "./types";

// Mock pattern per packages/core/src/db/__tests__/session-queries.test.ts: the
// adapter is exercised against a scripted IDatabase so the SQL statements,
// parameter binding, row mapping, and the append-only error mapping are all
// verified without a Tauri/expo/node backend.

const execute = vi.fn<(sql: string, params?: unknown[]) => Promise<void>>();
const select = vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>();

vi.mock("../db/db-core", () => ({
  getDB: vi.fn(async () => ({ execute, select, close: vi.fn() })),
}));

vi.mock("../db/write-retry", () => ({
  runWithDbRetry: vi.fn(async (operation: () => Promise<void>) => operation()),
}));

const EVENT: EvidenceEvent = {
  id: "ev-1",
  conceptId: "readany:book:book-1:chapter:3",
  source: "READ_BOX_QUIZ",
  taskType: "quiz",
  questionType: "mc",
  difficulty: 2,
  result: "correct",
  confidence: 1,
  timestamp: 1788000000000,
  sourceLocator: { bookId: "book-1", chapterIndex: 3, cfi: "epubcfi(/6/14)" },
};

const CARD: LearnerReviewCardData = {
  conceptId: "readany:book:book-1:chapter:3",
  due: 1788086400000,
  stability: 2.3065,
  difficulty: 2.1181,
  learningSteps: 0,
  reps: 1,
  lapses: 0,
  state: 2,
  lastReview: 1788000000000,
};

const LOG: LearnerReviewLogEntry = {
  conceptId: CARD.conceptId,
  rating: 3,
  state: 0,
  due: CARD.due,
  stability: 0,
  difficulty: 0,
  scheduledDays: 3,
  learningSteps: 0,
  review: 1788000000000,
};

describe("sqlite learner stores", () => {
  beforeEach(() => {
    execute.mockReset();
    select.mockReset();
  });

  it("appends evidence with full parameter binding", async () => {
    const { evidence } = createSqliteLearnerStores();
    await evidence.append(EVENT);
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain("INSERT INTO learner_evidence_events");
    expect(params).toEqual([
      "ev-1",
      "readany:book:book-1:chapter:3",
      "READ_BOX_QUIZ",
      "quiz",
      "mc",
      2,
      "correct",
      1,
      1788000000000,
      "book-1",
      3,
      "epubcfi(/6/14)",
    ]);
  });

  it("maps unique-constraint failures to DuplicateEvidenceIdError (append-only)", async () => {
    const { evidence } = createSqliteLearnerStores();
    execute.mockRejectedValueOnce(
      new Error("UNIQUE constraint failed: learner_evidence_events.id"),
    );
    await expect(evidence.append(EVENT)).rejects.toBeInstanceOf(DuplicateEvidenceIdError);
    // Non-constraint errors propagate untouched (fail closed).
    execute.mockRejectedValueOnce(new Error("database is locked"));
    await expect(evidence.append({ ...EVENT, id: "ev-2" })).rejects.toThrow("database is locked");
  });

  it("lists evidence rows mapped back to camelCase with an undefined-free locator", async () => {
    const { evidence } = createSqliteLearnerStores();
    select.mockResolvedValueOnce([
      {
        id: "ev-1",
        concept_id: EVENT.conceptId,
        source: "READ_BOX_QUIZ",
        task_type: "quiz",
        question_type: null,
        difficulty: null,
        result: "correct",
        confidence: 1,
        timestamp: 1788000000000,
        source_book_id: null,
        source_chapter_index: 3,
        source_cfi: null,
      },
    ]);
    const events = await evidence.listByConcept(EVENT.conceptId);
    expect(select.mock.calls[0][0]).toContain("ORDER BY timestamp ASC");
    expect(events[0].questionType).toBeUndefined();
    expect(events[0].difficulty).toBeUndefined();
    expect(events[0].sourceLocator).toEqual({ chapterIndex: 3 });
  });

  it("counts evidence via row length (portable across sqlite backends)", async () => {
    const { evidence } = createSqliteLearnerStores();
    select.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
    await expect(evidence.countByConcept(EVENT.conceptId)).resolves.toBe(2);
  });

  it("round-trips mastery rows with null-preserving mapping", async () => {
    const { mastery } = createSqliteLearnerStores();
    select.mockResolvedValueOnce([
      {
        concept_id: EVENT.conceptId,
        mastery: 0.64606,
        confidence: 1 / 15,
        retention: null,
        transfer: null,
        last_verified: 1788000000000,
        next_review: 1788086400000,
        status: "learning",
        evidence_count: 1,
        updated_at: 1788000000000,
      },
    ]);
    const row = await mastery.get(EVENT.conceptId);
    expect(row).toEqual({
      conceptId: EVENT.conceptId,
      mastery: 0.64606,
      confidence: 1 / 15,
      retention: null,
      transfer: null,
      lastVerified: 1788000000000,
      nextReview: 1788086400000,
      status: "learning",
      evidenceCount: 1,
      updatedAt: 1788000000000,
    });
    select.mockResolvedValueOnce([]);
    await expect(mastery.get("unknown")).resolves.toBeNull();
    await mastery.put({
      conceptId: EVENT.conceptId,
      mastery: 0.7,
      confidence: 0.5,
      retention: 0.9,
      transfer: null,
      lastVerified: 1,
      nextReview: 2,
      status: "stable",
      evidenceCount: 8,
      updatedAt: 3,
    });
    expect(execute.mock.calls[0][0]).toContain("INSERT OR REPLACE INTO learner_concept_mastery");
  });

  it("round-trips review cards and appends logs", async () => {
    const { reviews } = createSqliteLearnerStores();
    select.mockResolvedValueOnce([
      {
        concept_id: CARD.conceptId,
        due: CARD.due,
        stability: CARD.stability,
        difficulty: CARD.difficulty,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 2,
        last_review: CARD.lastReview,
      },
    ]);
    const card = await reviews.getCard(CARD.conceptId);
    expect(card).toEqual(CARD);
    select.mockResolvedValueOnce([]);
    await expect(reviews.getCard("unknown")).resolves.toBeNull();
    await reviews.putCard(CARD);
    expect(execute.mock.calls[0][0]).toContain("INSERT OR REPLACE INTO learner_review_cards");
    await reviews.appendLog(LOG);
    expect(execute.mock.calls[1][0]).toContain("INSERT INTO learner_review_logs");
    expect(execute.mock.calls[1][1]).toEqual([
      LOG.conceptId,
      3,
      0,
      LOG.due,
      0,
      0,
      3,
      0,
      LOG.review,
    ]);
  });

  it("uses the injected database when provided instead of the shared connection", async () => {
    const injectedExecute = vi.fn<(sql: string, params?: unknown[]) => Promise<void>>();
    const injected: {
      execute: typeof injectedExecute;
      select: () => Promise<unknown[]>;
      close: () => Promise<void>;
    } = {
      execute: injectedExecute,
      select: async () => [],
      close: async () => undefined,
    };
    const { evidence } = createSqliteLearnerStores(injected as never);
    await evidence.append(EVENT);
    expect(injectedExecute).toHaveBeenCalledTimes(1);
  });

  it("enqueues outbox rows with the event id pinned in the stored JSON (PR-012)", async () => {
    const outbox = createSqliteEvidenceOutbox();
    const { event } = await outbox.enqueue(
      { ...EVENT, sourceLocator: { bookId: "book-1", chapterIndex: 3 } },
      1788000000000,
    );
    expect(event.id).toBe("ev-1");
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain("INSERT INTO learner_evidence_outbox");
    expect(params[2]).toBe(1788000000000);
    const stored = JSON.parse(params[1] as string) as { id: string; conceptId: string };
    expect(stored.id).toBe("ev-1");
    expect(stored.conceptId).toBe(EVENT.conceptId);

    select.mockResolvedValueOnce([
      {
        id: "ob-1",
        event_json: params[1],
        created_at: 1788000000000,
        attempts: 2,
        status: "pending",
        last_error: "disk on fire",
      },
    ]);
    const pending = await outbox.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      outboxId: "ob-1",
      createdAt: 1788000000000,
      attempts: 2,
      status: "pending",
      lastError: "disk on fire",
    });
    expect(pending[0].event.id).toBe("ev-1");

    await outbox.markDone("ob-1");
    expect(execute.mock.calls[1][0]).toContain("SET status = 'done'");

    await outbox.markError("ob-1", "again");
    expect(execute.mock.calls[2][0]).toContain("attempts = attempts + 1");
    expect(execute.mock.calls[2][1]).toEqual(["again", "ob-1"]);
  });
});
