# Parallel task execution — design

**Status:** approved, not yet implemented
**Date:** 2026-08-05
**Baseline:** `main` at `5a4a866`, 445 tests passing
**Follows:** ADR 0003 (sequential graph scheduler), ADR 0004 (contained worker
execution), ADR 0005 (project-local capability packs)

## The problem

The queue scheduler runs one task at a time. The README lists parallel
execution, path-ownership leases, fan-out/fan-in and integration joins as four
separate unimplemented features.

Reading the code first changed the shape of the work. Three of those four are
already built:

- **Path ownership exists.** `taskgraph.mjs` `hiddenDependencies` blocks a task's
  readiness whenever its `allowedPaths` overlap those of another task in an
  `OWNING` state (`CLAIMED`, `RUNNING`, `VERIFYING`, `AWAITING_DELIVERY`,
  `DELIVERING`, `RETRYABLE`, `NEEDS_DECISION`). The comment in that file already
  states the reasoning: *two tasks holding the same files is not a scheduling
  preference, it is data loss*.
- **Fan-out exists.** `selectReady` returns `{ selected, ready, rows }`. The
  scheduler uses `selected` and discards `ready`.
- **Isolation exists.** M6 gave every task its own worktree, its own
  `sch/task-<n>` branch, its own lease and its own bounded process.

So this milestone is not "build parallelism". It is *let the scheduler run the
ready set it already computes, and keep integration deterministic while it does*.

That reframes the risk. The danger is not conflicting writes — the graph already
prevents those. The danger is **shared mutable state** and **integration**.

## The precondition nobody asked for

`state.json` is read, mutated and written back. `runner.mjs`, `scheduler.mjs`,
`transitions.mjs`, `humangates.mjs`, `dashboard.mjs` and `state.mjs` do this at
roughly 38 sites.

Inside one process, being single-threaded does not save this pattern: any `await`
between the load and the save lets a second run load the same state and write
after the first, silently erasing it.

A lock primitive already exists — `withFileLock` at `state.mjs:131`, whose own
comment says it fixes read-modify-write races for "parallel waves + the
dashboard". **It is applied in exactly one place**: `state.mjs:2277`, wrapping the
CLI command dispatcher, and it locks the *registry* file, not the per-project
`state.json`.

Every other mutator — `runner.mjs`, `scheduler.mjs`, `transitions.mjs`,
`humangates.mjs`, `dashboard.mjs` — imports `loadState`/`saveState` directly and
takes no lock at all. The race is therefore **live today at `--max-parallel 1`**:
a dashboard POST during a scheduler run can silently erase a task update.
Parallel execution does not introduce this bug, it makes it routine.

A second weakness: after `LOCK_WAIT` (5s) `withFileLock` gives up waiting and
**proceeds without the lock**, commented "availability > perfection". For a CLI
command that is a defensible trade. For N concurrent workers mutating task state
it silently reintroduces last-write-wins under exactly the contention that makes
the lock necessary. State mutation must instead fail closed with a typed error
and let the caller decide.

**Decision.** Add `mutateState(projectId, fn)` to `state.mjs`, built on the
existing lock but pointed at the right file and failing closed:

1. acquire a per-project lock file (same staleness and pid-liveness discipline as
   the existing task lease),
2. load,
3. apply `fn` **synchronously** — no `await` permitted inside, enforced by
   passing a plain function and documenting the rule at the call site,
4. write atomically,
5. release.

Every paired load/mutate/save site converts to it. This is a correctness fix that
stands on its own merit at `--max-parallel 1`, and it ships first for that reason.

## Claiming is the lease

There is no second locking system. The scheduler claims tasks from the ready set
**one at a time, recomputing readiness after each claim.**

Claiming task A moves it to `CLAIMED`, which is an `OWNING` state, which makes
every path-overlapping task immediately un-ready. Path ownership therefore falls
out of the existing graph rules rather than being bolted on.

Sequential claiming is what makes this sound. Claiming a whole wave in one batch
would read one readiness snapshot and could claim two overlapping tasks from it.

## Bounded wave

`sch-run-queue.mjs` gains `--max-parallel N`, **default 1**.

