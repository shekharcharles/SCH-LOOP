# ADR 0006 — Run the ready set the graph already computed

**Status:** accepted · Builds on ADR 0003 (sequential graph scheduler), ADR 0004
(contained worker execution), ADR 0005 (project-local capability packs)
**Date:** 2026-08-06

## Context

The README listed four unimplemented features: parallel execution in worktrees,
fan-out/fan-in, integration joins, and path-ownership leases.

Reading the code before designing changed the shape of the milestone. Three of
the four were already built:

- **Path ownership.** `taskgraph.mjs` `hiddenDependencies` blocks a task's
  readiness whenever its `allowedPaths` overlap another task's while that task is
  in an `OWNING` state. Its own comment says why: *two tasks holding the same
  files is not a scheduling preference, it is data loss.*
- **Fan-out.** `selectReady` returns `{ selected, ready, rows }`. The scheduler
  used `selected` and discarded `ready`.
- **Isolation.** ADR 0004 gave every task its own worktree, branch, lease and
  bounded process.

So the work was not "build parallelism". It was *let the scheduler run the ready
set it already computes* — and fix what that exposed.

## Decision

**Claiming is the lease.** The scheduler claims one task at a time and
recomputes readiness after each claim. Claiming moves a task to `CLAIMED`, an
`OWNING` state, which makes every path-overlapping task immediately un-ready.
Path ownership therefore falls out of the existing graph rules, and no second
locking system exists. Claiming a batch from one readiness snapshot would defeat
exactly this, so selection is deliberately re-read per task.

**One writer for project state.** `mutateState(projectId, fn)` is the only way
project state changes: lock, load, apply a *synchronous* mutation, write, unlock.
An async mutation is refused outright, because it would release the lock before
the write landed.

**Fan-in at worktree creation.** A dependent task branches from the default
branch and then merges each delivered dependency's `sch/task-<n>` branch, in
ascending task id. Before any worker starts, so a conflict costs no model time.

**A bounded wave.** `--max-parallel N`, default 1. At the default the behaviour
is what it always was, and that is asserted by test rather than claimed.

**A stop reaches the workers.** Running out of time, losing the scheduler lease
or blowing a budget cancels every live run — including runs that begin *during*
the drain — and no task is left `RUNNING` with no process behind it.

## Two bugs this found that predate parallelism

Both were live at `--max-parallel 1`, and both are the milestone's real value.

**Project state had no lock at all.** `withFileLock` existed, and its own comment
said it fixed read-modify-write races for "parallel waves and the dashboard". It
was applied in exactly one place — the CLI dispatcher — and it locked the
*registry*, not `state.json`. Every other mutator imported `loadState`/`saveState`
directly. A dashboard POST during a scheduler run could silently erase a task
update. It also gave up after 5 seconds and proceeded *without* the lock,
commented "availability > perfection"; for state mutation that reintroduces
last-write-wins under exactly the contention that makes the lock necessary, so
mutation now fails closed with `STATE_LOCK_TIMEOUT`.

**A task could not build on its dependency's work.** `deps` gated readiness and
supplied prompt context, and nothing merged anything. A task whose dependency had
already delivered was branched from the default branch, which does not contain
that dependency's commits — they live on its own `sch/task-<n>` branch. So "task
B depends on task A" meant "B runs after A", never "B has A's code".

## Alternatives rejected

- **A separate path-lease system.** The graph already refuses to make an
  overlapping task ready. A second mechanism would be a second thing to keep
  consistent with the first.
- **An `INTEGRATION` node kind.** A task with N dependencies already is the join.
  A new node kind would touch the graph validator, transitions, templates and the
  projection to express something already expressible.
- **Rebasing dependencies instead of merging.** The task branch is the durable
  record of that task's work. Rewriting it to get a straighter history trades
  evidence for aesthetics.
- **Integration at delivery time.** The first draft of the spec assumed a
  delivery moves the default branch and invalidates other baselines. Reading
  `delivery.mjs` disproved it: a delivery commits and pushes on the task's own
  branch. There is no baseline race between parallel deliveries.
- **SQLite as the state authority.** The right long-term answer and a separate
  milestone. `mutateState` is the narrowest change that makes concurrency safe.

## Consequences

- **`git merge` is no longer categorically refused.** `candidate.mjs` forbade
  merge outright. It now permits exactly two forms — `merge --no-ff -m <msg>
  sch/task-<n>` and `merge --abort` — and refuses every other merge, including a
  bare `git merge main`. This is the one merge SCH performs, into a disposable
  per-task checkout, and nothing is ever merged into an operator's branches.
- **A dependent task's branch carries its dependencies' commits and a merge
  commit.** Delivery's one-outgoing-commit rule now subtracts commits already
  delivered on a dependency's remote branch, and recognises SCH's own integration
  merges by subject *and* two-parent shape — a subject alone is forgeable by a
  worker. A commit that is neither still stops the push, which is asserted by a
  test in which a worker commits behind SCH's back.
- **N uncontained workers.** Parallelism multiplies the processes that ADR 0004
  contains but does not sandbox. Every caveat there applies N times over.
- **A task interrupted by a stop lands in `NEEDS_DECISION`.** Not `FAILED` — it
  did nothing wrong — and not `CANCELLED`, which the state machine reserves for
  an operator.

## What is still NOT true

- Workers are not OS-sandboxed, a write outside the worktree is neither
  prevented nor detected, and the network is unrestricted.
- All projects share one worktree root.
- One scheduler per project remains the rule; there is no cross-project
  parallelism and no distributed execution.
- Fully unattended operation remains unsupported.
