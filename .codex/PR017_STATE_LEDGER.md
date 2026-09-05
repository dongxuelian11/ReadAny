# PR-017 Grounded Report Contract (Core) State Ledger

Last updated: 2026-09-06 (Asia/Shanghai)

## Immutable task authority

- Objective: close review item #5 — cross-book answers move from a free-string
  synthesis with unverified `[slug book_number]` citations to a structured
  grounded report: claims with mechanically verified EvidenceRefs, top-k cap,
  bounded per-book concurrency, and per-book partial failure. Semantic routing
  (PR-011) is activated in the app trigger for the hard routing case.
- Governing decision document: `docs/ROADMAP_PR012_PLUS.md` (review verdicts +
  locked decisions).
- Product repository and only product PR target: `https://github.com/dongxuelian11/ReadAny`, base `main`.
- Required branch: `feat/pr017-grounded-report`, created from exact `origin/main` `76660f0a` (merge commit of PR #17).
- Upstream repository: `https://github.com/codedogQBY/ReadAny`.
- No reset, rebase, force push, history rewrite, or automatic upstream synchronization.

## Frozen prohibited scope

- No cross-book ask UI in this slice: the contract + trigger wiring land here;
  the ask UI (consuming `answer.report` claims with verified/unverified
  badges) is the next slice together with PR-018's cache work. `askTheShelf`
  is now contract-complete and UI-ready.
- No changes to routing algorithms (routeSkills / routeSkillsSemantic stay as
  merged in PR-010/011), no per-book prompt changes, no new dependencies.

## Design decisions (2026-09-06)

- `CrossBookAnswer.report: CrossBookReport` (additive field):
  - `claims: ReportClaim[]` — each {text, refs, verified}. `verified` is
    mechanical: EVERY ref resolves (slug installed AND bookNumber exists in
    that skill's chapters) and at least one ref survived; invalid refs are
    dropped from the claim but the claim stays visible, flagged unverified.
  - `failedSlugs` — grounded calls that threw (partial failure). Some failed →
    the rest still synthesize; ALL failed → throw (fail closed).
  - `claimsUnparsed` — the synthesizer ignored the JSON contract: the plain
    synthesis is returned unchanged (legacy shape degrades honestly; existing
    plain-text test fakes flow through this path unchanged).
- Synthesis prompt now demands STRICT JSON `{synthesis, claims[3-8]}` — parsed
  with direct `JSON.parse` plus a fenced-block fallback (the PR-011 lesson:
  we control the format). Refs with non-string fields are dropped during
  validation, never trusted.
- `topK` (default 4) caps the fan-out AFTER routing and broadcast;
  `maxConcurrent` (default 3) bounds in-flight grounded calls via an inline
  worker-pool map (no new dependency).
- App wiring: `askTheShelf` passes `semanticRouting: skills.length >= 3` —
  semantic routing (PR-011) activates exactly where keyword matching
  struggles; below three books the deterministic router is exact and saves a
  routing call. PR-011 is no longer dead code.

## UI skill truth

- Not applicable: no user-facing UI in this slice (core + trigger only).

## Git and authority truth

- Base: `origin/main` `76660f0a`.
- Branch `feat/pr017-grounded-report` created from that exact base; initial HEAD `76660f0a`.
- Product PR: https://github.com/dongxuelian11/ReadAny/pull/18 (base origin/main 76660f0a).

## Test truth

- cross-book.test.ts (+6): mechanical claim verification (valid ref / ghost
  slug / ghost chapter / mixed refs kept-but-unverified / no refs); JSON
  synthesis parsed with verified + unverified claims; honest degradation on
  plain-text synthesis (claimsUnparsed, legacy assertions unchanged); top-k
  cap + peak-in-flight concurrency bound (instrumented fake); partial failure
  (one rejected book → failedSlugs, rest synthesized) + all-failed fail-closed
  throw. Existing PR-010/011 assertions untouched and passing.
- Full core suite: `PASS` — 93 files / 727 tests (+5 net).
- App tsc + vite production build: `PASS` (33.2s).
- Biome on touched files: `PASS`.

## Blockers / partial truth

- None currently.

## Final handoff snapshot — 2026-09-06 (pre-merge)

- Implementation complete; local gates green: core 93/727 PASS, app build
  PASS. Authoritative result is exact-head GitHub CI.
- Next exact action: push, wait for exact-head blocking CI (four required
  checks), then ordinary merge PR #18 (no squash/rebase). Post-merge: PR-018
  Book Skill cache correctness + the cross-book ask UI consuming
  `answer.report` (verified/unverified claim badges), then a VISUAL_EVIDENCE
  pass for the accumulated UI work.
