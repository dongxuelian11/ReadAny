# Learner Core OSS Build-vs-Reuse Audit (PR-003)

Master handoff §8 mandates this source-level audit before any Track D (Learner Authority) implementation. This document records per-component verdicts for: Evidence, Mastery (BKT), Retention (FSRS), Misconceptions, Transfer, and placement (摸底), plus the Wave-2 Goal→Curriculum references. **No product code and no dependencies change in PR-003; implementation is a later PR gated on these verdicts.**

All deep targets were cloned pinned (detached HEAD) under the gitignored `.audit/` directory and audited by direct file reads; quick-pass targets were inspected live via the GitHub API / raw file reads on 2026-08-30.

## Audit pins and license truth (verified by reading the files, not trusting metadata)

| Repo | Pin | License (verified) | Posture |
|---|---|---|---|
| zijinz456/OpenTutor | `03070426f50fa82d2d1b49859996d77fe0300a05` | MIT (LICENSE, Copyright 2026 Zijin Zhang) | Deep audit |
| skillcoco/skillcoco | `805c6c784db5ad60a02d450dc1711f1b3e1381c6` | MIT (LICENSE + LICENSING.md "100% MIT"; contributor CLA irrelevant to consuming) | Deep audit |
| CAHLR/pyBKT | `06fc180ae72c117458acc527f8ec90cc8e0581c1` (branch `master`) | MIT (LICENSE, CAHL Research / Berkeley); vendored Eigen MPL2/BSD | Deep audit |
| open-spaced-repetition/ts-fsrs | `1303836d36f2c4e3a8a01a44edfee5c89147a990` | MIT (root + package LICENSE) | Deep audit |
| fenago/LearnGraph | `8d506fb77919f311e9b41d0191ceb1de283a4500` | **NO LICENSE FILE** — package.json claims "MIT" and README references a LICENSE that does not exist; treat as unlicensed | Deep audit — design-level only, no code copying |
| GeminiLight/gen-mentor | quick-pass (live HEAD 2026-08-30) | CC0-1.0 (LICENSE present) | Quick audit |
| THU-MAIC/OpenMAIC | quick-pass | MIT (LICENSE present) | Quick audit |
| rsml/tutor | quick-pass | GPL-3.0 (LICENSE present) | Quick audit — reference-only (see §Contamination) |
| legostin/learn-almost-anything | quick-pass | **NO LICENSE** — README: "Not set. Source is open for reading and personal use" | Quick audit — read concepts, copy nothing |

## What each project is (one paragraph each)

- **OpenTutor** — FastAPI/SQLite local-first AI learning platform (PDF→notes/flashcards/quizzes, multi-LLM router, FSRS review). The only audited project covering **all six** Learner Authority components as readable, mostly-LLM-free Python: BKT with question-type-aware guess/slip, FSRS-5/6, CAT placement, confusion-pair misconception detection with a diagnostic-twin loop, rich evidence schemas, forgetting forecasts. Strong test culture (~190 learning-science tests) but young, solo+AI velocity, and its two biggest architectural debts are documented below.
- **SkillCoco** — Tauri 2 open-core desktop tutor whose saving grace is a pure algorithm crate, `skillcoco-core` (BKT, SM-2, thresholds, microlearning selection, pack format, DAG paths): no rusqlite/tauri deps, storage behind traits, injected clock, versioned idempotent migrations v001–v016, append-only evidence tables, huge inline test suites. Per-module (not per-concept) BKT, SM-2 only, and nothing at all for misconceptions/transfer/placement.
- **pyBKT** — the reference BKT implementation (CMU CAHLR, EDM 2021): sklearn-style `Model` with EM fitting and variant flags (multilearn/multiprior/multipair/multigs/forgets), C++ accelerated with a pure-numpy fallback. The core math is a 2-state HMM whose recurrences are small and quotable; the deployment shape (C extensions, distutils, Windows C++ build "cumbersome and untested", pandas/sklearn baggage, no assert-based test CI) makes it a porting reference and an optional offline fitting sidecar — not a runtime dependency.
- **ts-fsrs** — the leading TypeScript FSRS implementation (v5.4.1, FSRS-6, 21 weights with 17/19/21 migration): zero runtime dependencies, ESM/CJS/UMD, plain-data Card/ReviewLog, `next/repeat/get_retrievability/rollback/forget/reschedule` API, 125 golden-value tests across an 8-platform CI matrix, healthy release cadence. Built for exactly our consumption shape (SQLite/TS deterministic core).
- **LearnGraph** — a 7-commit single-author Next.js prototype ("psychorag"): two-graph design (learner graph with 39 psychometric domains + knowledge graph), ZPD engine, gap taxonomy, greedy path planner, SM-2-flavored decay. Unlicensed, duplicated LevelDB/IndexedDB engines (the shipped browser one untested), and — critically — **it implements no goal model**: its planner walks the whole graph. Its value is the schema/taxonomy blueprint plus a research PRD (`research/graph-education.md`) describing the goal-aware APIs the code never implemented.
- **gen-mentor** (CC0) — GenMentor WWW 2025 paper code: the Goal→SkillGap→Curriculum pipeline (goal refiner → skill requirement mapper → gap identifier → path scheduler with reflexion refinement) with self-repairing Pydantic output contracts. The missing "goal-aware" piece LearnGraph lacks.
- **OpenMAIC** (MIT) — 22k-star multi-agent interactive classroom; irrelevant to the Authority layer; future multimodal/visual reference (post-MVP per the handoff).
- **rsml/tutor** (GPL-3.0) — Electron adaptive-book app; useful ideas (schema-versioned domain types, resumable generation checkpoints) but effectively a bus-factor-1 personal project.
- **learn-almost-anything** (no license) — Tauri 2 + SQLite local-first AI tutor, the closest architectural sibling; roadmap-diagnostics placement concept; strictly read-only for us.

