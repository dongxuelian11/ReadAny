# PR-026 Concept Graph Completion State Ledger

Last updated: 2026-09-06 (Asia/Shanghai)

## Immutable task authority

- Objective: finish the last three recorded candidates as one coherent
  "graph completion" slice, per the user's directive (把最后的做完):
  (a) alias-driven + language-variant concept merging, (b) learner-state
  projection onto canonical concepts (read-only), (c) prerequisite-aware
  curriculum reordering consuming the graph.
- Governing decision document: `docs/ROADMAP_PR012_PLUS.md`.
- UI skills: `apple-design` + `emil-design-eng` idioms (mastery/status chips
  added to the existing designed 跨书概念 rows; no motion). VISUAL_EVIDENCE:
  `NOT_RUN` for the new chips (live-capture follow-up).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr026-graph-completion`, created from exact `origin/main` `e012aaa8` (merge commit of PR #25).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No learner write-path changes: the projection (b) is a READ model; evidence
  and mastery remain chapter-scoped; no state migration. No LLM calls
  anywhere. No changes to gap classification (only the ORDER of the emitted
  steps changes, and only when prerequisite edges exist).

## Design decisions (2026-09-06)

- **(a) Alias-driven merging**: when folding a topic term, the builder first
  resolves the normalized text and the raw term against existing aliases; a
  hit reuses that concept instead of minting a hash id. New derived aliases:
  the latin runs and CJK runs of the term, lowercased — 「费用 fees」 answers
  to 「费用」 and "fees", so the same bilingual concept folds across languages
  deterministically (no model). Framework concepts stay hash-id (book-scoped).
- **(b) Projection read model** (`learner/concept-projection.ts`):
  `projectConceptState(deps, conceptId)` — participating chapters (registry
  reverse query `listSourceUnitsForConcept`, new) → current per-chapter states
  via the PR-013 read model → evidence-weighted mean mastery (weight =
  max(1, evidenceCount), so placement estimates vote with the smallest honest
  weight) + WORST status (forgetting in any one chapter degrades the whole
  concept) + summed evidence count. Strictly read-only.
- **(c) Prerequisite-aware reordering** (`goal.orderStepsByPrerequisites`):
  pure deterministic Kahn topological sort over chapter-index edges with
  book-order tiebreak; cycle members fall back to book order (a curriculum
  must stay complete); edges referencing chapters outside the curriculum are
  ignored; indexes reassigned after reorder. The app wiring
  (`getCurriculumForGoal`) mines the registry: for each goal chapter's source
  unit → participating concepts → prerequisite edges → participating source
  units of the prerequisite concepts, restricted to the goal's own chapters.
- Store: reverse participation query `listSourceUnitsForConcept` (in-memory +
  sqlite; the participations table from PR-024 needs no schema change).

## UI skill truth

- `apple-design` + `emil-design-eng` idioms. VISUAL_EVIDENCE: `NOT_RUN`
  (carried forward; capture method proven in PR-023).

## Git and authority truth

- Base: `origin/main` `e012aaa8`.
- Branch `feat/pr026-graph-completion` created from that exact base; initial HEAD `e012aaa8`.
- Product PR: https://github.com/dongxuelian11/ReadAny/pull/26 (base origin/main e012aaa8).

## Test truth

- New `concept-projection.test.ts` (4): null for no participation; weighted
  mean + learning status; needs_review degradation after 90-day decay AND the
  "one lapsed chapter degrades the whole concept" case (re-practiced sibling
  does not heal the concept); chapters without state are skipped in the
  aggregate but listed. One draft assertion was corrected pre-merge: a
  chapter below the mastery threshold reads `learning` even when retention
  lapses (deriveMasteryStatus checks mastery first) — the test now drives
  chapters above threshold before decaying.
- New `curriculum-order.test.ts` (5): prerequisite flip; no-edges unchanged;
  out-of-curriculum edges ignored; cycle fallback to book order; transitive
  chain a→b→c.
- Extended `concept-graph.test.ts` (+1): cross-language merge via derived
  aliases (「费用 fees」 folds FEES and 费用 into one concept; alias lookups
  verified).
- Full core suite: `PASS` — 97 files / 749 tests (was 95/739; +2 files / +10 tests).
- App tsc + vite production build: `PASS` (33.2s).
- Biome on touched files: `PASS`.

## Blockers / partial truth

- None currently.

## Final handoff snapshot — 2026-09-06 (pre-merge)

- Next exact action: push, wait for exact-head blocking CI (four required
  checks), then ordinary merge PR #26 (no squash/rebase). After merge: every
  recorded candidate from the original route is delivered; future work (not
  scheduled) would be LLM-assisted semantic merging on top of the alias
  layer and richer graph visualizations.
