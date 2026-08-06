# Claim audit — README.md, SCH-LOOP.md, skills/SCH/SKILL.md

**Date:** 2026-08-06 · **Baseline:** `main` @ 246e0dd, 471 tests passing · **Method:** every factual
claim in the three operator-facing documents traced to the test or the code that
proves it. Status is one of **PROVEN** (a named test asserts it), **UNPROVEN**
(the code does it, nothing pins it), **FALSE** (the code contradicts it).

Five milestones landed in quick succession — capability packs, parallel
execution, territory detection, authenticated dashboard, repair phase — and the
drift is almost entirely of one shape: a sentence written when a thing did *not*
exist, left in place after it did. Six FALSE claims, all of that kind.

---

## FALSE — corrected

| # | Claim | Source | Contradicted by | Action |
|---|---|---|---|---|
| F1 | "Still **not implemented**: OS-level worker sandboxing, **the authenticated dashboard**, the SCH MCP, distributed workers." | `skills/SCH/SKILL.md:147` | `scripts/dashboard.mjs` loads/creates a 32-byte token, rejects every unauthenticated request with 401 before routing, and binds `127.0.0.1`. ADR 0008. Seven tests in `tests/dashboard.test.mjs`. | Removed from the not-implemented list; replaced with a positive statement that also says authentication is not authorization. |
| F2 | "Delivery and approval … must not be exposed remotely until the dashboard has authentication, **which it does not have**." | `README.md:531-533` | Same as F1 — and this contradicted `README.md:753` ("The dashboard authenticates every request") 220 lines later, inside the same file. | Rewritten: the dashboard authenticates, and still exposes no delivery/approval/human-gate/transition/scheduler-cancel write, enforced by `validate.mjs`. |
| F3 | "never imply parallel execution works" | `skills/SCH/SKILL.md:176` | The same file says at line 143 that parallel execution exists; `scheduler.mjs:371` takes `maxParallel`; `tests/scheduler.test.mjs:1007` runs two tasks concurrently. | Replaced with the true warning: parallelism multiplies uncontained workers, so above 1 is a deliberate choice. |
| F4 | "One task at a time; the next is claimed only once the previous one's commit is actually on the remote." | `README.md:695-696` | True only at the default `--max-parallel 1`. `tests/scheduler.test.mjs:1007` proves N>1 overlaps. | Qualified: strictly sequential at the default, up to N above it, never two whose paths overlap. |
| F5 | "Denial blocks invocation, not listing, so **roughly a dozen** names remain as context cost." | `README.md:813` | `pack.mjs` `BUILTIN_POLICY.deny` has **six** entries; `deniedBuiltins()` filters the six allowed names out of the twelve known. `tests/pack.test.mjs:199`. | Corrected to six, plus any unclassified new built-in. |
| F6 | "Binds 0.0.0.0 (Tailscale). Set SCH_BIND to a Tailscale IP to hide it from the local LAN." | `scripts/dashboard.mjs:5` (header comment) | `dashboard.mjs:40` — `const BIND = process.env.SCH_BIND \|\| "127.0.0.1"`. The file contradicted itself 35 lines apart. | Header comment corrected. |

## Drift between the three documents — reconciled