## Per-component verdicts

### 1. Evidence events — ADOPT_DESIGN (OpenTutor taxonomy + SkillCoco ledger discipline)

- Adopt **OpenTutor's evidence taxonomy**: `apps/api/models/practice.py` — `PracticeProblem` (7 question types, `knowledge_points` JSON list, `difficulty_layer` 1=recall/2=application/3=trap, `problem_metadata {potential_traps, core_concept, bloom_level}`, `is_diagnostic`) and `PracticeResult` (`error_category`: conceptual|procedural|computational|reading|careless, `answer_time_ms`); `apps/api/models/ingestion.py` — `WrongAnswer` with `error_detail {category, confidence, evidence, related_concept}` and `diagnosis`: fundamental_gap|trap_vulnerability|carelessness|mastered. Direct SQLite→SQLite translation.
- Adopt **SkillCoco's append-only ledger discipline**: `migrations/v016_quiz_attempts.rs` — "one row per submission, never upserted — so the evidence ledger (D-06) has quiz history to read from" (our emphasis: history, not last-value); plus `adaptation_events` (old/new value + reason) as the audit-log pattern.
- Guardrails adopted from the audits: evidence → mastery linkage must be explicit (knowledge-point tagging per evidence row); teach-back/chat signals may become evidence candidates but never direct mastery (handoff §9 is preserved by both references).

### 2. Concept Mastery (BKT) — PORT_ALGORITHM (~50-line TS core) + ADOPT_DESIGN (parameters, semantics); pyBKT as optional offline-fitting sidecar

- Port the **2-state forward filter**: pyBKT's recurrence (`source-cpp/pyBKT/fit/E_step.cpp:247-258`) is a normalized 2×2 matrix-vector product per timestep plus emission likelihoods; one-step prediction (`predict_onestep_states.cpp`) + guess/slip mixing. Inference-only is ~40–60 lines of TypeScript. SkillCoco's `skillcoco-core/src/bkt.rs` `update_mastery` (Bayes posterior + learn step, doctested) is the cleanest single-update reference; port **with its tests as the porting spec**.
- Adopt **OpenTutor's parameterization** (the most practically tuned found anywhere): question-type-aware guess/slip (`services/loom_mastery.py:29-39` — mc 0.25/0.10, tf 0.50/0.10, short_answer 0.05/0.10, fill_blank 0.10/0.10, matching 0.15/0.10, select_all 0.10/0.10), cold-start priors from first attempts, and the "upgrade to EM-fitted params only after ≥15 observations" gating with cache TTL.
- Adopt **SkillCoco's orchestration invariants**: iterate BKT per question (not per quiz aggregate); decide pass/fail after the BKT update; flashcard reinforcement guard (only below threshold AND quality ≥4); explicit single-evidence-channel rule (exercises don't move BKT unless designed to); mastery threshold as a migration-coupled constant.
- **EM fitting**: not needed at MVP. If later wanted, either port the pure-numpy EM (`source-py/pyBKT/fit/EM_fit.py`, ~150 lines total soft-count math) or run pinned pyBKT 1.4.3 as an offline CLI sidecar exporting `coef_` JSON into SQLite. Fitted parameters are deterministic SQLite rows (Authority) — the handoff's model-independence rule is unaffected either way.
- Anti-patterns to avoid (documented upstream debts): OpenTutor's **dual parallel mastery stores** (per-content-node `LearningProgress` vs per-concept `ConceptMastery` with a sync shim) — unify from day one; OpenTutor's **time-on-task blended into mastery** (30% weight) — time-on-task is evidence, not outcome; OpenTutor's **free-string concept matching** — our concept IDs are real keys (Book Skill toolkits + future Knowledge Graph give us the concept namespace).

