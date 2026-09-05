# PR-018 Book Skill Cache Correctness + Ask-the-Shelf UI State Ledger

Last updated: 2026-09-06 (Asia/Shanghai)

## Immutable task authority

- Objective: close review item #8's remaining items — the recorded PR-002
  Book Skill cache debts (stale cache on load, unguarded generation against
  book switches "异步串书", the `regenerated` dead/wrong path) — and ship the
  cross-book ask UI consuming the PR-017 grounded-report contract.
- Governing decision document: `docs/ROADMAP_PR012_PLUS.md`.
- UI skills used (per `docs/UI_UX_GOVERNANCE.md`): `apple-design` +
  `emil-design-eng` (both read in full earlier in this roadmap session;
  applied: designed idle/asking/ready/error states, amber stale banner, color
  transitions only, aria-live via the existing panel output pattern, reduced
  motion respected — no transform motion added). `review-animations` not
  applicable. VISUAL_EVIDENCE: `NOT_RUN` (live Tauri + LLM endpoint required;
  carried forward — same honest recording as PR-007/016).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr018-cache-and-ask`, created from exact `origin/main` `9f9d0b57` (merge commit of PR #18).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No changes to the generation pipeline's wipe/rebuild logic (already
  version-guarded), no new dependencies, no ReaderView/aside-structure
  changes, no i18n locales beyond the established en/zh/zh-TW learner-
  namespace convention.

## Design decisions (2026-09-06)

- **Stale-cache detection is O(1), not O(book)**: recomputing the SHA-256
  content version at load time would require re-extracting every chapter on
  every panel open. Instead the registry records a source-file FINGERPRINT
  (size + mtime via a single `stat`) at generation time;
  `loadExistingBookSkill` re-stats and rejects the skill when it differs.
  Legacy entries without a fingerprint are never reported stale (documented
  transitional gap). Genre drift: an entry whose recorded genre differs from
  the current preference is also stale.
- **Fail-closed consumers, honest panel**: `loadExistingBookSkill` returns
  null for a stale skill, so every data consumer (goal/placement/overview/
  ask) falls back to canonical extraction instead of reading skill data built
  from different book content. `inspectBookSkill` (new) reports WHY — the
  BookSkillPanel shows an amber stale banner over the estimate/regenerate
  flow, and `SKILL_STALE` clears on GENERATE_START/COMPLETE.
- **异步串书 guard (recorded PR-002 debt #1)**: `handleGenerate` /
  `handleRetryEstimate` capture the book id they started for and guard every
  dispatch against a mid-flight book switch; the store update inside the
  trigger is closure-keyed and stays correct either way. (The load effect
  already had a cancelled flag.)
- **`regenerated` fixed (recorded PR-002 debt #3)**: `loadBookSkill` returned
  `regenerated: true` on a pure load — now `false`, matching the field
  contract ("False when an up-to-date skill already existed and was reused").
- **Ask-the-shelf UI** lives at the bottom of the BookSkillPanel (it consumes
  exactly the generated skills and requires no aside-structure changes): a
  shelf-wide question box whose claims list shows a mechanical verification
  badge per claim (green check = every citation resolved; amber alert =
  unverified, still visible), plus broadcast / failed-books / claimsUnparsed
  notes. Ask state rides the core `bookSkillPanelReducer`
  (ASK_START/ASK_READY/ASK_ERROR + staleReason) and resets on BOOK_CHANGED —
  the ask is bound to the panel session.

## UI skill truth

- `apple-design` + `emil-design-eng` used (see above). VISUAL_EVIDENCE:
  `NOT_RUN` (carried forward).

## Git and authority truth

- Base: `origin/main` `9f9d0b57`.
- Branch `feat/pr018-cache-and-ask` created from that exact base; initial HEAD `9f9d0b57`.
- Product PR: https://github.com/dongxuelian11/ReadAny/pull/19 (base origin/main 9f9d0b57).

## Test truth

- Core: `PASS` — 93 files / 729 tests (+2 reducer tests: staleness recorded
  then cleared on GENERATE_START; ask flow walk + BOOK_CHANGED reset).
  Existing pipeline assertions (regenerated true on fresh/regen paths) pass
  unchanged — confirming the load-path fix broke nothing.
- App tsc + vite production build: `PASS` (32.8s).
- Biome on touched files: `PASS`.

## Blockers / partial truth

- None currently.

## Final handoff snapshot — 2026-09-06 (pre-merge)

- Implementation complete; local gates green: core 93/729 PASS, app build
  PASS. Authoritative result is exact-head GitHub CI.
- Next exact action: push, wait for exact-head blocking CI (four required
  checks), then ordinary merge PR #19 (no squash/rebase). Post-merge: the
  review's nine items are fully addressed at the scoped V1 level. Remaining
  candidates recorded in `docs/ROADMAP_PR012_PLUS.md`: VISUAL_EVIDENCE pass,
  curriculum reason localization, concept-identity V2 (cross-book merging),
  answer persistence/history.
