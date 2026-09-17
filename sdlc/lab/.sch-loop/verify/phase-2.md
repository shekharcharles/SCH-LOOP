# Phase 2 verification

**Goal:** A user who only cares about one priority can ask the store for exactly those items and get nothing else, without losing the ability to ask for everything.
**Goal source:** .sch-loop/PLAN.md
**Status:** human_needed
**Why:** a runtime behaviour has no test behind it
**Score:** 5/6 truths

| # | Truth | Level | Status | Evidence |
|---|---|---|---|---|
| 1 | a user can call list({priority:'high'}) and get only the high-priority items, nothing else | flowing | verified | tests/todo.test.mjs:76-84 test "list filters by priority" (PASSED) — asserts list({priority:'high'}) deepEqual [hi, hi2], list({priority:'low'}) titles ['b'], list({priority:'normal'}) []; implementation src/todo.mjs:21-23 filters real Map data, not a static list |
| 2 | a user can still call list() with no argument and get every item | flowing | verified | tests/todo.test.mjs:86-93 test "list with no argument still returns every item, as copies" (PASSED) — two items added at different priorities, list().length === 2; src/todo.mjs:17 default `= {}` makes priority undefined and src/todo.mjs:22 short-circuits the filter |
| 3 | a user who passes an invalid priority to list gets an error that names the valid priorities | flowing | verified | tests/todo.test.mjs:95-98 test "list rejects an unknown priority the same way add does" (PASSED) — asserts throw matching /priority must be one of low\\|normal\\|high/; src/todo.mjs:18-20 validates against the same PRIORITIES array add uses (src/todo.mjs:4,12), so the two cannot drift |
| 4 | a user can mutate an item returned by list() without corrupting the store | flowing | verified | tests/todo.test.mjs:65-74 and 91-92 (PASSED) — listed.title = 'tampered' then a fresh list() still reads 'x'/'a'; src/todo.mjs:23 maps spread copies |
| 5 | a user can mutate an item returned by a FILTERED list({priority:…}) without corrupting the store | wired | behaviour_unverified | src/todo.mjs:21-23 — the filtered path shares the same .map(i => ({...i})) as the unfiltered path, so it looks correct, but no PASSED test mutates a filtered result and re-reads the store; tests/todo.test.mjs:81 only deepEquals filtered output against the originals, which passes equally for copies and for live references |
| 6 | a user asking for a priority no item has gets an empty list rather than an error or everything | flowing | verified | tests/todo.test.mjs:83 (PASSED) — list({priority:'normal'}) deepEqual [] with only 'high'/'low' items present; proves the filter is applied rather than silently ignored |

## Deterministic checks

- PASS — npm test

## Files the phase touched

- src/todo.mjs
- tests/todo.test.mjs

## Gaps

- truth: a user can mutate an item returned by a FILTERED list({priority:…}) without corrupting the store
  missing: one test that takes s.list({priority:'high'})[0], writes to .title/.done, then re-reads s.list({priority:'high'}) and asserts the store value is unchanged
  artifacts: tests/todo.test.mjs — the copy-semantics test (lines 65-74) and the no-argument copy assertion (lines 91-92) both exercise only the unfiltered call; the acceptance criterion says "as copies" for list() and is tested there, but the filtered branch's copy guarantee rests on code reading alone
