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

- Teaching tests: `NOT_RUN` at ledger creation.
- Existing gates (quality / NSIS / Read-Box / TKG): run unchanged; authoritative result on GitHub CI.
- Real DeepSeek E2E: `NOT_RUN` (teaching tested against a deterministic fake; no real key calls).

## Blockers / partial truth

- None currently. Deferred by design: free-text teach-back with LLM grading (the MCQ path is the deterministic MVP), session resume across app restarts beyond the persisted row, UI.

## Next exact action

Implement teaching types/prompts/engine/storage + app trigger + tests; full verification; commit, push, PR, CI, independent acceptance, ordinary merge.

## Recovery protocol

After compaction/restart: reread the authoritative handoff, this ledger, and the PR-003 audit doc; inspect git status/branch/HEAD/remotes; reconcile with GitHub PR/CI state; fail closed on disagreement. Never infer a PASS or COMPLETE state from missing context.
