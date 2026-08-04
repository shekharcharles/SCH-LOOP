# ADR 0003 — The sequential graph scheduler

Status: accepted · Supersedes nothing · Precedes the parallel-execution milestone

## Context

Everything before this milestone was **one task, one attempt, then stop**. A
person selected the task, a person delivered it, a person selected the next one.
That is safe and it was also the whole bottleneck: the machinery to run a queue
already existed — a supervised external runner, independent effect inspection,
deterministic verification, a fail-closed Git transaction controller — and
nothing joined it up.

The obvious way to join it up is to let the model do it: keep a conversation
alive, let it pick the next task, let it decide whether the last one worked. That
is the design this ADR exists to refuse.

## Decision

```text
Code owns the graph.
Agents own bounded semantic phases.
Typed envelopes cross phase boundaries.
Named gates define acceptance.
```

Deterministic code owns: readiness, phase ordering, process invocation, timeout,
effect inspection, verification, envelope validation, gate evaluation, retries,
delivery, remote verification, state transitions and the terminal outcome.

The model may: plan within an approved task, implement within approved paths,
produce a typed envelope, propose decisions, propose candidate lessons and
explain failures.

The model may **not**: select a task, move the graph, count its own retries,
approve anything, authorize a delivery, decide a phase passed, declare a project
complete, raise a budget or expand a scope.

### Consequences of that split

**A phase starts unaccepted.** `PENDING → RUNNING → EXECUTED → REPORTED → GATED →
ACCEPTED`. A zero exit code reaches `EXECUTED`; that is all it has ever meant. An
agent writing "completed" reaches nothing at all — it is one field in an envelope
that is then compared against evidence SCH gathered itself.

**Known operations are `CODE` phases, not agents.** Preflight, Git inspection,
changed-path validation, tests, lint, secret scanning, candidate hashing, commit,
fetch, push and remote verification are all functions. Asking a model to do them
would cost tokens to obtain a less reliable answer.

**A gate returns a report, never a boolean.** What it checked, whether each item
passed, its evidence, and a stable hash of that evidence. A gate whose evidence
is absent FAILS — an absent check is not a passed check.

**Factual and policy gates are different in kind.** A factual gate states
something about the repository or the remote: the diff is what it is, the secret
is there or it is not, the commit is on the remote or it is not. Nobody overrides
those — not an agent, not the operator — because the way past "a secret is
present" is to remove the secret. A policy gate states a rule we chose, and a
person may override their own rule on the record.

**A task's state moves through a closed machine with named actors.** Fourteen
states, one authorised actor per edge, an expected-version check so a stale
process cannot overwrite newer state, and a full audit record per move. The model
is not an actor.

**Retries are bounded and classified.** Retryable means "run it again and it
might work". Non-retryable means "the world has to change first", and re-running
is at best a wasted worker and at worst a second violation. An unclassified
failure fails closed. A retry is a new attempt in a fresh process; the previous
attempt's evidence is never overwritten, and the change it left in the working
tree is carried forward explicitly rather than discarded — SCH does not throw
away a worker's unapproved work to manufacture a clean tree.

**A repair sees failure evidence only.** The task, its criteria, its path policy,
the previous attempt's summary, the failed gate reports, the relevant command
output and the current diff summary — recorded, counted and capped. Not a
transcript, not every previous run, not the whole learning file. This is a
primary token control, and it is measured in characters because nothing here has
a tokenizer.

**A human decision binds.** To the project, task, run, attempt, phase, state
version, proposal hash and — where the repository is involved — the diff hash,
with an expiry and a named approver. Change any of those and it is INVALIDATED.
Yesterday's yes never authorizes today's different diff.

**Completion is a gate, not an inference.** "Nothing is ready" is four different
situations and only one of them is good; a finished project and a deadlock must
never look the same.

## What was adapted from SSSF, and what was not

Adapted structurally, reimplemented in this repository's Node ESM architecture:
deterministic code owning sequencing; agent work inside named phases; typed
envelopes at phase boundaries; named gates defining acceptance; a phase starting
unaccepted; process exit not equalling success; known operations as code phases;
agent roles separate from executor and model configuration; tools and writable
paths as separate permissions; protected orchestration files; events supporting
trace reconstruction; bounded corrections being cheaper than a full restart.

Deliberately **not** adopted: committing all changes; treating the current branch
as the final parallel model; placeholder verification commands; automatic
rollback without proven ownership; missing human approvals; claiming unsandboxed
execution is a guarantee; Python as a second mandatory runtime; same-session
context growth as the default.

No SSSF source code was copied.

## The SQLite projection is not the authority

`projects/<id>/state.json`, the run records, the delivery transactions and the
JSONL event logs remain the truth. `ops.db` is a rebuildable projection for
observability and dashboard queries. That boundary is deliberate: a projection
that quietly becomes authoritative is a projection you can never rebuild again.
It lives under SCH operational data, never inside the managed repository — SCH's
bookkeeping is not the customer's source tree.

## What is NOT true yet

Workers are **not** OS-sandboxed. They run as the operator, in the operator's
repository, with the operator's PATH. The environment is allowlisted, `SCH_HOME`
is withheld, the process is timed out and tree-killed, `.sch-loop/` is
default-denied and every effect is inspected afterwards — and none of that is a
sandbox. Post-run effect inspection compares the repository before and after; a
write outside the repository, a network call, or a detached background process is
invisible to it. Git credentials configured for the operator remain usable by any
process running as them.

Therefore **fully unattended operation is not supported**, and OS-level worker
containment is recorded here as a critical milestone.

## Next

Isolated parallel task execution using Git worktrees, path ownership leases,
fan-out/fan-in, deterministic integration nodes and conflict-safe joins.
