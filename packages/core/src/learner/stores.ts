// In-memory learner stores for deterministic tests. The append-only rule is
// enforced here exactly as a SQLite adapter must enforce it: duplicate
// evidence ids are rejected, never upserted; nothing is deleted. (Review-log
// rows are keyed by insertion order; a durable adapter should additionally
// key them by concept+review to make replays idempotent.) The SQLite adapter
// itself lands with the wiring PR.

import type {
  ConceptMastery,
  EvidenceEvent,
  LearnerClock,
  LearnerEvidenceStore,
  LearnerMasteryStore,
  LearnerReviewCardData,
  LearnerReviewLogEntry,
  LearnerReviewStore,
} from "./types";

export class DuplicateEvidenceIdError extends Error {
  constructor(id: string) {
    super(`Evidence event id already exists: ${id}`);
    this.name = "DuplicateEvidenceIdError";
  }
}

export interface InMemoryLearnerStores {
  evidence: LearnerEvidenceStore;
  mastery: LearnerMasteryStore;
  reviews: LearnerReviewStore;
  /** Test/inspection surface: current ledger rows in insertion order. */
  events(): EvidenceEvent[];
  logs(): LearnerReviewLogEntry[];
}

export function createInMemoryLearnerStores(_clock?: LearnerClock): InMemoryLearnerStores {
  const events: EvidenceEvent[] = [];
  const seenIds = new Set<string>();
  const masteryRows = new Map<string, ConceptMastery>();
  const cards = new Map<string, LearnerReviewCardData>();
  const logs: LearnerReviewLogEntry[] = [];

  const evidence: LearnerEvidenceStore = {
    async append(event) {
      if (seenIds.has(event.id)) throw new DuplicateEvidenceIdError(event.id);
      seenIds.add(event.id);
      events.push({ ...event });
    },
    async listByConcept(conceptId) {
      return events
        .filter((event) => event.conceptId === conceptId)
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((event) => ({ ...event }));
    },
    async countByConcept(conceptId) {
      return events.filter((event) => event.conceptId === conceptId).length;
    },
  };

  const mastery: LearnerMasteryStore = {
    async get(conceptId) {
      const row = masteryRows.get(conceptId);
      return row ? { ...row } : null;
    },
    async put(row) {
      masteryRows.set(row.conceptId, { ...row });
    },
  };

  const reviews: LearnerReviewStore = {
    async getCard(conceptId) {
      const card = cards.get(conceptId);
      return card ? { ...card } : null;
    },
    async putCard(card) {
      cards.set(card.conceptId, { ...card });
    },
    async appendLog(entry) {
      logs.push({ ...entry });
    },
  };

  return {
    evidence,
    mastery,
    reviews,
    events: () => events.map((event) => ({ ...event })),
    logs: () => logs.map((entry) => ({ ...entry })),
  };
}
