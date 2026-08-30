# PR-008 Goal Model & Curriculum State Ledger

Last updated: 2026-08-30 (Asia/Shanghai)

## Immutable task authority

- Objective: implement the Wave-2 Goal Model backend per the PR-003 audit verdicts — free-text learning goal → structured GoalSpec (LLM co-processor, validated fail-closed), goal persistence, and the deterministic Knowledge Gap → Personal Curriculum computation over the existing chapter-scoped learner state. Backend ONLY: no UI.
- Authoritative handoff: `AI_PERSONAL_LEARNING_OS_GLM53_MASTER_HANDOFF_20260830.md` (user-provided external file; machine-local path intentionally omitted).
- Governing decision document: `docs/integrations/LEARNER_CORE_OSS_AUDIT_PR003.md` (Wave-2 verdicts: gen-mentor goal→skillgap pipeline as design, SkillCoco pack/path determinism as the model-independence pattern, LearnGraph gap taxonomy as concept).
- Role boundary (user directive 2026-08-30): this executor is backend-only; the PR-007 visual-evidence GUI session was aborted by the user and its helper files removed. UI surfacing of goals/curricula belongs to the frontend owner.
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr008-goal-model`, created normally from exact `origin/main` `1427cc85f9f9bd19dfedf9b632adf8c07c2ff7d1` (merge commit of PR #8).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Alignment record (2026-08-30)

- Scope is chapter-level (the only concept identity that exists: `readany:book:<bookId>:chapter:<index>` from PR-005/006); a concept graph is future work.
- Goal-driven learning itself is a frozen handoff decision (§2.4/§24); LLM as co-processor is frozen; no north-star change is involved, so no grill was required (§23).
- The LLM participates ONLY in (a) parsing free-text goals into structured GoalSpec drafts and (b) mapping a goal onto a book's chapter list; both outputs are validated deterministically and fail closed. Gap analysis and curriculum ordering are pure code.

## Frozen prohibited scope

- No UI, no i18n (frontend owner surfaces goals/curricula later).
- No curriculum execution/teaching loop (Agent 带读 is a later slice); this PR computes and stores plans, it does not teach.
- No changes to existing learner semantics (BKT/FSRS/evidence/placement untouched except adding one pure read-only query if needed).
- No new dependencies; LLM calls reuse the existing unified-gateway client shape.
- No changes to the Rust/Tauri layer, CI workflows, or the Read-Box/Book-Skill slices.
- No cleanup of unrelated upstream lint or CLI debt.

## Design decisions (2026-08-30)

- GoalSpec (handoff §10, chapter-scoped): {goalId, bookId, goalText, targetCapabilities: string[], targetDepth per chapter: familiar|working|mastery, requiredChapterIds: string[], milestones: string[], completionCriteria: string[], createdAt, active}. One ACTIVE goal per book (a new activation supersedes the previous one; history retained).
- Goal parsing (gen-mentor refiner+mapper pattern): ONE LLM call receives the goal text + the book's chapter list (ids + titles) and returns {restatedGoal, targetCapabilities[], requiredChapterIds[], milestones[], completionCriteria[]}; validation: every requiredChapterId must exist in the book list (invalid ids dropped with warning, fail-closed if none survive), strings non-empty, counts bounded.
- Knowledge Gap (LearnGraph taxonomy, deterministic): for each required chapter, compare learner mastery row vs target depth — unseen/learning below target → gap of kind "missing"|"partial"; needs_review → "lapsed"; mastery at/above target → "satisfied". Learner rows with evidenceCount 0 and no lastVerified count as unseen even if a stale placement estimate exists (placement estimates are estimates, not evidence).
- Personal Curriculum (deterministic): ordered steps from the gap — book chapter order preserved; action learn (missing/partial) or review (lapsed); each step carries the target depth and a one-line reason. No reordering intelligence in this PR (book order is the defensible default until a prerequisite graph exists — documented limitation).
- Storage: `learner_goals` table (JSON columns for the structured fields, mirroring the placement-session pattern); GoalStore interface + in-memory + SQLite adapters; active-goal supersession on save-as-active.
- LLM client: structural `complete(system, user)` interface (same shape as book-skill/placement clients).

## UI skill truth

- Not applicable: no user-facing UI or motion in this PR.

## Git and authority truth

- Base: `origin/main` `1427cc85f9f9bd19dfedf9b632adf8c07c2ff7d1`.
- Branch `feat/pr008-goal-model` created normally from that exact base; initial HEAD `1427cc85f9f9bd19dfedf9b632adf8c07c2ff7d1`.
- Product PR: `NOT_CREATED`.

## Test truth

- Goal/curriculum tests: `NOT_RUN` at ledger creation.
- Existing gates (quality / NSIS / Read-Box / TKG): run unchanged; authoritative result on GitHub CI.
- Real DeepSeek E2E: `NOT_RUN` (parsing tested against a deterministic fake; no real key calls).

## Blockers / partial truth

- None currently. Deferred by design: goal→multiple books, prerequisite-aware reordering, curriculum execution/teaching, UI.

## Next exact action

Implement goal types + parsing + storage + gap/curriculum + tests; full verification; commit, push, PR, CI, independent acceptance, ordinary merge.

## Recovery protocol

After compaction/restart: reread the authoritative handoff, this ledger, and the PR-003 audit doc; inspect git status/branch/HEAD/remotes; reconcile with GitHub PR/CI state; fail closed on disagreement. Never infer a PASS or COMPLETE state from missing context.
