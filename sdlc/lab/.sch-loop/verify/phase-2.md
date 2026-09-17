# Phase 2 verification

**Goal:** A user who only cares about one priority can ask the store for exactly those items and get nothing else, without losing the ability to ask for everything.
**Goal source:** .sch-loop/PLAN.md
**Status:** passed
**Why:** 7 truth(s) verified
**Score:** 7/7 truths

| # | Truth | Level | Status | Evidence |
|---|---|---|---|---|
| 1 | a user can ask for one priority and get only items of that priority | flowing | verified | tests/todo.test.mjs:76-84 "list filters by priority" (PASSED) — list({priority:'high'}) returns exactly the two high items, list({priority:'normal'}) returns []; implemented at src/todo.mjs:21-23 |
| 2 | a user can still call list() with no argument and get every item, whatever its priority | flowing | verified | tests/todo.test.mjs:86-93 "list with no argument still returns every item, as copies" (PASSED) — 2 items of different priorities both returned; src/todo.mjs:17 defaults the options object and src/todo.mjs:22 short-circuits on priority===undefined |
| 3 | a user who asks for an invalid priority gets an error that names the valid ones, instead of a silently empty list | flowing | verified | tests/todo.test.mjs:95-98 "list rejects an unknown priority the same way add does" (PASSED) — asserts the message /priority must be one of low\\|normal\\|high/; thrown at src/todo.mjs:18-20 |
| 4 | a user can mutate an item received from a FILTERED list and the store is unaffected | flowing | verified | tests/todo.test.mjs:100-109 "filtered list returns copies" (PASSED) — tampering title/done on the filtered item, re-query still yields 'keep me'/false; copy made at src/todo.mjs:23 after the filter, so dropping .map would fail this test |
| 5 | a user can mutate an item received from an UNFILTERED list and the store is unaffected | flowing | verified | tests/todo.test.mjs:65-74 and 91-92 (PASSED) — mutating listed.title/listed.done does not change the next list() result |
| 6 | a user's filtered query does not destroy or hide the items it filtered out — a later query for another priority still finds them | flowing | verified | tests/todo.test.mjs:81-83 (PASSED) — after list({priority:'high'}), list({priority:'low'}) still returns ['b']; src/todo.mjs:21 reads from items.values() non-destructively each call |
| 7 | a user gets filtered results in insertion order, not an arbitrary order | flowing | verified | tests/todo.test.mjs:81 asserts deepEqual(list({priority:'high'}), [hi, hi2]) in add order (PASSED); order comes from Map iteration at src/todo.mjs:21 — a sort or reverse there would fail it |

## Deterministic checks

- PASS — npm test

## Files the phase touched

- src/todo.mjs
- tests/todo.test.mjs

## Gaps

- (none)
