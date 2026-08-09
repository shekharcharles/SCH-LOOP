# ADR 0010 — The seam a second machine would plug into

**Status:** accepted · Implements the contract only · Extends ADR 0004
**Date:** 2026-08-06

## Context

The README lists *distributed workers* as planned and not implemented. The
tempting reading is that the missing piece is RPC: pick a protocol, serialize the
job, done. It is not. `executor.mjs` already made the *provider* swappable, and
swapping the *machine* breaks three things RPC does not fix:

1. **A lease is a pid.** `runner.mjs` and `scheduler.mjs` both decided "is the
   holder still alive?" with `process.kill(pid, 0)`. That is exact, cheap and
   correct — on one machine. The moment a lease file can be written by another
   host, the number in it belongs to a different pid space, and asking the local
   kernel about it gives a confidently wrong answer in *both* directions: pid
   4321 is very likely alive here and has nothing to do with the holder.
2. **Evidence is the local filesystem.** Git-effect inspection, territory
   fingerprints and deterministic verification all read the disk the runner is
   on. A worker that changes files on another machine's disk produces a run SCH
   cannot inspect, and an uninspectable run must never reach VERIFIED.
3. **Credentials get harder over a network, not easier.** ADR 0004's environment
   allowlist and `GIT_CREDENTIAL_STRIP` protect a child process on this machine.
   Shipping any of that to another host would move the operator's secrets onto a
   box SCH does not control, over a link SCH does not own.

There is no broker and no second machine available here. So this ADR builds the
*contract*, proves it with an in-process transport, and labels what remains
unproven.

## Decision

**`scripts/remoteworker.mjs` — a `WorkerTransport` is "somewhere a job can be
run", and `RemoteExecutor` is an ordinary `AgentExecutor` that runs jobs through
one.** The runner does not change: it still calls `prepare()`, `execute()` and
`cancel()` on something that satisfies ADR 0004's executor contract.

```
dispatch(job, { onHeartbeat, onEvent }) → { claim, host_id, result: Promise<record> }
cancel(claim, reason)                   → best effort, and says so
capabilities()                          → { shared_workspace, heartbeat, cancellable }
```

`dispatch` resolves on *acceptance*, not completion, and returns a durable claim:
a transport that only had a single request/response could never be reconnected to
after a dropped link.

### The three refusals

`RemoteExecutor.prepare()` refuses, before anything runs, a transport that:

- **cannot put the worker's changes on this filesystem** (`shared_workspace`) —
  because nothing downstream could inspect them;
- **cannot report the worker's liveness** (`heartbeat`) — because it would hold a
  task lease nobody can validate;
- **cannot cancel a running job** (`cancellable`) — because SCH owns the timeout
  and the kill, never the worker.

Each is a property a network silently removes. Failing closed at `prepare()` is
the difference between "not implemented" and "implemented wrong".

### Leases: `holderLiveness`, not `pidAlive`

One predicate, used by the task lease (`runner.mjs`), the scheduler lease
(`scheduler.mjs`) and any transport:

| holder | proof of life | if it goes quiet |
| --- | --- | --- |
| this host, or a legacy lease with no `host_id` | `process.kill(pid, 0)` — unchanged | recovered, as before |
| another host | a heartbeat *that host wrote*, within a grace of several intervals | **not recovered** |

The second row is the whole point. A silent remote holder is not a dead one:
silence is a network partition until proven otherwise, nothing here can kill that
process, and taking its lease would put two workers in one worktree. So
`holderLiveness` reports `live: false, recoverable: false`, and `acquireLease`
leaves the file exactly where it is and tells the operator which host to check.
Automatic recovery is refused rather than approximated.

Every lease now records `host_id`. A lease with none is treated as local, so
every lease written before this change keeps its old semantics exactly.

**Heartbeats come from the worker.** `renewLease` is only ever called from a
heartbeat the transport delivered, and it stamps the lease with the *worker's*
host. A coordinator that renewed on its own timer would be recording its own
liveness under the worker's name — and if that coordinator then died, the next
local process would see a local-looking lease with a dead pid and cheerfully
steal a task that is still running elsewhere. Stamping the worker's host makes
that case fail closed instead.

### Credentials: the envelope has no environment

