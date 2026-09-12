// WP-A (2026-09-13): the desktop atomic-commit adapter. Bridges the engine's
// LearnerAtomicCommit contract to the Rust `learner_commit` command, which
// runs the whole write set (evidence row, review log, card, mastery,
// completion record, guarded teaching-session advance) inside ONE SQLite
// transaction with compare-and-swap markers. The Rust side signals guard
// outcomes through error strings; they are mapped back to typed results here.

import type {
  LearnerAtomicCommit,
  LearnerAtomicCommitRequest,
  LearnerAtomicCommitResult,
} from "@readany/core/learner";
import { invoke } from "@tauri-apps/api/core";

function toRustRequest(request: LearnerAtomicCommitRequest): Record<string, unknown> {
  const { event, session, ...rest } = request;
  return {
    ...rest,
    event: {
      id: event.id,
      conceptId: event.conceptId,
      source: event.source,
      taskType: event.taskType,
      questionType: event.questionType ?? null,
      difficulty: event.difficulty ?? null,
      result: event.result,
      confidence: event.confidence,
      verification: event.verification ?? null,
      timestamp: event.timestamp,
      sourceLocator: event.sourceLocator
        ? {
            bookId: event.sourceLocator.bookId ?? null,
            chapterIndex: event.sourceLocator.chapterIndex ?? null,
            cfi: event.sourceLocator.cfi ?? null,
          }
        : null,
    },
    session: session
      ? {
          expected: session.expected,
          session: {
            id: session.session.id,
            goalId: session.session.goalId,
            bookId: session.session.bookId,
            status: session.session.status,
            stepsJson: JSON.stringify(session.session.steps),
            currentIndex: session.session.currentIndex,
            startedAt: session.session.startedAt,
            completedAt: session.session.completedAt ?? null,
          },
        }
      : null,
  };
}

function outcomeFromError(error: unknown): LearnerAtomicCommitResult | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("__conflict__")) return { outcome: "conflict" };
  if (message.includes("__stale__")) return { outcome: "stale" };
  if (message.includes("__sessionStale__")) return { outcome: "sessionStale" };
  return null;
}

export function createInvokeLearnerAtomicCommit(): LearnerAtomicCommit {
  return {
    async commit(request: LearnerAtomicCommitRequest): Promise<LearnerAtomicCommitResult> {
      try {
        const result = await invoke<{ outcome: string; mastery: unknown }>("learner_commit", {
          request: toRustRequest(request),
        });
        if (result.outcome === "applied") return { outcome: "applied", mastery: null };
        if (result.outcome === "alreadyApplied") {
          return { outcome: "alreadyApplied", mastery: null };
        }
        return { outcome: "stale" };
      } catch (error) {
        const mapped = outcomeFromError(error);
        if (mapped) return mapped;
        throw error;
      }
    },
  };
}
