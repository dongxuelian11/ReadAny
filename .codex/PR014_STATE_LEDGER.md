# PR-014 Evidence Admission Authority (Graded Trust) State Ledger

Last updated: 2026-09-05 (Asia/Shanghai)

## Immutable task authority

- Objective: close review item #3 — LLM-generated/LLM-judged evidence can no
  longer silently modify formal Mastery at confidence=1 full BKT weight.
  Graded trust (user decision 2026-09-05): deterministic-keyed evidence medium
  trust, LLM-judged evidence low trust, explicit user confirmation full trust;
  the designed-but-unbuilt `LLM_OBSERVATION` admission gate is now enforced.
- Governing decision document: `docs/ROADMAP_PR012_PLUS.md` (review verdicts +
  locked decisions 2026-09-05).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr014-evidence-admission`, created normally from exact `origin/main` `912282a3` (merge commit of PR #14).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No UI: the user-confirmation affordance (upgrade an llm_judged answer by
  vouching for it) lands with the Learning Workspace (PR-016); the core
  records `user_confirmed` and carries it at full weight already.
- No BKT parameter changes (pKnow/pLearn/guess/slip table untouched), no FSRS
  changes, no concept identity (PR-015), no cross-book changes (PR-017).
- The `confidence` FIELD semantics stay "recorded for future weighting"
  (types.ts); admission uses the new `verification` axis instead.

## Design decisions (2026-09-05)

- `EvidenceVerification` axis on EvidenceEvent: `user_confirmed` |
  `deterministic_keyed` | `llm_judged` | `placement_inferred`; optional +
  additive (`verification` TEXT column, try/catch ALTER migration following
  the repo's established pattern; absent = legacy unclassified evidence).
- Admission weights (probability the evidence is genuine):
  user_confirmed 1.0, deterministic_keyed 0.6, llm_judged 0.4,
  placement_inferred 0.5. Absent verification → 1.0 (backcompat: all legacy
  rows and all engine tests with bare inputs keep the exact ported math).
  Producers now stamp verification explicitly: quiz → `llm_judged`
  (LLM-generated question, LLM-judged free-form answer), teaching MCQ →
  `deterministic_keyed` (code-graded against an LLM-authored key), placement
  → `placement_inferred`.
- Posterior mixture: `mastery = λ·BKT(prior, result, questionType) + (1−λ)·prior`
  — λ is the admission probability; λ=1 reproduces the ported math exactly.
  FSRS scheduling still runs on the observed result (the attempt happened);
  only the knowledge estimate is trust-weighted.
- Gate: `admissionWeight` throws `EvidenceNotAdmittedError` for
  `source: "LLM_OBSERVATION"` without an explicit verification, and the check
  runs BEFORE the ledger append so a rejected candidate leaves no row.
- Placement honesty fix (review #3 tail): a tested concept's mastery row wrote
  `confidence: 1` with exactly one real evidence event — now `1/15` matching
  the evidence-backed saturation formula; untested inferred rows stay 0.
- Storage: `verification` added to the evidence INSERT/SELECT round-trip
  (null → undefined mapping); in-memory stores carry it automatically.

## UI skill truth

- Not applicable: no user-facing UI in this PR.

## Git and authority truth

- Base: `origin/main` `912282a3`.
- Branch `feat/pr014-evidence-admission` created normally from that exact base; initial HEAD `912282a3`.
- Product PR: https://github.com/dongxuelian11/ReadAny/pull/15 (base origin/main 912282a3).

## Test truth

- Engine (+6): llm_judged 0.4 mixture (exact math + direction bounds),
  deterministic_keyed 0.6 mixture, user_confirmed full step, legacy
  absent-verification backcompat, LLM_OBSERVATION gate rejection (no ledger
  row) + admitted variant passes. evidence-mapping (+assert): quiz stamps
  `llm_judged`. placement-engine (updated): tested-row confidence 1/15.
  sqlite-stores (+1): verification column binding + null→undefined round-trip.
- Full core suite: `PASS` — 92 files / 714 tests (was 92/708; +6 tests).
- App tsc + vite production build: `PASS` (37.4s).
- Biome on touched files: `PASS` after `biome check --write`.
- Real LLM quiz-judging behaviour comparison E2E: `NOT_RUN` (weights are
  deterministic and covered by exact-math tests).

## Blockers / partial truth

- None currently.

## Final handoff snapshot — 2026-09-05 (pre-merge)

- Implementation complete; local gates green: core 92/714 PASS, app build
  PASS. Authoritative result is exact-head GitHub CI.
- Next exact action: push, wait for exact-head blocking CI (four required
  checks), then ordinary merge PR #15 (no squash/rebase). Post-merge: PR-015
  concept identity seam per `docs/ROADMAP_PR012_PLUS.md`; the user-confirmation
  UI affordance rides with PR-016.
