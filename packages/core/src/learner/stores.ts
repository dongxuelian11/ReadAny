// In-memory learner stores for deterministic tests. The append-only rule is
// enforced here exactly as a SQLite adapter must enforce it: duplicate
// evidence ids are rejected, never upserted; nothing is deleted. (Review-log
// rows are keyed by insertion order; a durable adapter should additionally
// key them by concept+review to make replays idempotent.) The SQLite adapter
// itself lands with the wiring PR.

import type { PlacementSession, PlacementStore } from "./placement";
import type { TeachingSession } from "./teaching";
import type { TeachingStore } from "./teaching-store";
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
  placements: PlacementStore;
  teachings: TeachingStore;
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
    async listCardsDueBefore(timestamp, limit) {
      return [...cards.values()]
        .filter((card) => card.due <= timestamp)
        .sort((a, b) => a.due - b.due)
        .slice(0, limit ?? Number.POSITIVE_INFINITY)
        .map((card) => ({ ...card }));
    },
  };

  const sessions = new Map<string, PlacementSession>();
  const placements: PlacementStore = {
    async get(id) {
      const session = sessions.get(id);
      return session ? (JSON.parse(JSON.stringify(session)) as PlacementSession) : null;
    },
    async put(session) {
      sessions.set(session.id, JSON.parse(JSON.stringify(session)) as PlacementSession);
    },
    async getActive() {
      const active = [...sessions.values()]
        .filter((session) => session.status === "active")
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      return active ? (JSON.parse(JSON.stringify(active)) as PlacementSession) : null;
    },
  };

  const teachingSessions = new Map<string, TeachingSession>();
  const teachings: TeachingStore = {
    async get(id) {
      const session = teachingSessions.get(id);
      return session ? (JSON.parse(JSON.stringify(session)) as TeachingSession) : null;
    },
    async put(session) {
      teachingSessions.set(session.id, JSON.parse(JSON.stringify(session)) as TeachingSession);
    },
    async getActive() {
      const active = [...teachingSessions.values()]
        .filter((session) => session.status === "active")
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      return active ? (JSON.parse(JSON.stringify(active)) as TeachingSession) : null;
    },
  };

  return {
    evidence,
    mastery,
    reviews,
    placements,
    teachings,
    events: () => events.map((event) => ({ ...event })),
    logs: () => logs.map((entry) => ({ ...entry })),
  };
}