### 3. Retention (FSRS) — REUSE_AS_DEPENDENCY: `ts-fsrs@5.4.1` exact-pinned (the only new dependency this track needs)

- MIT verified at root and package level; **zero runtime dependencies**; ESM/CJS dual + UMD; FSRS-6 with automatic 17/19→21 weight migration and documented clamping ranges.
- Plain-data `Card {due, stability, difficulty, learning_steps, reps, lapses, state, last_review}` + full-audit `ReviewLog`; `next()` for reviews, `get_retrievability()` for due analytics/forecasting, `forget()` for resets, `rollback()` for corrections, `reschedule()` for history imports. Dates accepted as `Date | number | string` → store epoch millis in SQLite; serialize params via the documented `generatorParameters` pattern.
- Usage posture for a deterministic Authority: `fsrs({ enable_fuzz: false, request_retention: <user setting> })` (fuzz is time-seeded — keep it off or use the card-id seed strategy); consider `enable_short_term: false` (day-granularity LongTermScheduler) for review scheduling.
- Known gotchas recorded for implementation: `Date.prototype` global patch at import (deprecated, removed in v6 — import in an isolated module); do **not** build schemas on `elapsed_days`/`last_elapsed_days` (deprecated, removed in v6 — compute from review timestamps); UTC day-floor interval semantics (same-UTC-day reviews are t=0); pin exact version, expect v6 breaking changes.
- Alternatives noted and rejected for now: `fsrs-rs` (Rust side — our deterministic core is TS; revisit only if a Rust sidecar exists for other reasons); OpenTutor's `fsrs.py` (a clean FSRS-5/6 port but redundant when the canonical TS lib exists — its `forgetting_forecast.py` idea of predicted drop dates per knowledge point is adopted as design).

### 4. Misconceptions — ADOPT_DESIGN (OpenTutor's two-loop model; LearnGraph entity shape)

- Adopt **OpenTutor's confusion-pair detection** (`services/loom_confusion.py`): three detection methods — explicit LLM attribution, wrong-answer-matches-another-concept's-correct-answer, embedding similarity of co-occurring wrong-answer concepts (the only optional vector-coupled method) — writing weighted `confused_with` edges, which then feed contrast-style review prioritization (LECTOR, `services/lector.py`: review_type standard|contrast|prerequisite_first, deterministic given the graph).
- Adopt **OpenTutor's diagnostic-twin loop** (`services/diagnosis/derive.py`): LLM generates a simplified clean twin of a missed problem (`is_diagnostic`, `core_concept_preserved`); original-vs-clean correctness classifies the diagnosis (fundamental_gap | trap_vulnerability | carelessness | mastered). The LLM stays on the co-processor side; the classification and remediation routing are deterministic (`difficulty_selector.py` gap overrides).
- Adopt **LearnGraph's misconception entity shape** (`src/models/types.ts:193-199`): `{id, description, severity: minor|moderate|major, identified, resolved?}` — first-class resolved-tracking matches our "misconceptions corrected" reward metric.
- SkillCoco: nothing exists — build fresh from the above.

### 5. Transfer — BUILD_FRESH (thin), idea adopted from OpenTutor

- OpenTutor's `transfer_detector.py` (~60 lines of core logic) is a cross-course edge traversal recommending reinforcement targets (`source_mastery ≥ 0.7 && target_mastery < 0.7`). Adopt the idea; there is no transfer *measurement* anywhere (no near/far transfer task design). Our Transfer component (handoff §9) needs real task design later; nothing to port.

