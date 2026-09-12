# ROADMAP â€?PR-012 and beyond (PR-011 review verdicts)

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
| 5 | Grounded report contract | Valid + extra finding | `cross-book.ts` synthesis was a free string with unverified `[slug book_number]` citations; unbounded `Promise.all`; no top-k/budget; one failed book rejected the whole ask. **Extra: PR-011 `semanticRouting` defaults false and the app caller never passed it â€?dead code in the product** |
| 6 | Goal architecture V2 seam | Valid but small | GoalSpec holds bookId + chapters[] directly |
| 7 | Product convergence | Valid, largest user-visible gap | `goal-trigger.ts` / `teaching-trigger.ts` / `ask-trigger.ts` were complete but had ZERO callers; no Goal UI, no Teaching UI, no cross-book ask UI |
| 8 | Correctness debt | 3 of 4 confirmed | Book Skill `loadBookSkill` never compares contentVersion; BookSkillPanel COMPLETE not guarded against book switches ("å¼‚æ­¥ä¸²ä¹¦"); quiz evidence had no durable queue; goal supersession was tested but non-transactional (folded into #1) |
| 9 | GitHub authority | Valid | No branch protection on main; blocking checks not required. **Fixed 2026-09-05 via ruleset 22335539** |

## PR sequence

- [x] **PR-012 â€?learner transaction & idempotency core** (`feat/pr012-learner-transaction`)
  Module-global learner write lock serializing every read-modify-write entry
  point (applyEvidenceEvent, evaluateConceptMastery, goal/teaching/placement
  supersession); deterministic quiz evidence id pinned from question content;
  durable evidence outbox (SQLite + in-memory) with startup replay; app wiring
  (durable-first record, App.tsx startup replay). Evidence-first design: the
  append-only ledger is the journal, mastery is a projection.
  **Merged 2026-09-05 as PR #13** (merge commit `4e506437`); first merge under
  the new ruleset â€?all four required blocking gates PASS on exact head
  `eefa39ff` (quality 4m39s / 91 files 703 tests, NSIS 14m08s, Read-Box 43s,
  TKG 3m25s; non-gating debt job FAILs as documented baseline).
- [x] **PR-013 â€?current-instant learner read model** (`feat/pr013-learner-read-model`):
  `getLearnerStateAt` / `currentConceptMastery` (BKT mastery + FSRS
  retrievability decay at read time â†?status), strictly read-only; wired into
  the mastery overview status chips, the due-review list, the teaching step
  snapshot, and goal gap classification.
  **Merged 2026-09-05 as PR #14** (merge commit `912282a3`); four required
  blocking gates PASS on exact head `f2da69d5` (92 files / 708 tests).
- [x] **PR-014 â€?evidence admission authority (graded trust)** (`feat/pr014-evidence-admission`):
  `EvidenceVerification` axis + admission weights (user_confirmed 1.0 /
  deterministic_keyed 0.6 / llm_judged 0.4 / placement_inferred 0.5) mixed
  into the BKT posterior; `LLM_OBSERVATION` gate enforced before the ledger
  append; quiz evidence stamps llm_judged, teaching MCQ deterministic_keyed;
  placement tested-row confidence fixed to 1/15. User-confirmation UI rides
  with PR-016.
  **Merged 2026-09-05 as PR #15** (merge commit `bbbfb1dc`); four required
  blocking gates PASS on exact head `4518768f` (92 files / 714 tests).
- [x] **PR-015 â€?global concept identity seam (V1)** (`feat/pr015-concept-identity`):
  `learner/concept-identity.ts` (sourceUnitId / parseChapterSourceUnit /
  ConceptIdentityStore / ensureChapterConceptIdentity) + four additive tables
  (learner_concepts, learner_concept_aliases, learner_source_units,
  learner_concept_relations) + lazy registration at quiz evidence / goal start /
  placement start / mastery overview. V1 identity-preserving: chapter concept
  id == source-unit id; V2 rebinds via the registry (tested migration path).
  GoalSpec chapter refs already resolve through concept ids â€?the V2 seam is
  the registry, not the goal shape.
  **Merged 2026-09-05 as PR #16** (merge commit `10abeee8`); four required
  blocking gates PASS on exact head `5df17075` (93 files / 718 tests).
- [x] **PR-016 â€?Learning Workspace UI** (`feat/pr016-learning-workspace`):
  Goal tab (default) with plain-language goal creation â†?deterministic
  curriculum display â†?guided-teaching session flow (deliver/answer/resume/
  re-teach) wired to goal-trigger/teaching-trigger; quiz verdict confirmation
  affordance (PR-014 tail, `user_confirmed` additive event); core panel-state
  goal/teaching reducer; en/zh/zh-TW i18n. UI skills: apple-design +
  emil-design-eng (per governance). VISUAL_EVIDENCE = NOT_RUN (carry-forward).
  **Merged 2026-09-06 as PR #17** (merge commit `76660f0a`); four required
  blocking gates PASS on exact head `8741af4d` (93 files / 722 tests).
- [x] **PR-017 â€?grounded report contract (core)** (`feat/pr017-grounded-report`):
  CrossBookAnswer gains a structured `report` {claims (verified EvidenceRefs),
  failedSlugs, claimsUnparsed}; synthesis prompt returns STRICT JSON
  {synthesis, claims} with honest degradation when the model ignores the
  contract; refs mechanically verified (slug installed + bookNumber exists);
  top-k cap (default 4), bounded per-book concurrency (default 3), per-book
  partial failure (all-failed fails closed); askTheShelf enables
  semanticRouting from 3+ books (revives PR-011 for the hard routing case).
  Cross-book ask UI lands as the next slice (this PR is core + trigger wiring;
  no dead contract â€?the trigger is UI-ready).
- [x] **PR-018 â€?Book Skill cache correctness + ask-the-shelf UI** (`feat/pr018-cache-and-ask`):
  O(1) stale detection (source-file size+mtime fingerprint recorded at
  generation; `loadExistingBookSkill` rejects stale skills fail-closed while
  `inspectBookSkill` reports why â†?amber regenerate banner in the panel);
  BookSkillPanel generation/estimate dispatches guarded against mid-flight
  book switches (å¼‚æ­¥ä¸²ä¹¦, PR-002 debt); `loadBookSkill` regenerated flag
  fixed to false (PR-002 dead-path debt); ask-the-shelf UI at the bottom of
  BookSkillPanel consuming `answer.report` claims with mechanical
  verified/unverified badges + broadcast/failed/unparsed notes.
  VISUAL_EVIDENCE = NOT_RUN (carry-forward).

## Final status (2026-09-06): route complete

All nine review items are addressed, and every recorded carry-forward has
been delivered:

- [x] Cross-book ask persistence & reopenable history â€?**PR-020 (#20)**.
- [x] Curriculum `reason` localization â€?**PR-021 (#21)**.
- [x] Ask re-run affordance â€?**PR-022 (#22)**.
- [x] VISUAL_EVIDENCE live-app capture â€?**PR-023 (#23)** (`docs/evidence/pr016-022/`;
      LLM-driven flows honestly recorded as not exercised â€?need a configured
      endpoint; their state machines are covered by the unit suites).
- [x] Concept identity V2 â€?**PR-024 (#24)**: cross-book concepts folded
      deterministically from Book Skill Tier-1 (zero LLM calls), N:M chapter
      participation, prerequisite/related relations from concept-map edges,
      è·¨ä¹¦æ¦‚å¿µ panel section. Learner state deliberately stays chapter-scoped.

All three graph candidates were completed in PR-026 (#26): alias-driven + language-variant merging, the learner-state projection read model, and prerequisite-aware curriculum reordering. Future (unscheduled): LLM-assisted semantic merging on top of the alias layer, richer graph visualizations.

- [x] **PR-019 â€?GitHub authority** (done ahead of sequence): ruleset 22335539
  on main â€?PR + 4 required blocking checks + no force push/deletion, no
  bypass; "AI does not self-merge" recorded in the ledgers.

## Environment notes (for new sessions)

- pnpm is not on PATH in this environment; use `corepack pnpm â€¦` (repo pins
  pnpm@9.15.0 via packageManager). `corepack enable` fails here (EPERM) â€?the
  shim form works.
- Local checkout has core.autocrlf=true; Biome will flag CRLF on untouched
  files. Not a real problem: git normalizes on commit; only check Biome on
  files you touched.
- Branch `main` must never be pushed locally; all work goes through PRs that
  the repo owner merges (now enforced by the ruleset).

## Use-first iterations (2026-09-06, external review plan)

The 2026-09-06 external review (docs/PLAN_USE_FIRST_20260906.md) re-baselined
the project on "make the daily loop trustworthy first". Delivered:

- [x] **PR-027 â€” idempotent learner commit** (`feat/pr027-idempotent-learner-commit`):
  No transaction primitive exists on the platform adapters, so the commit
  boundary is per-step idempotent markers instead: review card + mastery rows
  carry lastEventId, review logs are event-id-keyed (partial unique index);
  engine apply is resumable (duplicate id with same content resumes,
  EvidenceConflictError on real conflicts); the answer timestamp is pinned at
  enqueue and drives every derivation; quiz evidence ids are attempt-scoped
  (re-answering counts, re-submitting does not); user confirmation is pure
  metadata (no second BKT/FSRS); teaching answers resume after a crash
  between evidence and session advance; one-time VACUUM INTO backup before
  the marker migration. Real-SQLite interrupt/reopen/replay test in
  packages/cli.
  **Merged 2026-09-06 as PR #27** (merge commit `4717f9bc`); four blocking
  gates PASS on head `05b99023` (quality 98 files / 760 tests).
- [x] **PR-028 â€” daily learning loop** (`feat/pr028-daily-learning-loop`):
  TEACHING_STARTED persists the session into panel state BEFORE first-step
  generation (error retry works); TEACHING_ANSWERED snapshots the answered
  step (lastAnsweredView) so feedback renders before the no-content early
  return and inside the completed card; goal restore checks teaching.goalId;
  curriculum recomputed before reteach; due-review list refreshes after
  answers; bounded review flow (REVIEW_QUEUE_LIMIT=20) with the same
  generate â†’ answer â†’ evidence path (source REVIEW, deterministic_keyed);
  answer deps split from generation deps (TeachingAnswerDeps, per-book
  extraction cache); derived aliases are complete per-script segments only
  (no word-level over-merge); concept projection documented as ESTIMATED FROM
  CHAPTER PERFORMANCE; en/zh/zh-TW strings.
  **Merged 2026-09-06 as PR #28** (merge commit `2181ad98`); four blocking
  gates PASS on head `fc4ac930` (quality 99 files / 771 tests).
- [x] **PR-029 â€” citation locatability + alias conflict safety**
  (`feat/pr029-crossbook-refvalid-alias`): ReportClaim.verified renamed to
  referencesResolved; refs resolve only against successful, non-refused
  synthesis sources; ask-history normalizes legacy rows; alias binding is
  add-only (first wins) with kept-not-rebound warnings.
- [x] **PR-030 â€” prerequisite ordering over explicit relations**
  (`feat/pr030-prerequisite-wiring`): framework nodes bind to their chapters;
  new collectPrerequisiteEdges reads ONLY explicit prerequisite relations
  (direction contract, dedupe, book/goal scope); goal trigger re-enables
  ordering with the book-order cycle fallback; adapter-to-ordering wiring
  tests through a real buildConceptGraph registry.

Trial package (iterations 1+2):
`dist-trial/ReadAny_1.3.5_trial_fc4ac930-setup.exe` + TRIAL_NOTES.md
(manual acceptance checklist). Iteration 3 remainders (quality-of-teaching
tuning, alias candidate/confirmed separation, deeper projection) stay
unscheduled until real-usage feedback.
