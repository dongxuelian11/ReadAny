# PR-003 Learner Core OSS Audit State Ledger

Last updated: 2026-08-30 (Asia/Shanghai)

## Immutable task authority

- Objective: execute the master-handoff §8 mandated source-level Build-vs-Reuse audit of the nine listed OSS references BEFORE any Learner Authority (Track D) implementation, and record per-component verdicts (Evidence, Mastery/BKT, Retention/FSRS, Misconception, Transfer, placement) in a reviewable decision document.
- Authoritative handoff: `AI_PERSONAL_LEARNING_OS_GLM53_MASTER_HANDOFF_20260830.md` (user-provided external file; machine-local path intentionally omitted).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `docs/pr003-learner-core-audit`, created normally from exact `origin/main` `3fde5704c3af606cbdd06203ddb6e1e891268d28` (merge commit of PR #3 / PR-002).
- This PR is a research/decision PR: NO product code, NO runtime dependency changes, NO Learner Authority implementation. Implementation is a later PR gated on this document.
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No implementation of Learner Model / Evidence / Mastery / BKT / FSRS / Misconception / Transfer code.
- No new runtime or dev dependencies added to any package.
- No changes to PR-001 (Read-Box slice) or PR-002 (Book Skill slice) behavior.
- No code copying from any audited repo (several have no license or restrictive terms; verdicts are decisions, not ports).
- No cleanup of unrelated upstream lint or CLI debt.

## Audit pins (resolved live 2026-08-30 via GitHub API, cloned pinned detached under gitignored `.audit/`)

- OpenTutor: `zijinz456/OpenTutor` @ `03070426f50fa82d2d1b49859996d77fe0300a05` — MIT, Python, active (pushed 2026-08-27).
- SkillCoco: `skillcoco/skillcoco` @ `805c6c784db5ad60a02d450dc1711f1b3e1381c6` — MIT, Rust, active (pushed 2026-08-10).
- pyBKT: `CAHLR/pyBKT` @ `06fc180ae72c117458acc527f8ec90cc8e0581c1` — MIT, Python with C extensions, default branch `master`, active (pushed 2026-08-05).
- ts-fsrs: `open-spaced-repetition/ts-fsrs` @ `1303836d36f2c4e3a8a01a44edfee5c89147a990` — MIT, TypeScript, active (pushed 2026-08-28).
- LearnGraph: `fenago/LearnGraph` @ `8d506fb77919f311e9b41d0191ceb1de283a4500` — NO LICENSE FILE (GitHub license: null), TypeScript, stale since 2025-12-14. Reference-only; no code copying.
- Quick-pass (no clone; GitHub API/raw inspection): GeminiLight/gen-mentor (CC0-1.0, Python, active), THU-MAIC/OpenMAIC (MIT, TypeScript, active, very large), rsml/tutor (GPL-3.0, TypeScript, 78MB), legostin/learn-almost-anything (NO LICENSE, TypeScript).

## UI skill truth

- Not applicable: this PR changes no user-facing UI and no motion.

## Git and authority truth

- Base: `origin/main` `3fde5704c3af606cbdd06203ddb6e1e891268d28`.
- Branch `docs/pr003-learner-core-audit` created normally from that exact base; initial HEAD `3fde5704c3af606cbdd06203ddb6e1e891268d28`.
- Product PR: https://github.com/dongxuelian11/ReadAny/pull/4 (created 2026-08-30, base `origin/main` `3fde5704c3af606cbdd06203ddb6e1e891268d28`).

## Test truth

- Product code changes: NONE. Existing gates (quality / NSIS / Read-Box integration / TKG integration) run unchanged on the pushed head and are expected to pass.
- Deep audits: `COMPLETE` (2026-08-30) — three parallel source-level audit passes over the five pinned clones (OpenTutor + SkillCoco; pyBKT + ts-fsrs; LearnGraph) plus quick-passes over gen-mentor / OpenMAIC / rsml-tutor / learn-almost-anything via live GitHub API and raw file reads.
- Decision document: `COMPLETE` — `docs/integrations/LEARNER_CORE_OSS_AUDIT_PR003.md` records per-component verdicts: Evidence ADOPT_DESIGN (OpenTutor taxonomy + SkillCoco ledger); BKT Mastery PORT_ALGORITHM (2-state forward filter, ~50 lines TS; OpenTutor question-type parameterization; SkillCoco orchestration invariants) with optional pinned pyBKT offline-fitting sidecar; Retention REUSE_AS_DEPENDENCY (`ts-fsrs@5.4.1` exact pin, MIT, zero runtime deps, the single new dependency Track D needs); Misconceptions ADOPT_DESIGN (OpenTutor confusion-pair + diagnostic-twin loops, LearnGraph entity shape); Transfer BUILD_FRESH (thin); Placement ADOPT_DESIGN + rewrite estimator (OpenTutor CAT pretest); Wave-2 Goal→Curriculum ADOPT_DESIGN (gen-mentor pipeline + SkillCoco pack format + LearnGraph taxonomy).
- License hazards recorded: LearnGraph and learn-almost-anything are UNLICENSED (no code copying, design concepts only); rsml/tutor is GPL-3.0 (reference-only posture despite family compatibility).
- Real DeepSeek E2E: `NOT_RUN` (no model calls in this PR).
- CI on the pushed head: `PENDING` at ledger update; authoritative result on GitHub.

## Blockers / partial truth

- None. Implementation of the Learner Authority is a LATER PR gated on this document; no code, no dependencies, and no schemas change here.

## Next exact action

Push the housekeeping commit, wait for exact-head blocking CI on GitHub (authoritative), obtain independent acceptance, then ordinary merge PR #4 (no squash/rebase). After merge: align PR-004 (the Track D Learner Authority implementation PR) scope with the user against the audit verdicts before writing code.

## Recovery protocol

After compaction/restart: reread the authoritative handoff, this ledger, and the audit doc; inspect git status/branch/HEAD/remotes and the pinned checkouts under `.audit/`; reconcile with the GitHub PR/CI state; fail closed on disagreement. Never infer a PASS or COMPLETE state from missing context.