`buildJob` builds the wire format from named fields only — identity, cwd,
workspace, argv, prompt. There is no environment field, filtered or otherwise; a
worker host builds its own from its own `ENV_ALLOW`. `credentialLeaks` then scans
the whole serialized envelope for the *value* of any credential-named variable in
this process (`ANTHROPIC_API_KEY` included — the local executor passes it to its
own child, a remote worker authenticates on its own host) and
`assertCredentialFree` refuses the dispatch. Values, not just keys: a token
pasted into a prompt is the same leak.

### Loopback

`LoopbackTransport` runs the job through a local `AgentExecutor`, in this
process, on this filesystem, with a timer for a heartbeat. It is a faithful
implementation of the contract and a dishonest model of a network. Its value is
that the refusals, the lease renewals, the watchdog and the cancellation path are
all executed end to end by the real runner in `tests/remoteworker.test.mjs`,
including a worker that stops heartbeating while still running.

## Alternatives rejected

- **A fence token on the lease.** The textbook answer to "the holder might not
  really be dead". It only helps if something checks the token before writing
  shared state, and the shared state here is a git worktree, which no token
  guards. A fence with no enforcement point is a field that makes the design look
  safer than it is.
- **Recovering a remote lease after a longer timeout.** A longer guess is still a
  guess. There is no timeout after which a partitioned machine is known to have
  stopped.
- **Shipping a scoped credential to the worker host.** Every version of this ends
  with the operator's secret on a machine SCH does not control. A worker host
  that needs credentials configures its own, and delivery — the only component
  that pushes — stays local by construction.
- **Making the loopback pretend to be a network** (injected latency, dropped
  packets). It would test a fiction of a network against a fiction of a worker
  and produce confidence proportional to neither.

## Consequences

- `holderLiveness` is now the single definition of "the holder is alive" for the
  task lease and the scheduler lease. Local behaviour is unchanged, including for
  lease files written before this change. The delivery controller's *repository*
  lease still uses a bare `pidAlive`, deliberately: delivery is the only component
  that pushes, it needs the operator's credentials, and it therefore never runs
  anywhere but this machine.
- A run record names where it ran: `worker.json` gains `transport`, `host_id`,
  `heartbeats` and `remote_cancel` (all `null` for a local worker).
- The runner hands the executor its lease path. `ClaudeCliExecutor` ignores it.
- A remote holder that goes silent wedges that one task until a person clears it.
  That is the intended trade: a wedged task is recoverable, two workers in one
  worktree is not.

## What is implemented, what is specified, what is UNPROVEN

**Implemented and tested** — the transport contract; the three refusals;
`holderLiveness` and its use by both leases; refusal to recover a foreign lease;
the credential-free envelope and its value scan; heartbeat-driven lease renewal;
the silence watchdog and its `LEASE_LOST` outcome; `LoopbackTransport` end to end
through `runTask`.

**Specified only, not built** — any transport that crosses a machine boundary.
No protocol, no broker, no worker-host agent, no authentication between
coordinator and worker, no job queue, no scheduling across hosts.

**UNPROVEN for lack of infrastructure** — every one of these is untested because
this machine has no second host and the tests take no network:

- That the contract survives a real network. Loopback cannot drop a packet,
  partition, reorder, or skew a clock. A heartbeat here is a timer, not a
  message.
- The grace period. `HEARTBEAT_GRACE_MS` (45s, three intervals) is a guess with
  no measurement behind it.
- Host identity. `SCH_HOST_ID` falls back to `hostname()`, which is not unique.
  Two hosts with the same name make their leases indistinguishable — the exact
  failure this design exists to prevent — and nothing detects it.
- Clock agreement. Every expiry comparison assumes two machines agree about the
  time to within much less than the grace. Nothing checks this.
- Cancellation reaching a remote worker. `cancel()` returns a *request*. Over a
  network there is no equivalent of `taskkill /T /F`, and a cancelled-but-alive
  remote worker is not a case anything here has seen.

**Not solved at all** — *evidence return*. A remote worker's changes stay on the
remote disk. SCH inspects and verifies local disk only, so today a transport must
declare `shared_workspace: true` or be refused. Moving a workspace back — a
bundle, a patch series, an rsync — is neither designed nor built, and until it is,
"distributed workers" means *a shared filesystem*, not *a remote machine*.
Saying otherwise would be the false claim this project refuses to make.