| # | Drift | Where | Action |
|---|---|---|---|
| D1 | The dashboard's authentication and loopback bind appeared **only** in README's containment section. `SCH-LOOP.md` (the always-loaded global context) still said "http://localhost:4600 (Tailscale-reachable)"; `SKILL.md`'s routing table said "http://localhost:4600". Both send an operator to a URL that now returns 401. | `SCH-LOOP.md:5`, `SKILL.md:63` | Both now state the token, the loopback default, and that Tailscale needs `SCH_BIND` set explicitly. |
| D2 | Same gap in README's own install and daily-use sections: install step 5 and the manual-install snippet told the operator to open `localhost:4600`; "steer from your Tailscale IP on mobile" was stated without the token or the bind. | `README.md:38-40, 58, 85-86` | All three now name the tokenised URL the server prints and the explicit `SCH_BIND` step. |
| D3 | "Each task runs **16 phases**" stated as universal in two documents, and "Sixteen of them per task" in the third. Only `FULL_SDLC` has 16; `SECURITY_REVIEW` has 5, `SCOUT`/`PLAN_ONLY` 6, `BUILD_ONLY` 7, `PLAN_BUILD`/`DOCUMENTATION_ONLY` 8, `PLAN_BUILD_TEST` 10, `BUILD_REVIEW` 11. | `SCH-LOOP.md:62`, `SKILL.md:128`, `README.md:607` | All three now say the count is the template's decision, 16 under the default `FULL_SDLC`. |
| D4 | "sequential queue" / "the SEQUENTIAL graph scheduler" / "the sequential scheduler" survived the parallel milestone in all three documents and in the README file map. | `README.md:163, 307`, `SCH-LOOP.md:57`, `SKILL.md:65, 112, 114` | Re-worded to "one task at a time **by default**" / "the graph scheduler". |
| D5 | `--max-parallel` missing from the README file map's flag list for `sch-run-queue.mjs` and from the full CLI reference, though it is a real flag (`sch-run-queue.mjs:46`). | `README.md:167, 306` | Added to both. |
| D6 | `validate.mjs`'s dashboard-write check justified itself with "until the dashboard has authentication" — the same stale premise as F1/F2. The check is still right; its stated reason was not. | `scripts/validate.mjs:276` | Comment corrected to "authentication is not authorization". Check unchanged. |
| D7 | `tests/containment.test.mjs` titled its first known-gap test "a write outside the worktree is neither prevented nor **detected**". Since territory detection, a write into the main repo or a sibling checkout **is** detected (`OUTSIDE_WORKTREE_WRITE`). The test body only ever covered a tmpdir, so the assertions were fine; the title over-claimed the gap. | `tests/containment.test.mjs:19` | Retitled to "outside SCH's **territory**" with a comment naming the test that covers the rest. No assertion changed. |

## UNPROVEN — now enforced

| # | Claim | Source | Was | Action |
|---|---|---|---|---|
| U1 | "`sch-run-task.mjs` passes no work root, so it still runs the worker in your working tree." The single most consequential caveat in the containment section — it is the exception to every containment guarantee. | `README.md:727`, `SCH-LOOP.md:102`, `SKILL.md:157` | True in code (`sch-run-task.mjs` calls `runTask({projectId, taskId})` with no `workRoot`), asserted by no test and no contract. A one-line change would have silently falsified it. | `validate.mjs` now fails if `workRoot` appears in `sch-run-task.mjs`. |
| U2 | "The server now binds `127.0.0.1` by default." | `README.md:757` | Every test in `tests/dashboard.test.mjs` sets `SCH_BIND=127.0.0.1` explicitly, so the **default** — the thing that decides whether an operator is exposed on their LAN — was the one part nothing covered. | New test: *"with no SCH_BIND the server binds loopback and prints the tokenised URL"*. Also a `validate.mjs` contract on the default and on the pre-routing auth check. |

While adding U2 the shared `dashboard()` helper turned out to resolve on the
first stdout chunk containing a colon and a digit — i.e. banner line one — so
whether line two was in the buffer depended on chunking. It now waits for the
`open it with:` line and returns bind, port and token parsed from it.

## UNPROVEN — marked honestly instead

