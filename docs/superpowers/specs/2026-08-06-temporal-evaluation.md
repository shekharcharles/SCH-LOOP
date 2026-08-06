# Temporal — evaluation

**Status:** evaluation only — no adoption, no integration, no dependency added
**Date:** 2026-08-06
**Baseline:** `main` at `246e0dd`
**Trigger:** README lists "Temporal (evaluation only)" under Planned, and NOT
implemented (README.md:364). This answers the question the line raises.

## The question

Should SCH Loop adopt [Temporal](https://temporal.io) (or a similar
durable-execution engine — Cadence, Restate, AWS Step Functions, etc., which
share Temporal's core shape closely enough that this evaluation's conclusions
apply to the category, not one product) for its task graph and scheduler, or
keep what it has?

## Method

Read before forming an opinion, not the other way round:

- `scripts/scheduler.mjs` — the sequential/bounded-parallel graph scheduler,
  project lease, budgets, stop conditions, drain-on-stop.
- `scripts/transitions.mjs` — the closed 14-state task machine, optimistic
  concurrency (`expectVersion`, `STATE_VERSION_CONFLICT`).
- `scripts/phases.mjs` — the phase engine, its default-fail lifecycle
  (`PENDING → RUNNING → EXECUTED → REPORTED → GATED → ACCEPTED`), recovery
  points and resume.
- `scripts/runner.mjs` — per-task leases with pid liveness and stale recovery,
  attempt directories, evidence on disk.
- `scripts/state.mjs` — the single-writer lock (`mutateState`/`withFileLock`)
  that everything above sits on.
- `docs/adr/0003-sequential-graph-scheduler.md`,
  `docs/adr/0006-parallel-task-execution.md`.
- `README.md` (the stated zero-dependency rule and its actual uses of
  `node:sqlite` in preference to an npm driver) and `package.json` (no
  `dependencies` key).

What I have **not** done: run Temporal, stood up a Temporal server, or written
against a current Temporal SDK. The architectural claims below (server +
persistence-store requirement, the Workflow/Activity split, deterministic
replay, Signals, Cron Schedules) describe Temporal's long-documented, stable
core design and I am confident in them. Anything about current SDK ergonomics,
exact resource footprint, or Temporal Cloud's present pricing/limits I have
not verified and flag as such where it comes up — my knowledge has a cutoff
and that surface moves. Where I am not sure, I say so rather than asserting it.

## What SCH already has, mapped to what Temporal would provide

Temporal's pitch is four things: durable state, automatic retries,
resumability across crashes, and visibility into what a long-running process
did. SCH built independent, file-based versions of all four before this
evaluation was ever asked for. Mapped one at a time:

**Durable state.** Temporal persists workflow state as an event-sourced
history in its server-side datastore; a workflow function is *replayed*
against that history to reconstruct state after a crash. SCH persists task
state as `projects/<id>/state.json`, written only through
`mutateState(projectId, fn)` (state.mjs:183), which takes an mkdir-based file
lock (`withFileLock`, state.mjs:129-148) around a synchronous
read-modify-write — ADR 0006 records that this lock did not originally cover
`state.json` at all and had to be added because "the thing parallel workers
actually mutate had no lock at all" (0006:56-64). On top of that, every task
transition carries an expected version and refuses to apply against a stale
read: `transition()` in transitions.mjs:140-186 checks
`Number(expectVersion) !== version` and returns `STATE_VERSION_CONFLICT`
(transitions.mjs:152-153) rather than silently overwriting a concurrent
write. This is the same problem Temporal solves — no two writers stepping on
each other's version of the truth — solved with a file lock and an optimistic
version check instead of a server. It is a weaker guarantee in one respect
(the lock is a local mkdir-directory, not a distributed consensus mechanism)
and a stronger one in another: Temporal enforces single-writer-ness by
construction, because workflow-local state exists only inside the workflow's
own deterministic code, replayed serially — there is no external code path
that could race it. SCH's state is a shared external JSON file that arbitrary
code *could* try to mutate directly, which is exactly why it needs
`expectVersion` and a lock to defend itself. That is a real structural
difference, covered below under costs, not free.

