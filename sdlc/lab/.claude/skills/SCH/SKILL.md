---
name: SCH
description: SCH-LOOP lifecycle router and control plane. Use at the start of development work, when the user says "go", when a request is work rather than a question, or to decide which lifecycle stage runs next. The user should never have to name a skill.
---

# SCH

SCH-LOOP owns the lifecycle. Every other skill is a bounded subroutine it calls, and none of them re-plan or decide PASS.

Before acting, read `.sch-loop/config.md`, `.sch-loop/state.json` and `task.md`. State the mode in one line when starting a controlled build.

## State-aware `go`

If the message is exactly `go` (case-insensitive, trimmed):

1. No `.sch-loop/config.md` → route from the request as normal; do not silently enable SCH for the project.
2. Durable state shows an interrupted run (`[~]` in `task.md`, or a stale heartbeat) → `sch-resume` first.
3. `task.md` has a dispatchable ticket → `sch-run`. Let it run across ticket boundaries.
4. Otherwise → the earliest incomplete lifecycle stage below.

Never ask which skill to run. `go` authorizes routine continuation inside already-approved scope — never destructive operations, new credentials, or scope expansion.

## Route by stage

| The work is | Go to | Gate after |
|---|---|---|
| an idea, unclear, a rough want | `sch-brainstorm` | user approval |
| an approved brief needing requirements | `sch-prd` | user approval |
| an approved PRD needing structure | `sch-architecture` | **council**, then user |
| an approved architecture to slice | `sch-plan` | plan-check, then user |
| an approved plan to turn into work | `sch-tickets` | user approval |
| ready tickets and the word `go` | `sch-run` | — |
| one ticket, run by hand | `sch-build` | Manager |
| a phase that claims to be finished | `sch-verify` | human if gaps |
| new work found mid-run | `sch-insert` | — |
| a consequential disputed decision | `sch-council` | — |
| an independent assessment of a diff | `sch-review` | — |
| a release or merge | `sch-ship` | human |
| a lesson worth keeping | `sch-learn` | — |
| where are we / what is next | `sch-status` | — |
| an interrupted run | `sch-resume` | — |
| onboarding a repository | `sch-setup` | — |

Not a stage at all — answer directly: a factual question, a status restatement, recording a decision.

## When the council convenes

`council_mode: gated` (the default) means the council runs at exactly these points, and not per ticket:

1. architecture approval,
2. plan approval,
3. a ticket carrying `council:true`,
4. the same ticket blocked `[!]` twice,
5. a phase verification that found gaps twice.

`council_mode: per_task` runs it before every ticket — available, expensive, off by default. `off` disables it; then tier 3 of the recovery ladder goes straight to the human.

A council needs at least `council_minimum_seats` live CLIs. If fewer are installed, say so and escalate to the user instead of running a one-model "debate".

## Boundaries

- The orchestrator writes `task.md`, `.sch-loop/`, docs, `LESSONS.md`, `CLAUDE.md`. Never application source — that is the executor's job, and an orchestrator that edits code rots its own context.
- Subroutine skills perform one step and return. They never re-plan, never own lifecycle state, never decide PASS.
- The Manager is code (`.claude/sch/runtime/cli.mjs`). A PASS reached by reasoning is not a PASS.
- Herdr is transport only. `.sch-loop/` and `task.md` are the state.
- A project whose own instructions name a different lifecycle owner keeps that owner until migrated. Two lifecycle stores in one project is a bug.

## Context discipline

Read one brief and one report at a time. Compact at phase boundaries, never mid-ticket. At 25% context remaining, write a handoff and stop rather than continuing degraded.
