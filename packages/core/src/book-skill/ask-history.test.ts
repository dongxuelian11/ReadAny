import { describe, expect, it, vi } from "vitest";
import {
  ASK_HISTORY_RETENTION,
  createInMemoryAskHistoryStore,
  createSqliteAskHistoryStore,
} from "./ask-history";
import type { CrossBookAnswer } from "./cross-book";

// Mock pattern per learner/sqlite-stores.test.ts: the adapter is exercised
// against a scripted IDatabase without a Tauri/expo/node backend.
const execute = vi.fn<(sql: string, params?: unknown[]) => Promise<void>>();
const select = vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>();

vi.mock("../db/db-core", () => ({
  getDB: vi.fn(async () => ({ execute, select, close: vi.fn() })),
}));

vi.mock("../db/write-retry", () => ({
  runWithDbRetry: vi.fn(async (operation: () => Promise<void>) => operation()),
}));

function answer(question: string): CrossBookAnswer {
  return {
    question,
    matchedSlugs: ["bogle"],
    broadcast: false,
    reports: [],
    droppedSlugs: [],
    synthesis: `essay for ${question}`,
    report: { claims: [], failedSlugs: [], claimsUnparsed: false },
  };
}

describe("cross-book ask history (PR-020)", () => {
  it("stores and lists answers newest first", async () => {
    const store = createInMemoryAskHistoryStore();
    await store.save({ id: "a1", question: "q1", createdAt: 100, answer: answer("q1") });
    await store.save({ id: "a2", question: "q2", createdAt: 200, answer: answer("q2") });
    await store.save({ id: "a3", question: "q3", createdAt: 300, answer: answer("q3") });

    const list = await store.list();
    expect(list.map((entry) => entry.id)).toEqual(["a3", "a2", "a1"]);

    const limited = await store.list(2);
    expect(limited.map((entry) => entry.id)).toEqual(["a3", "a2"]);
  });

  it("re-saving an id replaces the row (idempotent per explicit id)", async () => {
    const store = createInMemoryAskHistoryStore();
    await store.save({ id: "a1", question: "q1", createdAt: 100, answer: answer("q1") });
    await store.save({ id: "a1", question: "q1", createdAt: 100, answer: answer("q1-retry") });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].answer.synthesis).toBe("essay for q1-retry");
  });

  it("trims beyond the retention cap, keeping the newest", async () => {
    const store = createInMemoryAskHistoryStore();
    for (let i = 0; i < ASK_HISTORY_RETENTION + 5; i += 1) {
      await store.save({ id: `a${i}`, question: `q${i}`, createdAt: i, answer: answer(`q${i}`) });
    }
    const list = await store.list();
    expect(list).toHaveLength(ASK_HISTORY_RETENTION);
    expect(list[0].id).toBe(`a${ASK_HISTORY_RETENTION + 4}`);
    expect(list.at(-1)?.id).toBe("a5");
  });

  it("round-trips rows through the sqlite adapter with binding verification", async () => {
    const store = createSqliteAskHistoryStore();
    await store.save({ id: "a1", question: "q1", createdAt: 1788000000000, answer: answer("q1") });
    expect(execute).toHaveBeenCalledTimes(2); // INSERT + retention trim
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain("INSERT OR REPLACE INTO book_skill_ask_history");
    expect(params).toEqual(["a1", "q1", JSON.stringify(answer("q1")), 1788000000000]);

    select.mockResolvedValueOnce([
      {
        id: "a1",
        question: "q1",
        answer_json: JSON.stringify(answer("q1")),
        created_at: 1788000000000,
      },
    ]);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].answer.report.claimsUnparsed).toBe(false);
    expect(select.mock.calls[0][0]).toContain("ORDER BY created_at DESC");
  });
});
