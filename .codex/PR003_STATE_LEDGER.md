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
- Product PR: `NOT_CREATED`.

## Test truth

- Product code changes: NONE planned; existing gates (quality / NSIS / Read-Box integration / TKG integration) expected to pass unchanged on the pushed head.
- Deep audits: `NOT_RUN` at ledger creation; results recorded in this ledger as they complete.
- Real DeepSeek E2E: `NOT_RUN` (no model calls in this PR).

## Blockers / partial truth

- LearnGraph and learn-almost-anything have no license file — recorded as reference-only regardless of audit content.
- rsml/tutor is GPL-3.0; the ReadAny fork is GPL-3.0-or-later so license-compatible in principle, but the default posture stays reference-first (decision recorded in the audit doc).

## Next exact action

Dispatch parallel source-level audit agents for the five pinned clones plus the quick-pass set; synthesize per-component Build-vs-Reuse verdicts into `docs/integrations/LEARNER_CORE_OSS_AUDIT_PR003.md`; update the `INTEGRATIONS.lock.json` watchlist entries with pins/licenses/verdicts.

## Recovery protocol

After compaction/restart: reread the authoritative handoff, this ledger, and the audit doc; inspect git status/branch/HEAD/remotes and the pinned checkouts under `.audit/`; reconcile with the GitHub PR/CI state; fail closed on disagreement. Never infer a PASS or COMPLETE state from missing context.
