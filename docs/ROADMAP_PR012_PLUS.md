# ROADMAP — PR-012 and beyond (PR-011 review verdicts)

Last updated: 2026-09-05. This file is the cross-session handoff for the
post-PR-011 roadmap: it records the code-level verdicts on the external
review's nine points and the agreed PR sequence. A new session should read
this file plus the latest `.codex/PRxxx_STATE_LEDGER.md` to resume.

## Decisions locked with the user (2026-09-05)

1. **Mainline order = hybrid**: two small correctness PRs first (transaction /
   idempotency, read model), then the Learning Workspace UI (big feature),
   then the remaining review items. Rationale: the workspace displays mastery
   numbers, so the numbers must be trustworthy first.
2. **Evidence admission = graded trust**: deterministic-keyed evidence keeps
   full weight; LLM-judged evidence is down-weighted and marked unverified;
   explicit user confirmation upgrades it. (PR-014.)
3. **GitHub authority = enforce now**: a branch ruleset on `main` was created
   2026-09-05 (ruleset id 22335539): PR required, the four blocking CI gates
   are required status checks, force push and deletion forbidden, no bypass
   actors (admins included), no review requirement (solo project).
4. **Global Concept Identity V1 = seam only**: concepts / aliases /
   source-units / relations tables plus lazy registration of the existing
   chapter concepts; the legacy `book:chapter` id becomes the source-unit
   identity. No cross-book merging, no LLM concept extraction in V1. (PR-015.)

## Review verdicts (verified against code, 2026-09-05)

| # | Review item | Verdict | Evidence |
|---|---|---|---|
| 1 | Learning transaction / command journal | Valid, right-sized (no full event sourcing) | `engine.ts` applyEvidenceEvent was a 6-step read-modify-write across 3 tables with no transaction; `write-retry.ts` serializes statements only; quiz evidence had a random UUID id (not idempotent); quiz write was fire-and-forget |
| 2 | Global concept identity V1 | Valid direction, seam-only V1 | All identities are `readany:book:<id>:chapter:<n>` (`evidence-mapping.ts`), mirrored in 5 places; no concepts/alias/relations tables |
| 3 | Evidence admission authority | Valid, highest correctness impact | Quiz = LLM-generated + LLM-judged with confidence=1 full BKT weight; teaching MCQ graded against the LLM's own key with confidence=1; `confidence` field never read by any computation; the designed `LLM_OBSERVATION` gate was never implemented |
| 4 | Current learner state read model | Valid | `evaluateConceptMastery` (the only recompute-at-instant path) had zero production callers; UI/overview/goal-gap all read the persisted status, so FSRS forgetting never degraded displayed state |
| 5 | Grounded report contract | Valid + extra finding | `cross-book.ts` synthesis was a free string with unverified `[slug book_number]` citations; unbounded `Promise.all`; no top-k/budget; one failed book rejected the whole ask. **Extra: PR-011 `semanticRouting` defaults false and the app caller never passed it — dead code in the product** |
| 6 | Goal architecture V2 seam | Valid but small | GoalSpec holds bookId + chapters[] directly |
| 7 | Product convergence | Valid, largest user-visible gap | `goal-trigger.ts` / `teaching-trigger.ts` / `ask-trigger.ts` were complete but had ZERO callers; no Goal UI, no Teaching UI, no cross-book ask UI |
| 8 | Correctness debt | 3 of 4 confirmed | Book Skill `loadBookSkill` never compares contentVersion; BookSkillPanel COMPLETE not guarded against book switches ("异步串书"); quiz evidence had no durable queue; goal supersession was tested but non-transactional (folded into #1) |
| 9 | GitHub authority | Valid | No branch protection on main; blocking checks not required. **Fixed 2026-09-05 via ruleset 22335539** |

## PR sequence

- [x] **PR-012 — learner transaction & idempotency core** (`feat/pr012-learner-transaction`)
  Module-global learner write lock serializing every read-modify-write entry
  point (applyEvidenceEvent, evaluateConceptMastery, goal/teaching/placement
  supersession); deterministic quiz evidence id pinned from question content;
  durable evidence outbox (SQLite + in-memory) with startup replay; app wiring
  (durable-first record, App.tsx startup replay). Evidence-first design: the
  append-only ledger is the journal, mastery is a projection.
  **Merged 2026-09-05 as PR #13** (merge commit `4e506437`); first merge under
  the new ruleset — all four required blocking gates PASS on exact head
  `eefa39ff` (quality 4m39s / 91 files 703 tests, NSIS 14m08s, Read-Box 43s,
  TKG 3m25s; non-gating debt job FAILs as documented baseline).
- [x] **PR-013 — current-instant learner read model** (`feat/pr013-learner-read-model`):
  `getLearnerStateAt` / `currentConceptMastery` (BKT mastery + FSRS
  retrievability decay at read time → status), strictly read-only; wired into
  the mastery overview status chips, the due-review list, the teaching step
  snapshot, and goal gap classification.
- [ ] **PR-014 — evidence admission authority (graded trust)**: provenance /
  verification fields on EvidenceEvent; trust weights into the BKT update;
  quiz LLM-judged evidence down-weighted + unverified; teaching MCQ medium
  trust; explicit user confirmation upgrades; fix placement "confidence=1 with
  zero evidence" semantics.
- [ ] **PR-015 — global concept identity seam (V1)**: concepts / aliases /
  source_units / concept_relations tables + ConceptId type + lazy registration;
  legacy book:chapter kept as source-unit; GoalSpec chapter refs route through
  the mapping (Goal V2 seam).
- [ ] **PR-016 — Learning Workspace UI** (feature centerpiece, may split into
  016a wiring + 016b integration): Goal creation (free text → GoalSpec →
  curriculum display) → Teaching session UI → mastery/review via the read
  model, chained inside the Reader aside; cross-book ask entry point;
  UI_UX_GOVERNANCE skills + 7-locale i18n + visual evidence required.
- [ ] **PR-017 — grounded report contract**: structured CrossBookReport
  {claims, unverified, sources} with mechanically verified EvidenceRefs;
  top-k cap, budget, bounded concurrency, per-book partial failure; turn on
  semanticRouting in the app (revive PR-011 dead code).
- [ ] **PR-018 — Book Skill cache correctness**: compare contentVersion on
  load; stale marking/rebuild; BookSkillPanel book-switch guard; regenerated
  dead path.
- [x] **PR-019 — GitHub authority** (done ahead of sequence): ruleset 22335539
  on main — PR + 4 required blocking checks + no force push/deletion, no
  bypass; "AI does not self-merge" recorded in the ledgers.

## Environment notes (for new sessions)

- pnpm is not on PATH in this environment; use `corepack pnpm …` (repo pins
  pnpm@9.15.0 via packageManager). `corepack enable` fails here (EPERM) — the
  shim form works.
- Local checkout has core.autocrlf=true; Biome will flag CRLF on untouched
  files. Not a real problem: git normalizes on commit; only check Biome on
  files you touched.
- Branch `main` must never be pushed locally; all work goes through PRs that
  the repo owner merges (now enforced by the ruleset).
