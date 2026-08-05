---
name: SCH
description: The single SCH Loop command surface. Use for /SCH and any /SCH <subcommand> — status, project, spec, brainstorm, plan, skills, run, review, learn, graph, pause, resume, stop, approve, dashboard, doctor. Routes to the focused SCH skill or engine command that already does the work; never re-implements it. With no subcommand it resolves the active project and reports its status and next actions.
---

# `/SCH` — one command surface

> **Engine home (`SCH_HOME`):** `$HOME/.claude/SCH-loop`. Every `state.mjs`
> command below lives there; use the absolute path if your terminal is elsewhere.

This skill is a **router**, not a methodology. The methodology lives in the
focused skills (`sch-spec`, `sch-brainstorm`, `sch-plan`, `sch-run`,
`sch-review`, `sch-learn`) and in the engine CLI. Your job is to work out which
one the operator asked for, hand off, and get out of the way.

**Do not paste the command table below from memory.** It is data, and the engine
owns it:

```bash
node scripts/state.mjs sch-commands              # every command
node scripts/state.mjs sch-commands <name>       # one command
```

Matching is **case-insensitive** — `/SCH plan`, `/sch Plan` and `/SCH PLAN` are
one command. Always write it back as `/SCH <name>`; that is the canonical name.

## `/SCH` with no subcommand

Do exactly this, and nothing more:

1. Resolve the project: `node scripts/state.mjs project-here`. No match → say so
   in one line and offer `/SCH spec` (start work) or `/SCH project` (list what
   exists). Stop there.
2. `node scripts/state.mjs stats --project <id>` and
   `node scripts/state.mjs interval-advice --project <id>`.
3. `node scripts/state.mjs profile-validate --project <id>` — execution mode,
   eligibility, and anything unresolved in the capability profile.
4. Report, in under ~12 lines: what the project is, queue counts, anything
   blocked and waiting on the operator, the execution mode, and the 1–3 next
   actions that actually apply.

**Do not** dump the whole command reference. A person who types `/SCH` wants to
know where their project stands, not to read a manual.

## Routing

| Subcommand | Hand off to |
|---|---|
| `status` | `state.mjs stats` + `interval-advice` + `profile-validate` |
| `project` | `state.mjs project-list` / `project-here` / `project-get` |
| `spec` | the **sch-spec** skill (interactive) |
| `brainstorm` | the **sch-brainstorm** skill (interactive) |
| `plan` | the **sch-plan** skill (interactive) |
| `skills` | `state.mjs skill-discover` / `skill-list` / `skill-get` / `skill-recommend` |
| `run` | the **sch-run** skill |
| `review` | the **sch-review** skill |
| `learn` | the **sch-learn** skill |
| `graph` | `node scripts/graph.mjs <query>` |
| `pause` | `state.mjs profile-set --project <id> --mode PAUSED` |
| `resume` | `state.mjs profile-set --project <id> --resume true` |
| `stop` | `profile-set --mode PAUSED`, then `state.mjs lock-release --project <id>` |
| `approve` | `state.mjs skill-trust <id> --state APPROVED` / `profile-set` |
| `dashboard` | http://localhost:4600 (start: `node scripts/dashboard.mjs`) |
| `doctor` | `node scripts/doctor.mjs` (`--fix` to install what is missing) |
| `queue` | `node scripts/sch-run-queue.mjs --project <id>` (the sequential scheduler) |
| `graph-validate` | `state.mjs graph-validate --project <id>` / `graph-show` |
| `scheduler` | `state.mjs scheduler-status / scheduler-list / scheduler-cancel` |
| `phases` | `state.mjs phase-list --task <n>` / `gate-report --task <n>` |
| `decide` | `state.mjs human-gate-list` / `human-gate-decide --gate <id> --decision APPROVED --approver <you>` |
| `transition` | `state.mjs task-transition --task <n> --event <event>` |

Invoke the target skill with the Skill tool — do not re-explain what it does and
do not summarise its instructions. Routing is the entire contribution here.

## The supervised external runner, and what is still NOT implemented

`/SCH run` runs the **in-session** loop that exists today: a pass claims one
task, dispatches a fresh-context subagent, verifies, reviews, and completes it.

Alongside it there is now a **supervised external single-task runner**. It is not
`/SCH run` and it is not autonomous:

```bash
node scripts/state.mjs workspace-init --project <id>       # once per repository
node scripts/state.mjs task-set <n> --project <id> \
     --allow "src/**" --forbid "..." --verify "npm test"   # the run policy
node scripts/sch-run-task.mjs --project <id> --task <n>    # ONE task, ONE attempt
```

It runs one explicitly selected, pre-approved task in a **fresh external `claude`
process**, inspects the actual Git effects, runs SCH's own verification commands,
records a run outcome under `<repo>/.sch-loop/runs/<run-id>/`, and stops. It never
selects another task and never retries. `VERIFIED` means in-policy and verified —
**not** committed, pushed or done.

Delivering that run is a **separate, fail-closed controller** — the only thing in
SCH allowed to stage, commit or push a managed project:

```bash
node scripts/sch-deliver-run.mjs --project <id> --run <RUN-id>   # stops for approval
node scripts/state.mjs delivery-approve --project <id> --run <RUN-id> --approver <you>
node scripts/sch-deliver-run.mjs --project <id> --run <RUN-id>   # commits and pushes
```

It recomputes the verified content hashes and refuses on any drift, requires an
approval bound to that exact diff/branch/remote/message, stages explicit
pathspecs, runs the secret gate on staged content, makes one commit, blocks on
any incoming or unrelated outgoing commit, pushes without force, then fetches
again and asks the remote before the task becomes `delivered`. It never merges,
rebases, amends, resets or force-pushes. One run, one commit, then stop.

## The sequential queue, and the boundary with `/SCH run`

The queue now executes itself, **one task at a time**:

```bash
node scripts/state.mjs workspace-init --project <id>      # once per repository
node scripts/state.mjs delivery-branch-namespace --project <id> \
     --set "sch/task-*" --approver <you>                  # once per project, REQUIRED
node scripts/state.mjs graph-validate --project <id>      # structure + false-edge audit
node scripts/sch-run-queue.mjs --project <id>             # run it, then stop
node scripts/state.mjs scheduler-status --project <id>
node scripts/state.mjs human-gate-list  --project <id>    # what it is waiting on
node scripts/state.mjs human-gate-decide --project <id> --gate <HG-id> \
     --decision APPROVED --approver <you>
```

Each task runs its 16-phase workflow: deterministic `CODE` phases, one `AGENT`
phase in a **fresh external worker**, named `GATE` phases that decide whether the
graph may move, and a `HUMAN` phase for delivery approval. A phase starts
unaccepted; a zero exit code only means the process returned. Retries are
bounded and classified, delivery goes through the controller above, and a task
becomes `DELIVERED` only after the remote has been asked independently. The
scheduler stops at a typed condition and never spins.

**`/SCH run` is now the LEGACY in-session path.** It still works, and it is
constrained in code: it cannot set controller-only states, cannot name a
canonical graph state, and while a scheduler holds the project's lease it cannot
change task status at all — `task-set` refuses and names the scheduler. Use
`/SCH run` for supervised in-session work; use `/SCH queue` when the queue should
execute itself. Never run both against one project at the same time.

Still **not implemented**: parallel execution in Git worktrees, fan-out/fan-in
and integration joins, path-ownership leases, OS-level worker sandboxing, the
authenticated dashboard, the SCH MCP, distributed workers. If asked for any of
those, say plainly that they are planned and name the next milestone:

> Implement isolated parallel task execution using Git worktrees, path ownership
> leases, fan-out/fan-in, deterministic integration nodes, and conflict-safe joins.

**Workers are contained, not sandboxed.** Each task **the queue runs** gets a
disposable worktree on `sch/task-<n>` outside the repository and outside
`SCH_HOME` — `sch-run-task.mjs` does not, and still runs in the operator's
working tree with the credential strip only; say so rather than implying every
task is contained. The worktree root is `%LOCALAPPDATA%\sch-loop\worktrees`
(POSIX: `${XDG_STATE_HOME:-$HOME/.local/state}/sch-loop/worktrees`), moved by the
**process-wide** `SCH_WORKTREE_ROOT`; cancelling a running task force-removes its
checkout and destroys uncommitted work. Workers run with no ambient
git credential helper and no `GH_TOKEN`/`GITHUB_TOKEN`/`GIT_ASKPASS`/
`SSH_AUTH_SOCK`/`SSH_AGENT_PID` — verification commands included — and only the
delivery controller pushes, inside an authorized branch namespace. Effect
inspection still reaches the shared `.git`, so a worker's own worktree and a hook
installed into the shared hooks directory are both caught. But a write outside
the worktree, a network call or a detached background process is still
invisible to it, the credential strip only removes the *ambient*
helper, and none of this is an OS boundary. Fully unattended operation is
therefore still not supported. Never claim otherwise, never imply parallel
execution works, and never simulate it.

## Skills are recommended, never assumed

The operator should not have to remember skill names. Ask the engine:

```bash
node scripts/state.mjs skill-recommend --project <id> --task <n>
node scripts/state.mjs skill-recommend --project <id> --type frontend
```

Each entry carries the reason it was selected. Rules that are not yours to bend:

- An **UNREVIEWED**, **DISABLED** or **BLOCKED** skill is never selected for
  autonomous use. Recommend approval; do not work around it.
- A skill whose content changed since approval is stale — re-approval is a human
  decision (`skill-trust <id> --state APPROVED`).
- Recommending a skill grants **no tool and no permission**. Discovery reads
  skill files as text and executes nothing; keep it that way.

## Boundaries

SCH keeps orchestration, safety, state, permissions, budgets, verification and
Git effects. An external skill is a capability provider — it never becomes the
scheduler. The project contract (`PRD.md` / `SCOPE.md`), the scope gate and the
secret-scan gate outrank anything routed from here.
