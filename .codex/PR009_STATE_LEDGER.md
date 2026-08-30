# PR-009 Teaching Engine State Ledger

Last updated: 2026-08-30 (Asia/Shanghai)

## Immutable task authority

- Objective: implement the golden-path Agent 带读 backend — a deterministic teaching-session engine over the Personal Curriculum: per step, the LLM writes a chapter-grounded explanation plus ONE comprehension MCQ (content co-processor only); the MCQ is graded deterministically; the answer flows through applyEvidenceEvent so teaching genuinely moves BKT mastery and FSRS scheduling. Backend ONLY: no UI.
- Authoritative handoff: `AI_PERSONAL_LEARNING_OS_GLM53_MASTER_HANDOFF_20260830.md` (user-provided external file; machine-local path intentionally omitted).
- Role boundary (user directive 2026-08-30): backend-only. UI surfacing of teaching sessions belongs to the frontend owner.
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr009-teaching-engine`, created normally from exact `origin/main` `34f9596035cbab5518217d65d4e17b7a78fc01da` (merge commit of PR #9).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No UI, no i18n (frontend owner renders sessions later).
- No autonomous/pushy teaching: sessions are user-initiated, one step delivered on demand (handoff §2.7 — the agent knows when to stay quiet).
- No web research, no multi-book teaching, no cross-book routing (separate slice).
- No changes to BKT/FSRS/evidence/placement/goal semantics (teaching consumes applyEvidenceEvent as built).
- No new dependencies; LLM calls reuse the structural complete(system, user) client shape.
- No changes to the Rust/Tauri layer, CI workflows, or the Read-Box/Book-Skill slices.

## Design decisions (2026-08-30)

- Grounding: the teaching prompt receives the canonical ReadAny chapter text (capped, default 12000 chars) supplied by a caller-provided ChapterTextProvider; every claim the model writes is grounded in that text, and the model is instructed to answer only from it. The chapter text itself is NEVER copied into the persisted teaching output (extraction-not-summary rule).
- Session model: TeachingSession {id, goalId, bookId, status active|completed|abandoned, steps[] (from a PersonalCurriculum), currentIndex, startedAt, completedAt}. One ACTIVE session per book (supersession mirrors placement).
- Step lifecycle: deliverCurrentStep (LLM: explanation 120-350 words, 2-5 key points, at most one worked example, ONE 4-option MCQ with exactly one correct option and misconception distractors; validated fail-closed, one retry, then the step fails honestly) → answerCurrentStep (deterministic grade: selected === correctIndex; the answer is recorded via applyEvidenceEvent — source TEACHING, taskType quiz, questionType mc, conceptId from the curriculum step — so BKT and FSRS update through the exact PR-004/005 path) → currentIndex advances; completed when steps are exhausted. Re-delivering an answered step is refused (fail-closed).
- Evidence source enum: "TEACHING" added to EvidenceSource (additive).
- Storage: learner_teaching_sessions table (steps JSON columns, mirroring placement sessions); TeachingStore interface + in-memory + SQLite adapters.
- Curriculum re-runs: a session pins its steps at start; later curriculum rebuilds do not mutate running sessions (documented).

## UI skill truth

- Not applicable: no user-facing UI or motion in this PR.

## Git and authority truth

- Base: `origin/main` `34f9596035cbab5518217d65d4e17b7a78fc01da`.
- Branch `feat/pr009-teaching-engine` created normally from that exact base; initial HEAD `34f9596035cbab5518217d65d4e17b7a78fc01da`.
- Product PR: `NOT_CREATED`.

## Test truth

- Teaching tests: `PASS` — 1 new file / 7 tests (grounded prompt with review variant + text cap; fail-closed validation; retry-once-then-honest-step-failure via an always-broken fake; session start/supersession/empty-curriculum refusal; idempotent delivery + deterministic grading + evidence path verification (TEACHING source, mc question type, BKT mastery row, FSRS card) + fail-closed guards + session completion; completed-session refusal; learner-state snapshot helper). Learner module total: 11 test files / 86 tests.
- Full core suite: `PASS` — 87 files / 675 tests (was 86/668; +1 file / +7 tests).
- Core tsc: `PASS`. App tsc: `PASS`. Biome (learner module + app learner adapters): `PASS` (clean).
- Existing gates (quality / NSIS / Read-Box / TKG): run unchanged; authoritative result on GitHub CI.
- Real DeepSeek E2E: `NOT_RUN` (teaching tested against a deterministic fake; no real key calls).

## Blockers / partial truth

- None currently. Deferred by design: free-text teach-back with LLM grading (MCQ path is the deterministic MVP), teaching UI (frontend owner), cross-book teaching, web-research enrichment.

## Final handoff snapshot — 2026-08-30 (pre-merge)

- Implementation complete: `teaching.ts` (prompt/validation/evidence mapping), `teaching-engine.ts` (session lifecycle: start with supersession, idempotent delivery, deterministic grading through applyEvidenceEvent, fail-closed guards), `teaching-store.ts` (interface), in-memory + SQLite adapters, `learner_teaching_sessions` table, EvidenceSource extended with "TEACHING", app `teaching-trigger.ts` (canonical chapter text via fallback extraction, unified-gateway client).
- Incidents during this slice, recorded honestly: a careless node-string patch cross-wired the in-memory placement/teaching getActive implementations (caught immediately by placement-engine.test — the deterministic test layer did its job); fixed by hand-repairing stores.ts. One missing `teachings` field in the createSqliteLearnerStores factory was caught by app tsc.
- Next exact action: push, wait for exact-head blocking CI, independent acceptance, ordinary merge (no squash/rebase). Post-merge: teaching UI belongs to the frontend owner; remaining backend candidates are cross-book routing (Track B continuation) and multi-book goals once a concept graph exists.

## Recovery protocol

After compaction/restart: reread the authoritative handoff, this ledger, and the PR-003 audit doc; inspect git status/branch/HEAD/remotes; reconcile with GitHub PR/CI state; fail closed on disagreement. Never infer a PASS or COMPLETE state from missing context.