**Retries.** Temporal gives each Activity a declarative `RetryPolicy`
(backoff coefficient, max attempts, non-retryable error types). SCH classifies
failures through a closed taxonomy: `classifyFailure()`
(scheduler.mjs:87-102) checks a failure code against `RETRYABLE_FAILURES` and
`NON_RETRYABLE_FAILURES` (scheduler.mjs:72-83), consults the task's own
`retryPolicy.retryable_failures` override, and caps repair attempts against
`max_repairs_per_attempt`. `phases.mjs`'s gate-failure handling
(phases.mjs:227-235) further splits FAIL outcomes into `FAILED` (a factual
gate failed — retrying does nothing) versus `RETRYABLE` (a policy gate
failed — a fresh attempt might pass). This is the same shape as Temporal's
retry policy — declared, bounded, classified by error type — implemented as
an explicit closed set instead of a config object, and it fails closed on an
unclassified code (`class: "UNCLASSIFIED"`, scheduler.mjs:98) where Temporal's
default policy would keep retrying an error it doesn't recognise as terminal.

**Resumability.** Temporal recovers a crashed workflow by replaying its event
history through the workflow code from the top, deterministically, until it
reaches the same point. SCH recovers by re-reading disk state and resuming at
a coarser grain — the phase, not the statement. `openAttempt()`
(scheduler.mjs:163-174) asks `PH.recoveryPoint(dir, TASK_WORKFLOW)`
(phases.mjs:246-261) which phase last reached `ACCEPTED`, whether the last one
`STOPS` (RETRYABLE/NEEDS_DECISION/FAILED/CANCELLED), and resumes at the
correct phase id from persisted `phases/<id>.json` records — never from a log
line or memory (phases.mjs:243-245). Separately, both the scheduler lease
(`acquireSchedulerLease`, scheduler.mjs:185-203) and the per-task lease
(`acquireLease`, runner.mjs:128-150) detect their own staleness by checking
TTL expiry and OS pid liveness (`pidAlive`, scheduler.mjs:180, runner.mjs:123)
and recover rather than steal a live lease — the same "who actually still
owns this" problem Temporal's worker-liveness and task-queue mechanics solve,
solved here with a PID check on one machine instead of a heartbeat protocol
across a cluster. `finishDraining()` (scheduler.mjs:484-515) ensures a stop
never abandons a live run: every in-flight run is signalled to cancel, waited
on, and any task still `RUNNING`/`CLAIMED` afterward is moved to
`NEEDS_DECISION` rather than left in a state indistinguishable from "still
going" (scheduler.mjs:505-511) — the equivalent of Temporal never leaving a
workflow execution in limbo when a worker dies.

**Visibility.** Temporal separates the event history (source of truth) from a
queryable "visibility" store used for the Web UI and search — explicitly not
authoritative, rebuildable from history. SCH arrived at the identical split
independently: ADR 0003 states outright that "`ops.db` is a rebuildable
projection for observability and dashboard queries... a projection that
quietly becomes authoritative is a projection you can never rebuild again"
(0003:109-116), backed by an append-only `events.jsonl` per scheduler run with
explicit `causation`/`correlation` ids (`emit()`, scheduler.mjs:411-424) and a
SQLite projection built with `node:sqlite` specifically to avoid adding a
database driver dependency (README.md:169, 228, 701). This is not a place
where Temporal would hand SCH something new; SCH already built the same
separation of concerns, for the same reason, at zero dependency cost.

## What Temporal would genuinely add

Two things survive the mapping above as real, not already covered:

**Push-based interaction instead of polling.** SCH's human gates are resolved
by the scheduler noticing, on its next loop iteration, that a gate was
answered (`HG.list(projectId, { state })` scanned every pass,
scheduler.mjs:567-576) and by `HG.pending(projectId, { state })` stopping the
queue when one is open (scheduler.mjs:558-562). Temporal's Signals let an
external event interrupt a running workflow immediately, no polling loop
required. For SCH this is a latency detail, not a correctness gap — the
scheduler is not running continuously between human decisions, an operator
invokes it — but it is a genuine capability Temporal has and SCH does not.

