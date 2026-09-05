// Cross-book ask persistence (PR-020 — recorded PR-011/017 candidate "answer
// persistence/history"). A shelf ask costs several LLM calls and produces a
// verified claim report; losing it to a panel reset wastes both. The full
// CrossBookAnswer (synthesis + report) is stored as one JSON row, newest
// first, trimmed to the retention cap. Display needs only the stored answer —
// reopening a past ask re-renders the exact verified/unverified badges.

import { getDB } from "../db/db-core";
import { runWithDbRetry } from "../db/write-retry";
import type { IDatabase } from "../services/platform";
import type { CrossBookAnswer } from "./cross-book";

/** Keep the most recent asks; older rows are trimmed on save. */
export const ASK_HISTORY_RETENTION = 50;

export interface StoredAskAnswer {
  id: string;
  question: string;
  createdAt: number;
  answer: CrossBookAnswer;
}

export interface AskHistoryStore {
  /** Persist one ask (idempotent per explicit id); trims beyond retention. */
  save(entry: StoredAskAnswer): Promise<void>;
  /** Newest first. */
  list(limit?: number): Promise<StoredAskAnswer[]>;
}

export function createInMemoryAskHistoryStore(): AskHistoryStore {
  const rows = new Map<string, StoredAskAnswer>();
  return {
    async save(entry) {
      rows.set(entry.id, JSON.parse(JSON.stringify(entry)) as StoredAskAnswer);
      // Mirror the sqlite adapter's retention trim: keep only the newest
      // ASK_HISTORY_RETENTION rows.
      const ordered = [...rows.values()].sort((a, b) => b.createdAt - a.createdAt);
      for (const stale of ordered.slice(ASK_HISTORY_RETENTION)) {
        rows.delete(stale.id);
      }
    },
    async list(limit) {
      return [...rows.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit ?? Number.POSITIVE_INFINITY)
        .map((row) => JSON.parse(JSON.stringify(row)) as StoredAskAnswer);
    },
  };
}

export class SqliteAskHistoryStore implements AskHistoryStore {
  constructor(private readonly database?: IDatabase) {}

  private async db(): Promise<IDatabase> {
    return this.database ?? (await getDB());
  }

  async save(entry: StoredAskAnswer): Promise<void> {
    const database = await this.db();
    await runWithDbRetry(() =>
      database.execute(
        "INSERT OR REPLACE INTO book_skill_ask_history (id, question, answer_json, created_at) VALUES (?, ?, ?, ?)",
        [entry.id, entry.question, JSON.stringify(entry.answer), entry.createdAt],
      ),
    );
    await runWithDbRetry(() =>
      database.execute(
        `DELETE FROM book_skill_ask_history WHERE id NOT IN (
           SELECT id FROM book_skill_ask_history ORDER BY created_at DESC, id DESC LIMIT ?
         )`,
        [ASK_HISTORY_RETENTION],
      ),
    );
  }

  async list(limit?: number): Promise<StoredAskAnswer[]> {
    const database = await this.db();
    const rows = await database.select<Record<string, unknown>>(
      `SELECT id, question, answer_json, created_at
       FROM book_skill_ask_history
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [limit ?? -1],
    );
    return rows.map((row) => ({
      id: String(row.id),
      question: String(row.question),
      createdAt: Number(row.created_at),
      answer: JSON.parse(String(row.answer_json)) as CrossBookAnswer,
    }));
  }
}

export function createSqliteAskHistoryStore(database?: IDatabase): AskHistoryStore {
  return new SqliteAskHistoryStore(database);
}
