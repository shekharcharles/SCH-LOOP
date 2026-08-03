# ADR 0001 — Context reset is a process boundary, not `/clear`

**Status:** accepted (Stage 0 — records the architecture; the runner is not built)
**Date:** 2026-08-03

## The mistake this exists to stop

The install instructions and the daily-use flow both say `/clear` between spec
and run, and the README describes tasks executing "in a fresh-context subagent".
It is easy to read those two facts together and conclude that SCH already gets a
clean context per task. It does not, and the difference matters enough to write
down before the runner is built on top of the misunderstanding.

## What is actually true

- **Clearing the terminal is cosmetic.** It changes what a human sees. It does
  not unwind anything the model is carrying.
- **Context does not reset within a Claude session.** A long session accumulates
  everything it has read, and later tasks inherit whatever earlier ones dragged
  in. Subagents get their own window, which is why the loop uses them — but the
  orchestrating session keeps growing regardless.
- **A fresh process is the only real reset.** New process, new context, nothing
  inherited except what is deliberately handed to it.

## The architecture

**Interactive periods may use a continuing session.** Specification,
brainstorming, architecture, planning, phase decomposition, dependency review,
skill and profile selection are conversations. Continuity is the point; a person
is present the whole time.

**Execution will not.** Each task — or each bounded attempt at one — will start a
**fresh non-interactive Claude process**. The worker gets a task-specific context
assembled on purpose:

- the one task, its acceptance criteria and its non-goals;
- the project contract (`PRD.md` / `SCOPE.md`) and its rules;
- the files the task actually touches, from the knowledge graph;
- the skills the approved capability profile recommends **by id**, never their
  bodies;
- nothing else. Not the last task's transcript, not the whole plan, not the
  entire learning corpus.

**Continuity lives in durable state, not in a conversation.** Task and project
state (`projects/<id>/state.json`), Git history, written artifacts (reports,
evidence, PoCs) and the knowledge graph carry what the next worker needs. If a
fact is not in one of those, the next worker will not have it — which is a
constraint on how work is recorded, not a reason to keep sessions alive.

**The controller outlives its workers.** The outer SCH controller holds the
queue, the locks, the budget, the audit log and the safety gates. A worker
crashing, hanging, being cancelled or being killed must leave the controller
intact and the state consistent — that is what the run lock's TTL and the
orphan-recovery path in `pass-gate` already do for the in-session loop, and it is
the invariant the external runner must preserve.

## Consequences

- Anything a future task needs must be **written down**, not remembered.
- A worker is disposable: retry means a new process, not a repaired conversation.
- Per-task cost becomes measurable, because each task is its own process.
- `/clear` remains a convenience for the human. It is not the mechanism, and no
  design may depend on it.

## Status

Stage 0 recorded this decision and built the contracts it needs (execution modes,
the capability profile, deterministic skill recommendation) without spawning
anything. The next milestone implemented the decision: `scripts/executor.mjs`
starts a **fresh external `claude` process per attempt** and
`scripts/sch-run-task.mjs` runs exactly one task through it. A new process is the
context boundary; there is no session to reuse, so the invariant is structural
rather than a rule anyone has to follow.

Continuity comes from what the ADR requires it to come from: `$SCH_HOME` state,
the per-project `.sch-loop/` workspace, Git, and the run artifacts under
`.sch-loop/runs/<run-id>/`. The controller outliving its workers is enforced by
the task lease (stale-lease recovery, released on success, failure, timeout,
cancellation and exception) and by every run reaching a terminal outcome on disk.

Still not implemented: retry (which this ADR defines as a *new process*, never a
repaired conversation), queue continuation, and any target-project commit or push.