**Cross-machine orchestrator failover.** ADR 0006 records the actual current
scope plainly: "One scheduler per project remains the rule; there is no
cross-project parallelism and no distributed execution" (0006:115). SCH's
scheduler lease is a single JSON file with a PID check, valid on one machine.
If SCH ever needed *the orchestrator itself* — not a worker, the scheduler
process — to fail over to a second machine, Temporal's server-side workflow
execution (a workflow isn't pinned to a single worker process; any worker
polling the task queue can pick it up) solves exactly that. Nothing in the
codebase today needs it: SCH runs as a CLI a single operator invokes, on one
machine, on one project at a time by design (ADR 0006:115-116).

Everything else Temporal offers — Cron Schedules, multi-language SDKs, child
workflows, exactly-once execution guarantees at a distributed-systems scale —
is real, well-documented, and irrelevant to a single-operator local tool that
already solved its own version of durability, retries, resumability, and
visibility with files and a lock.

## What adopting it would cost

**A server, or a cloud dependency.** Self-hosted Temporal is a Temporal
Server plus a persistence store (traditionally Cassandra or a relational
database, plus Elasticsearch for advanced visibility search) — several
long-running services SCH does not run today and would need to install,
upgrade, back up, and keep available. Temporal Cloud removes the
self-hosting burden and substitutes a network dependency, a vendor account,
and a recurring bill for a project that currently has none of the three. I
have not verified Temporal Cloud's current pricing or limits and will not
guess at a number; the categorical point stands regardless of the figure —
today, `node scripts/sch-run-task.mjs` and `node scripts/sch-run-queue.mjs`
require nothing but a local Node process and git. Either Temporal option ends
that.

**A non-zero dependency footprint against an explicit, currently-honoured
rule.** README.md:322 states "Requires Node >= 20. No dependencies," and
`package.json` has no `dependencies` key at all — every line of SCH is
Node ESM standard library plus subprocess calls to `git` and the `claude`
CLI. This is not incidental: `scripts/projection.mjs` and `scripts/graph.mjs`
both use `node:sqlite` — a Node 22+ *built-in* — specifically instead of an
npm SQLite driver, so that a durable, queryable, FTS5-capable store could be
added without adding a package (README.md:169, 228). The Temporal Node SDK
(`@temporalio/*`) is itself a real dependency tree with a native binding
(the Rust-based `@temporalio/core-bridge`) — a materially larger and harder
addition than the npm SQLite driver the project already chose to avoid. I
found no script that mechanically enforces the zero-dependency rule (it is
not checked by `scripts/validate.mjs`), so it is currently a stated
convention rather than a CI-gated one — worth noting honestly, but it does
not change what adopting Temporal would do to it.

**Determinism constraints on workflow code.** Temporal workflow functions
must be deterministic and replay-safe: no direct file I/O, no direct
subprocess execution, no non-deterministic random or wall-clock access
without the SDK's own deterministic wrappers, because crash recovery works by
re-executing the workflow function against its recorded history. Almost
everything in `scheduler.mjs` and `runner.mjs` is exactly the code this rule
forbids running inside a workflow: `readFileSync`/`writeFileSync` throughout,
`execFileSync`/`runProcess` shelling out to git and the worker CLI
(runner.mjs:18-19, 474-531), `Date.now()` used directly for budget checks
(scheduler.mjs:373, 540-544). None of that can move into a Temporal workflow
function as-is — it would all have to be re-expressed as Activities, with the
workflow function reduced to pure orchestration logic. That is not a
config change; it is a rewrite of the exact layer ADR 0003 and ADR 0006 just
finished building, reviewing, and testing.

**Operational burden on a single-operator tool.** SCH's current failure
surface for "the orchestrator crashed" is: a stale lease file with a dead PID,
recovered automatically on the next invocation (scheduler.mjs:189-198,
runner.mjs:132-142). Running Temporal adds a service (or a vendor) whose own
uptime, upgrades, and credentials are now the operator's problem, on top of —
not instead of — everything SCH already does for its own durability. For a
tool one person runs from a terminal, that is a net increase in what has to
be kept alive for the tool to work at all.

