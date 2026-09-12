// Cross-book ask persistence (PR-020 — recorded PR-011/017 candidate "answer
// persistence/history"). A shelf ask costs several LLM calls and produces a
// citation-resolved claim report; losing it to a panel reset wastes both. The
// full CrossBookAnswer (synthesis + report) is stored as one JSON row, newest
// first, trimmed to the retention cap. Display needs only the stored answer —
// reopening a past ask re-renders the exact resolved/unresolved badges.

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

/** Rows persisted before the PR-029 rename carry `verified` on each claim;
 * normalize on read so every consumer can rely on `referencesResolved`. */
function normalizeStoredAnswer(answer: CrossBookAnswer): CrossBookAnswer {
  const report = answer?.report;
  if (!report || !Array.isArray(report.claims)) return answer;
  return {
    ...answer,
    report: {
      ...report,
      claims: report.claims.map((claim) => {
        const legacy = claim as { verified?: unknown };
        const current = claim as { referencesResolved?: unknown };
        return {
          ...claim,
          referencesResolved:
            typeof current.referencesResolved === "boolean"
              ? current.referencesResolved
              : legacy.verified === true,
        };
      }),
    },
  };
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
        .map((row) =>
          JSON.parse(JSON.stringify(row)) as StoredAskAnswer
        )
        .map((row) => ({ ...row, answer: normalizeStoredAnswer(row.answer) }));
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
    return rows.map((row) => {
      const entry: StoredAskAnswer = {
        id: String(row.id),
        question: String(row.question),
        createdAt: Number(row.created_at),
        answer: JSON.parse(String(row.answer_json)) as CrossBookAnswer,
      };
      return { ...entry, answer: normalizeStoredAnswer(entry.answer) };
    });
  }
}

export function createSqliteAskHistoryStore(database?: IDatabase): AskHistoryStore {
  return new SqliteAskHistoryStore(database);
}
