// One-shot fixture generator (run from packages/core):
//   npx tsx scripts/capture-engine-request.ts
// Produces the REAL LearnerAtomicCommitRequest the engine builds for a first
// answer (fixed clock + fixed event id, so it is byte-reproducible). The file
// is committed and replayed through the actual Rust commit by
// learner_commit.rs::real_engine_first_answer_request_commits_to_sqlite — the
// cross-boundary check that TS-computed state lands in SQLite verbatim.
// A guard test in engine.commit.test.ts re-runs this logic and fails when the
// fixture would drift from the engine's current output.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEvidenceEventResult } from "../src/learner/engine";
import type { EvidenceEventInput, LearnerEngineDeps } from "../src/learner/engine";
import { createInMemoryLearnerStores } from "../src/learner/stores";

const NOW = new Date("2026-08-30T00:00:00.000Z");

const input: EvidenceEventInput = {
  id: "fixture-first-answer",
  conceptId: "stats/mean",
  source: "READ_BOX_QUIZ",
  taskType: "quiz",
  questionType: "mc",
  result: "correct",
  confidence: 1,
  verification: "deterministic_keyed",
  timestamp: NOW.getTime(),
  sourceLocator: { bookId: "fixture-book", chapterIndex: 0, cfi: "epubcfi(/4/2)" },
};

async function captureFirstRequest(): Promise<unknown> {
  const stores = createInMemoryLearnerStores();
  let captured: unknown = null;
  const deps: LearnerEngineDeps = {
    clock: { now: () => NOW },
    evidence: stores.evidence,
    mastery: stores.mastery,
    reviews: stores.reviews,
    completions: stores.completions,
    atomic: {
      async commit(request) {
        if (captured === null) captured = request;
        await stores.evidence.append(request.event);
        await stores.completions.record(request.event.id, request.payloadJson);
        return { outcome: "applied", mastery: null };
      },
    },
  };
  await applyEvidenceEventResult(deps, input);
  if (captured === null) throw new Error("the engine never reached the atomic commit");
  return captured;
}

async function main() {
  const request = await captureFirstRequest();
  const here = dirname(fileURLToPath(import.meta.url));
  const target = resolve(
    here,
    "../../app/src-tauri/tests/fixtures/learner_commit/engine-first-answer-request.json",
  );
  mkdirSync(dirname(target), { recursive: true });

  let existing: string | null = null;
  try {
    existing = readFileSync(target, "utf8");
  } catch {
    // first capture
  }
  const serialized = `${JSON.stringify(request, null, 2)}\n`;
  if (existing === serialized) {
    console.log("fixture unchanged:", target);
    return;
  }
  writeFileSync(target, serialized, "utf8");
  console.log("fixture written:", target);
}

void main();