## Migration shape, if this were ever revisited

Not recommended now, but named for the record, smallest step first:

**Smallest reversible step.** Do not touch the task-state machine, the phase
engine, or the per-task runner. If cross-machine scheduler failover ever
becomes an actual requirement (it is not one today — ADR 0006:115), the
one piece of SCH that maps cleanly onto what Temporal is *for* is the
scheduler lease itself (scheduler.mjs:178-222) and the drain-on-stop logic
(scheduler.mjs:483-515) — "which process, if any, currently owns running
this project's queue." That could be prototyped as a single Temporal workflow
behind an alternate CLI entrypoint, leaving `state.json`, `transitions.mjs`,
and `phases.mjs` as the only source of truth they already are. Reversing it
is deleting one file and an entrypoint; nothing downstream would know the
difference.

**The migration this evaluation does not recommend.** Moving the actual
`TASK_WORKFLOW` phase execution (scheduler.mjs:230-256) into Temporal
Workflows/Activities would require: every `CODE` and `AGENT` phase becomes an
Activity (each one already does file I/O or spawns a process); the workflow
function becomes the orchestration loop `runPhase` already implements
(phases.mjs:142-239), re-expressed in Temporal's workflow API; and a decision
about which system is now authoritative for task state — Temporal's own event
history, or `state.json` — because ADR 0003 already assigned that role to
`state.json` and the JSONL event logs (0003:109-116), and Temporal would want
the same job. Running both as sources of truth is not a stable end state;
picking one means either duplicating SCH's whole closed state machine inside
Temporal workflow code, or leaving Temporal as an unused parallel history
nobody reads. Neither is a small change, and no timeline is proposed for it.

## Recommendation

**No.** Keep what SCH has.

The three strongest arguments for adopting Temporal:

1. Temporal's single-writer guarantee is structural, not enforced by a lock
   and a version check the way SCH's is — a genuinely cleaner correctness
   argument if SCH ever has many concurrent external writers to fight off.
2. Signals give push-based interruption of a running process; SCH's human
   gates are polled once per scheduler loop, which is a real (if currently
   harmless) latency gap.
3. If SCH ever needs the orchestrator itself, not just its workers, to
   survive a machine dying — true distributed scheduler failover — Temporal
   solves that category of problem and a PID-liveness lease file does not.

The three strongest arguments against, and why they win:

1. **The durability problem is already solved, locally, at zero dependency
   cost.** Durable state, classified bounded retries, phase-granular
   resumable recovery, and a non-authoritative visibility projection are all
   implemented and tested today (scheduler.mjs, transitions.mjs, phases.mjs,
   state.mjs) — independently arriving at the same architecture Temporal
   ships (event log as truth, projection as a rebuildable view) without a
   server. Adopting Temporal would not add durability; it would relocate
   durability SCH already has into a system SCH would then also have to run.
2. **The cost is categorical, not incremental.** This is not "a dependency
   more" — it is a server or a paid cloud service, on a project whose README
   advertises "No dependencies" as a property and whose own SQLite usage
   (`node:sqlite` over an npm driver) shows that rule is actively honoured in
   design decisions, not just stated. It ends SCH's identity as a local CLI
   tool that runs with nothing but Node and git.
3. **Temporal's determinism discipline would force a rewrite of the layer
   that was just finished.** `scheduler.mjs` and `runner.mjs` are full of the
   file I/O and subprocess calls that cannot execute inside a Temporal
   workflow function. Making this fit Temporal is not a wrapper — it is
   redesigning ADR 0003's and ADR 0006's phase engine and scheduler around a
   different execution model, for capabilities (points 1 and 2 above) that
   are real but narrow enough to solve directly and far more cheaply: a
   webhook or file-watch for human-gate signals instead of a poll loop, if
   the latency ever matters; cross-machine failover left explicitly out of
   scope, as ADR 0006 already does, until a concrete need for it exists.

If a concrete need for distributed, multi-machine scheduling ever appears,
re-open this evaluation against Temporal's state at that time — this document
should not be treated as a permanent verdict on Temporal, only as SCH's
answer to the question as both stand today.
