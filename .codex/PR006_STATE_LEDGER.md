# PR-006 Placement CAT State Ledger

Last updated: 2026-08-30 (Asia/Shanghai)

## Immutable task authority

- Objective: implement the golden-path 摸底 (placement) as a backend slice — the deterministic CAT engine ported from the audited OpenTutor `cat_pretest.py` (pinned `0307042`), diagnostic item generation with the LLM as content co-processor only (unified gateway, DeepSeek-first), placement session persistence, finalize with the audited overwrite guard, and the due-review query helper. NO placement UI (PR-007 under the apple-design / emil-design-eng gate).
- Authoritative handoff: `AI_PERSONAL_LEARNING_OS_GLM53_MASTER_HANDOFF_20260830.md` (user-provided external file; machine-local path intentionally omitted).
- Governing decision document: `docs/integrations/LEARNER_CORE_OSS_AUDIT_PR003.md` (Placement verdict: ADOPT_DESIGN + rewrite the estimator).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr006-placement-cat`, created normally from exact `origin/main` `93e26f91f5ccae8075907a2481115488a653bd27` (merge commit of PR #6).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No placement UI, no i18n (PR-007 under the UI-skill gate).
- No misconception/confusion-pair logic, no transfer assessment, no Goal Model.
- No prerequisite-edge inference in finalize (we have no edge model yet — the audited OpenTutor design infers untested concepts from theta-vs-difficulty only in our port; the prerequisite upward/downward inference hook is documented as deferred).
- No LLM calls inside the deterministic engine (generation is a caller-supplied client dependency; grading, selection, theta, stop rules, and finalize are pure).
- No changes to the PR-001/PR-002 slices' behavior, the Rust/Tauri layer, or CI workflows (beyond none needed).
- No new dependencies (LLM calls reuse the existing unified gateway client shape from book-skill's factory).
- No cleanup of unrelated upstream lint or CLI debt.

## Design decisions (2026-08-30)

- CAT port (faithful, from `cat_pretest.py`): theta on a 0–1 scale starting at 0.5; SE = binomial sqrt(p(1-p)/n) with p clamped [0.01, 0.99] and 1.0 before 2 responses; stop rules MIN_ITEMS=5 / MAX_ITEMS=20 / SE_THRESHOLD=0.15; item selection = untested item with difficulty closest to theta; ability update step 0.3/sqrt(n) with the audited +0.1 pull-toward/0.2 drift branches clamped to [0,1]; difficulty from Bloom via min(max((bloom-1)/5, 0.1), 0.9).
- Finalize (faithful): tested concepts — correct → min(0.4 + theta*0.4, 0.85), incorrect → max(theta*0.3, 0.05); untested inference — theta >= difficulty → min(0.3 + (theta-difficulty)*0.5, 0.7), else max(0.1, theta*0.4). Overwrite guard, our equivalent of OpenTutor's `practice_count == 0`: concepts with existing evidence (evidenceCount > 0) keep their real practice data; only unseen concepts (no evidence row AND no mastery row) receive placement estimates. Placement mastery is an estimate, not an assertion — written rows carry lastVerified (so deriveMasteryStatus no longer reports them unseen) and history is never deleted.
- Evidence honesty: finalize appends ledger events ONLY for concepts the learner actually answered (source PLACEMENT, taskType placement, deterministic id `sessionId:itemId` for idempotent re-finalize). Inferred (untested) concepts get mastery rows but NO synthetic evidence events. Placement does NOT route through applyEvidenceEvent (no BKT re-estimation on top of the theta estimate) and does NOT create FSRS cards (reviews start with real practice evidence).
- deriveMasteryStatus adjustment: "unseen" now requires evidenceCount === 0 AND lastVerified === null (placement-written rows have lastVerified set and derive learning/stable from mastery; the system honestly reports unseen only when it knows nothing).
- Item generation: one diagnostic item per target concept, layer assigned deterministically (concept index % 3 → 1=recall / 2=application / 3=trap, Bloom 2/3/5 → difficulty via the audited formula) so the pool covers the difficulty range for the CAT selector; the LLM writes only the content (prompt in the chapter-title language, 4 options, exactly one correct, distractors as plausible misconceptions, explanation). Deterministic validation with one retry, then the concept is skipped; a pool below MIN_ITEMS fails closed. Items are answerable WITHOUT reading the book (placement measures prior knowledge).
- Sessions: `learner_placement_sessions` table (items/responses as JSON columns on the row; the evidence ledger is the per-answer audit trail). Starting a new placement abandons existing active sessions (fail-safe supersession, documented).

## UI skill truth

- Not applicable: no user-facing UI or motion in this PR (PR-007 will implement the placement flow + mastery/review view under the UI-skill gate).

## Git and authority truth

- Base: `origin/main` `93e26f91f5ccae8075907a2481115488a653bd27`.
- Branch `feat/pr006-placement-cat` created normally from that exact base; initial HEAD `93e26f91f5ccae8075907a2481115488a653bd27`.
- Product PR: `NOT_CREATED`.

## Test truth

- Placement module tests: `PASS` — 4 new files / 24 tests (`placement.test.ts` CAT port-spec with exact audited-formula values incl. theta branches 0.65/0.35/0.56/0.44, SE clamps, stop rules at exact boundaries 9/6 continue vs 9/7 stop; `placement-engine.test.ts` session lifecycle/supersession/fail-closed answers/stop-rule surfacing/finalize formulas/overwrite guard/answer-only evidence/re-finalize rejection; `placement-generation.test.ts` deterministic layer rotation + retry-once-then-skip; `queries` due-list join). Learner module total: 8 files / 65 tests.
- Full core suite: `PASS` — 84 files / 651 tests (was 82/637; +2 files / +14 tests).
- Core package `tsc --noEmit -p tsconfig.json` (run directly for the first time this session): `PASS` after fixing three latent test-file type errors it exposed from earlier PRs (two `.at(-1)` usages predating the tsconfig lib, one closure-narrowing null in the TKG integration beforeAll — no shipped code affected). App `tsc --noEmit`: `PASS` (caught the placement-trigger deps shape missing `placements`). App production Vite build: `PASS` (40.7s).
- Biome on learner module + app learner adapters: `PASS` (clean).
- Existing gates (quality / NSIS / Read-Box / TKG): run unchanged; authoritative result on GitHub CI.
- Real DeepSeek E2E: `NOT_RUN` (generation tested against a local deterministic provider; no real key calls).

## Blockers / partial truth

- None currently. Deferred by design to PR-007: placement flow UI + mastery/review view (under apple-design / emil-design-eng), prerequisite-edge inference in finalize (no edge model exists yet), per-concept difficulty metadata from the future knowledge graph.

## Final handoff snapshot — 2026-08-30 (pre-merge)

- Implementation complete: `placement.ts` (faithful CAT core + finalize formulas), `placement-generation.ts` (LLM content co-processor + deterministic validation), `placement-engine.ts` (session lifecycle + guarded finalize + answer-only evidence), `queries.ts` (due-review join), PlacementStore in types/in-memory/SQLite, `learner_placement_sessions` table, app `placement-trigger.ts` (Book-Skill-chapter concepts, pool cap 24, unified-gateway generation).
- deriveMasteryStatus updated honestly: "unseen" now requires no evidence AND no verified estimate; placement rows (lastVerified set) derive learning/stable from mastery.
- Next exact action: push, wait for exact-head blocking CI, independent acceptance, ordinary merge (no squash/rebase). Post-merge alignment: PR-007 scope (UI: placement flow, mastery/review view, due-review surface — under the UI-skill gate) with the user before code.

## Recovery protocol

After compaction/restart: reread the authoritative handoff, this ledger, the PR-003 audit doc, and the pinned `cat_pretest.py` under `.audit/opentutor-03070426f50fa82d2d1b49859996d77fe0300a05/`; inspect git status/branch/HEAD/remotes; reconcile with GitHub PR/CI state; fail closed on disagreement. Never infer a PASS or COMPLETE state from missing context.