### 6. Placement (摸底) — ADOPT_DESIGN + PORT_ALGORITHM (OpenTutor CAT pretest), rewrite the estimator

- `services/diagnosis/cat_pretest.py` (~254 lines, deterministic, no LLM): adaptive loop `MIN_ITEMS=5, MAX_ITEMS=20`, stop at `SE < 0.15`; item difficulty seeded from Bloom level; closest-difficulty-to-theta selection; adaptive theta step `0.3/√n`; finalize writes per-concept mastery and **infers untested concepts via prerequisite-edge upward/downward inference**; overwrite guard `if record.practice_count == 0` ("don't overwrite real practice data").
- The theta update is ad-hoc (not true IRT): adopt the loop design, guard, and prerequisite inference; rewrite the estimation properly when we implement.
- SkillCoco's placement is a hardcoded stub; learn-almost-anything's "roadmap diagnostics" is concept-level only. OpenTutor is the sole real reference.

### Wave-2 reference: Goal → Skill Gap → Personal Curriculum (recorded now, implemented later)

- **gen-mentor (CC0)** supplies the missing goal-aware pipeline: goal refiner → skill requirement mapper (`SkillRequirement {name, required_level}`) → gap identifier (`SkillGap {is_gap, current_level, reason ≤20 words, level_confidence}` with self-repairing validators — "repair, not reject" toward model output) → path scheduler with reflexion refinement; `LearningPath = SessionItem[]`. Re-express the contracts in zod.
- **SkillCoco's pack format** (`skillcoco-core/src/packs/model.rs` + `path.rs` DAG validation + the `generate_path_from_pack_does_not_call_ai` test) is the model-independence pattern for curriculum Authority: versioned pack → deterministic path instantiation; LLM optional.
- **LearnGraph's gap taxonomy** (missing/partial/forgotten/misconception with 80/40/60 thresholds; remediation priority misconception > forgotten > partial > missing) and its PRD's goal-parameterized APIs (`analyzeGaps(userId, targetConcepts)`) — design citation only (no license).

## Architecture template for the Track D implementation (decision)

Build a **pure TS `@readany/core/learner` module** on the SkillCoco `skillcoco-core` structural template: pure algorithms with storage behind interfaces, injected clock, versioned idempotent SQLite migrations, append-only evidence ledger, no LLM imports in the deterministic core (LLM observations arrive as pre-typed Evidence candidates through the app adapter). Components: evidence tables (OpenTutor taxonomy + SkillCoco ledger), per-concept BKT (ported, OpenTutor-parameterized), review cards/logs via **ts-fsrs 5.4.1** (the single new dependency), misconception/confusion tables (OpenTutor two-loop), placement engine (OpenTutor CAT adapted), all wired to canonical ReadAny/Book-Skill concept identity (real IDs, never free-string matching).

## Contamination and license postures

- LearnGraph and learn-almost-anything: **no code copying of any kind** (unlicensed). Design concepts only; every implementation written from scratch; avoid transcribing file structure or naming.
- rsml/tutor (GPL-3.0): license-family compatible with this GPL-3.0-or-later fork, but the posture stays **reference-only** — verbatim copying would pin portions and derivatives to GPL terms and complicate future relicensing; bus factor 1.
- pyBKT Eigen subtree ships MPL2/BSD (mostly) with LGPL parts unless `EIGEN_MPL2_ONLY` — irrelevant since we are not vendoring pyBKT; noted for the optional sidecar scenario.
- ts-fsrs is the only REUSE_AS_DEPENDENCY verdict; adding it in the implementation PR must come with an exact version pin and a license note in that PR.

## Maintenance-risk register

| Repo | Risk | Mitigation recorded |
|---|---|---|
| OpenTutor | Solo+AI velocity, chore-heavy commit log, API drift | Algorithms pinned at `0307042`; port with tests as spec, don't track upstream |
| SkillCoco | Open-core pull toward commercial products; `skillcoco-core` pre-1.0 "API UNSTABLE" | Adopt as architecture reference, not dependency |
| pyBKT | Academic burst cadence; no test CI; numpy-2-incompatible test scripts | Algorithm stable since ~2021; port the math; sidecar optional and pinned |
| ts-fsrs | Dominant maintainer; v6 breaking (deprecated-field removal) | Exact pin; isolate import; don't build on deprecated fields |
| LearnGraph | Bus factor 1, 7 commits, no CI, unlicensed | Read-only design citation |
