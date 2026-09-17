# SCH-LOOP v4 engine

The Conductor runtime. A project runs from a copy installed by `sch-setup`; this is the source of truth
and an installed copy is disposable: it is gitignored in the project, and this is not.


Design: `../../docs/SCH-LOOP-v4-DESIGN.md` (§7.1 maps every module to what it owns).

## The rule everything here follows

**Code decides, models advise.** Every verdict a model returns is evidence for a decision made in
JavaScript, and no model is ever asked whether its own work passed. The Builder writes, the Judge grades,
the Manager decides, and they are three different processes.

## Layout

```
runtime/     the engine: one module per responsibility, each with a *.test.mjs beside it
scripts/     helpers the runtime shells out to
hooks/       the two fence hooks, installed into a project by sch-setup
skills/      the lifecycle skills — their prose IS the prompt the stage runner sends
```

## Run the tests

```sh
node --test "runtime/*.test.mjs"
```

159 tests, no network, no fixtures beyond temporary directories. Seats are injected, so nothing here
needs a real CLI to be tested — but the fences, the worktrees and the ship gates all run real `git`.

## Entry points

Onboarding, once per project:

```sh
node runtime/cli.mjs setup                install the engine, both fences and the skills, then prove it runs
node runtime/cli.mjs dashboard            the Roles page: which CLI, which model, which flags, per seat
```

From a goal to a queue:

```sh
node runtime/cli.mjs stage brainstorm --goal "what you want built"
node runtime/cli.mjs stage next           prd, then architecture, then plan
node runtime/cli.mjs stages               what is done and what runs next
node runtime/cli.mjs plan-to-tickets      PLAN.md becomes task.md and the ticket JSONs
```

Then the loop:

```sh
node runtime/cli.mjs run [--max N]        dispatch every ready ticket in task.md order
node runtime/cli.mjs ticket <id>          one ticket, fences → build → review → judge → deliver
node runtime/cli.mjs verify-phase <n>     goal-backward check that a phase delivers its goal
node runtime/cli.mjs ship <n> [--dry-run] release gates, then the pull request
node runtime/cli.mjs notifications        what the loop told the orchestrator
```

`SCH_PROJECT_ROOT` selects the project. Everything the engine reads or writes for a run lives under that
project's `.sch-loop/`, never next to the engine.

## Installing into a project

`sch-setup` is the only supported way. It copies `runtime/`, `scripts/`, `hooks/` and `skills/` into the
project, merges the fences into its `.claude/settings.json` without dropping hooks the project already
had, and then asserts the result can actually run — exiting non-zero if it cannot.

```sh
SCH_PROJECT_ROOT=/path/to/project node runtime/cli.mjs setup
```

Re-running it refreshes the engine in place. It copies over the top and prunes afterwards rather than
deleting first, so a project is never left without an engine, not even for an instant. The engine's own
files are restored every time: a project quietly running a hand-patched fence is a worse outcome than one
losing an edit it should not have made. Its queue, tickets and reports are the project's, and are never
touched.
