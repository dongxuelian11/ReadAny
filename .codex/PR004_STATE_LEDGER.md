# PR-004 Learner Core State Ledger

Last updated: 2026-08-30 (Asia/Shanghai)

## Immutable task authority

- Objective: implement the Track D deterministic Learner Core as a pure TypeScript module `@readany/core/learner`, per the PR-003 audit verdicts: append-only Evidence events, per-concept BKT mastery (ported, OpenTutor-parameterized, SkillCoco orchestration invariants), and FSRS review scheduling via the audit-approved dependency `ts-fsrs@5.4.1`. Storage behind interfaces with injected clock; NO UI, NO LLM calls, NO wiring into existing panels in this PR.
- Authoritative handoff: `AI_PERSONAL_LEARNING_OS_GLM53_MASTER_HANDOFF_20260830.md` (user-provided external file; machine-local path intentionally omitted).
- Governing decision document: `docs/integrations/LEARNER_CORE_OSS_AUDIT_PR003.md` (merged via PR #4).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr004-learner-core`, created normally from exact `origin/main` `81d7c35e00d57d6a38a3abca6348fc72ae6f7a77` (merge commit of PR #4).
- Porting spec: skillcoco `skillcoco-core/src/bkt.rs` (pinned `805c6c784db5ad60a02d450dc1711f1b3e1381c6` under gitignored `.audit/`) with its tests; OpenTutor guess/slip table and CAT/FSRS mappings per the audit doc; pyBKT recurrences as the math reference.
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No UI components, no Reader/panel changes, no i18n changes (UI wiring is a later PR under the apple-design / emil-design-eng gate).
- No misconceptions/confusion-pair logic, no transfer assessment, no placement CAT (later PRs; types may be reserved but no logic).
- No LLM calls anywhere in the deterministic core; no network calls.
- No changes to the PR-001 Read-Box slice, the PR-002 Book Skill slice, or the Rust/Tauri layer.
- No new dependencies beyond the audit-approved `ts-fsrs@5.4.1` exact pin.
- No cleanup of unrelated upstream lint or CLI debt.

## Dependency and license truth

- `ts-fsrs` added to `packages/core` dependencies at the EXACT pin `5.4.1` (no caret), per the PR-003 audit REUSE_AS_DEPENDENCY verdict. License note: MIT — verified at root and packages/fsrs LICENSE in the audited pin `1303836d36f2c4e3a8a01a44edfee5c89147a990`; zero runtime dependencies. Determinism posture: `enable_fuzz` stays disabled (default) for the Authority core; storage schemas must not use the deprecated `elapsed_days`/`last_elapsed_days` fields pending ts-fsrs v6.
- `INTEGRATIONS.lock.json` ts-fsrs entry updated AUDITED → ADOPTED with the adopted version recorded.

## Implementation shape (audit-driven)

- `types.ts` — handoff §9 schemas adapted: `EvidenceEvent` (conceptId, source, taskType, questionType, difficulty, result, confidence, timestamp, sourceLocator), `ConceptMastery` (conceptId, mastery, confidence, retention, transfer, lastVerified, nextReview, status), store interfaces (append-only evidence ledger; mastery store; review card/log store), `LearnerClock` (injected clock, SkillCoco pattern).
- `bkt.ts` — canonical 4-parameter BKT ported from `bkt.rs` (`updateMastery` semantics identical: Bayes posterior + learn step; documented nuance: learning step also runs after incorrect answers, matching the upstream doctest), `MASTERY_THRESHOLD = 0.7`, OpenTutor question-type guess/slip table (mc 0.25/0.10, tf 0.50/0.10, short_answer 0.05/0.10, fill_blank 0.10/0.10, matching 0.15/0.10, select_all 0.10/0.10).
- `review.ts` — ts-fsrs wrapper: scheduler factory with fuzz disabled; concept card create/review/retrievability; epoch-millis storage serialization (no deprecated fields); correct→Rating.Good(3), incorrect→Rating.Again(1) per the OpenTutor tracker mapping recorded in the audit.
- `engine.ts` — deterministic orchestration: one evidence event → one BKT update (per-event iteration, SkillCoco invariant) + one FSRS review → updated `ConceptMastery` (mastery, confidence, retention, lastVerified, nextReview, derived status Stable/NeedsReview per handoff §11 degradation rule).
- `stores.ts` — in-memory store implementations for deterministic tests; SQLite adapter deferred to the wiring PR.
- Tests: BKT port-spec tests (from bkt.rs test set), engine integration tests (append-only ledger, per-event updates, status degradation), FSRS tests (determinism with fuzz off, golden intervals pinned from actual runs, storage round-trip).

## UI skill truth

- Not applicable: no user-facing UI or motion in this PR.

## Git and authority truth

- Base: `origin/main` `81d7c35e00d57d6a38a3abca6348fc72ae6f7a77`.
- Branch `feat/pr004-learner-core` created normally from that exact base; initial HEAD `81d7c35e00d57d6a38a3abca6348fc72ae6f7a77`.
- Product PR: `NOT_CREATED`.

## Test truth

- Learner core unit tests: `PASS` — 3 files / 30 tests (`bkt.test.ts` port-spec from skillcoco bkt.rs incl. the exact first-update value 0.6926829 and the OpenTutor guess/slip table verbatim; `review.test.ts` FSRS determinism/round-trip/golden first Good review = 3 days, stability 2.3065, difficulty 2.1181 with fuzz disabled; `engine.test.ts` end-to-end evidence→BKT→FSRS, append-only duplicate-id rejection, per-event iteration, concept isolation, confidence saturation at 15, Stable→NeedsReview decay at 90 days then recovery).
- Full core suite: `PASS` — 80 files / 626 tests (was 77/596; +3 files / +30 tests are the learner module).
- Biome on `packages/core/src/learner`: `PASS` (clean). App `tsc --noEmit`: `PASS`.
- Existing gates: quality / NSIS / Read-Box / TKG integration run unchanged; authoritative result on GitHub CI for the pushed head.
- Real DeepSeek E2E: `NOT_RUN` (no model calls in this PR).
- Golden values were pinned from actual ts-fsrs 5.4.1 runs (disclosed in-test: FSRS-6 default weights, request_retention 0.9, Good grade, long-term scheduler).

## Blockers / partial truth

- None currently. Deferred by design to later PRs: SQLite store adapters + panel wiring (with UI under apple-design / emil-design-eng), misconceptions/confusion pairs, transfer, placement CAT, LLM-observation admission gate.

## Final handoff snapshot — 2026-08-30 (pre-merge)

- Implementation complete per the PR-003 audit verdicts: `packages/core/src/learner/{types,bkt,review,engine,stores}.ts` + barrel + `./learner` export; dependency surface exactly `ts-fsrs@5.4.1` (exact pin, no caret).
- Authority boundaries honored: pure deterministic core, storage behind interfaces with injected clock, no LLM imports, no network, no UI. Evidence ledger append-only (duplicate ids rejected); BKT updated per event with question-type guess/slip; FSRS review per event (Good/Again mapping); status degradation is a pure read-time derivation; history never deleted.
- Next exact action: push, wait for exact-head blocking CI, independent acceptance, ordinary merge PR (no squash/rebase). Post-merge alignment: PR-005 scope (wiring + placement + misconceptions) with the user before code.

## Recovery protocol

After compaction/restart: reread the authoritative handoff, this ledger, and `docs/integrations/LEARNER_CORE_OSS_AUDIT_PR003.md`; inspect git status/branch/HEAD/remotes and the `.audit/` pins; reconcile with the GitHub PR/CI state; fail closed on disagreement. Never infer a PASS or COMPLETE state from missing context.