At the default, behaviour is byte-identical to today — that is the safety
argument for the whole milestone, and it is asserted by test rather than claimed.

The loop claims up to N ready tasks, runs them concurrently, and refills a freed
slot from a freshly computed ready set the moment a task reaches a terminal
state.

## Fan-in happens at worktree creation, not at delivery

An earlier draft of this spec placed integration at delivery time, on the
assumption that a delivery moves `main` and invalidates every other in-flight
baseline. **Reading the code disproved it.** A delivery commits on the task's own
`sch/task-<n>` branch and pushes there (`delivery.mjs`); `main` is never moved.
There is therefore no baseline race between parallel deliveries, and deliveries
stay serialized only because one repository lease and one fail-closed controller
are simpler to reason about — not because they contend.

The real gap is upstream, and it is **live today at `--max-parallel 1`**: `deps`
are consumed only for readiness (`taskgraph.mjs`, `state.mjs:446`) and for prompt
context (`runner.mjs:1158`). Nothing merges anything. A task worktree is branched
from `main`'s HEAD (`scheduler.mjs:570`), so a task whose dependency has already
delivered starts from a tree that **does not contain its dependency's work**.

**Decision.** At worktree creation, a task branches from `main` HEAD and then
merges the `sch/task-<n>` branch of every delivered dependency, in task-id order
for determinism. This is the integration node — no new node type, just the base a
dependent task deserved all along.

- The merge happens **before any worker starts**, so a conflict costs no model
  time and no partial work.
- Merge commits are recorded in the run evidence: which dependency branches, at
  which commits, in which order.
- A dependency that is `delivered` but whose branch is missing is a typed
  failure, not a silent skip.

One new failure code, `DEPENDENCY_MERGE_CONFLICT` → `NEEDS_DECISION`, keeping the
worktree in place as evidence. Not `RETRYABLE`: retrying a conflict produces the
same conflict, and resolving it is a person's judgement.

Delivery itself is unchanged.

## Failure isolation

One task failing does not cancel its in-flight siblings. The wave drains, and
budgets (`max_consecutive_failures`) are evaluated on completion order.

`HALT` and run cancellation must reach **every** in-flight run. A cancel that
stops only the first worker is the failure mode this section exists to prevent.

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `state.mjs` `mutateState` | The only way project state is mutated | file lock only |
| `scheduler.mjs` claim loop | Sequential claiming, wave bounding, slot refill | `taskgraph`, `mutateState` |
| `scheduler.mjs` wave runner | Concurrent execution, drain, budget evaluation | `runner` |
| `worktree.mjs` fan-in base | Merge delivered dependency branches at creation | `taskgraph` |

## Testing

The suite stays hermetic: temporary `SCH_HOME`, temporary repositories, local
bare remotes, fake executables. No real model, no network, no credentials.

Concurrency is made deterministic with barriers in the fake executor rather than
with sleeps:

- Two path-overlapping tasks are **never** in flight simultaneously, at any
  `--max-parallel`.
- A concurrent-mutation test that fails on a lost update.
- A task whose dependency delivered starts from a tree that CONTAINS that
  dependency's change — the fan-in test, and it fails against today's code.
- Two delivered dependencies merge in task-id order, deterministically.
- A conflicting dependency merge stops at `DEPENDENCY_MERGE_CONFLICT` before any
  worker starts, worktree preserved.
- Cancellation reaches every in-flight run, not only the first.
- `--max-parallel 1` reproduces today's behaviour exactly.

## Out of scope

- **An `INTEGRATION` node type.** A task depending on N others already is a join.
  Adding a node kind would touch the graph validator, transitions, templates and
  the projection to express something the graph already expresses.
- **SQLite as state authority** (a later milestone). `mutateState` is the
  narrowest fix that makes parallelism safe; migrating the authority is a
  separate decision with its own migration risk.
- **OS-level sandboxing** (a later milestone). Parallelism multiplies the number
  of uncontained workers; it does not change what containment they have.

## What will still not be true

- Workers remain un-sandboxed, and there are now N of them. Every caveat in ADR
  0004 stands and applies N times over.
- A write outside the worktree is still neither prevented nor detected.
- All projects still share one worktree root.
- Fully unattended operation remains unsupported.
