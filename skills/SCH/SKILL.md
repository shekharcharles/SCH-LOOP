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

Still **not implemented**: sequential queue continuation, automatic retry or
repair, an independent semantic reviewer, the authenticated dashboard, the SCH
MCP, and the structured learning database. If asked for any of those, say plainly
that they are planned and name the next milestone:

> Implement the sequential queue-driven task graph with closed transitions,
> bounded retries, human gates, and execution through fresh supervised worker
> processes.

Never imply autonomous multi-task execution already works, and never simulate it.

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