| # | Claim | Source | Why not proven | Action |
|---|---|---|---|---|
| M1 | "**Preflight fails closed** on **37** conditions." | `README.md:404` | No test asserts 37, and nothing derives it: the preflight body has 30 `bad()` call sites, some inside loops, plus failures from `preparePromise`. An unverifiable precise number is exactly the claim class this project refuses. | Number removed — "fails closed on every one of these", followed by the same enumeration, which *is* checkable. |
| M2 | "Network access is unrestricted." | `README.md:818` | Proving it requires a network call; the suite is hermetic by rule. | Left as a stated limitation. Correct as written — it claims the *absence* of a protection, which is the safe direction to be wrong in. |
| M3 | "A process that detaches into a new session survives the tree-kill." | `README.md:819` | Same class as M2. `subprocess.mjs`'s `killTree` is tested on both platforms; the escape is asserted only as prose. | Left as a stated limitation, same reasoning. |

## PROVEN — spot-checked, no change needed

| Claim | Source | Evidence |
|---|---|---|
| A queued task gets a disposable worktree outside the repo and outside `SCH_HOME` | README "True now" | `tests/worktree.test.mjs:9` |
| After a queue run the working tree is byte-identical | README "True now" | `tests/containment.test.mjs` — *"a full queue run leaves the main working tree byte-identical"*; `tests/scheduler.test.mjs:807` |
| No ambient credential helper or token reaches a bounded child, verification children included | all three | `tests/containment.test.mjs` — *"no ambient credential helper or token reaches a bounded child"* + *"worker.json lists the environment the child actually received"* |
| A worker that creates its own worktree, or installs a shared hook, is caught | all three | `tests/containment.test.mjs` — *"a worker that creates its own worktree trips worktrees_changed"* |
| A write into the main repository fails the run as `OUTSIDE_WORKTREE_WRITE` | all three | `tests/worker.test.mjs:441` (+ negative control at `:459`); `tests/territory.test.mjs` for the fingerprint itself |
| A worker sees only its pack; `--setting-sources project`; scheduling/config built-ins denied by argv | all three | `tests/containment.test.mjs` — *"the argv SCH launches a worker with suppresses the operator's catalogue"*; `tests/pack.test.mjs:191-228` |
| A denied built-in is still listed | all three | `tests/containment.test.mjs` — *"KNOWN GAP: denying a built-in blocks invocation but not listing"* |
| A skill needing its own scripts cannot be packed | all three | `tests/pack.test.mjs:69` |
| Independent tasks run concurrently; path-overlapping ones never do | README, SCH-LOOP | `tests/scheduler.test.mjs:1007, 1028, 1052` |
| A dependent task's worktree carries its dependencies' delivered work, in task-id order | README | `tests/worktree.test.mjs:172, 218`; `tests/scheduler.test.mjs:966` |
| A stop reaches in-flight workers; none left RUNNING | README | `tests/scheduler.test.mjs:1094, 1109` |
| Run evidence lives in the main workspace, not the disposable checkout | README | `tests/worker.test.mjs:322` |
| Every dashboard request is authenticated; a write without a token is 401 even with a valid CSRF shape | README | `tests/dashboard.test.mjs` (7 tests) |
| Deciding a human gate is CLI-only; the dashboard offers no remote write | README, SCH-LOOP | `tests/scheduler.test.mjs:510`; `validate.mjs` §"the dashboard must not grow a remote write" |
| A retry runs the repairer, not the builder twice | README "NOT wired" list | `tests/scheduler.test.mjs:1127` |
| Every declared semantic phase is executable; a template declaring an unhandled AGENT phase is rejected at validation | README | `validate.mjs` §6f, over all 9 templates |
| All 22 `/api/*` routes named across the three documents exist | README, SCH-LOOP | Enumerated against `dashboard.mjs` |
| Every `sch-run-queue.mjs` flag documented in the CLI reference is real | README | `sch-run-queue.mjs:43-52` |

## What this audit did not cover

Only the three operator-facing documents were audited exhaustively. ADRs 0003-0008
and `docs/superpowers/specs/*` were read for corroboration, not audited as claim
sources — an ADR is a record of a decision at a date and is allowed to be stale by
design. The packs (`packs/*.md`) and the other six skills were not audited.
