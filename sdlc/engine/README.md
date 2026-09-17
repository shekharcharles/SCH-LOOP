# SCH-LOOP v4 engine

The tracked source of truth for the Conductor runtime. The lab at `../lab/` runs from a copy of this
under `../lab/.claude/sch/`, which is gitignored on purpose: a project's working snapshot is disposable,
this is not.

Design: `../../docs/SCH-LOOP-v4-DESIGN.md` (§7.1 maps every module to what it owns).

## The rule everything here follows

**Code decides, models advise.** Every verdict a model returns is evidence for a decision made in
JavaScript, and no model is ever asked whether its own work passed. The Builder writes, the Judge grades,
the Manager decides, and they are three different processes.

## Layout

```
runtime/     the engine: one module per responsibility, each with a *.test.mjs beside it
scripts/     helpers the runtime shells out to
```

## Run the tests

```sh
node --test "runtime/*.test.mjs"
```

100 tests, no network, no fixtures beyond temporary directories. Seats are injected, so nothing here
needs a real CLI to be tested — but the fences, the worktrees and the ship gates all run real `git`.

## Entry points

```sh
node runtime/cli.mjs run [--max N]        dispatch every ready ticket in task.md order
node runtime/cli.mjs ticket <id>          one ticket, fences → build → review → judge → deliver
node runtime/cli.mjs verify-phase <n>     goal-backward check that a phase delivers its goal
node runtime/cli.mjs ship <n> [--dry-run] release gates, then the pull request
node runtime/cli.mjs setup                onboard a project: probe seats, write roles.json and CLAUDE.md
```

`SCH_PROJECT_ROOT` selects the project. Everything the engine reads or writes for a run lives under that
project's `.sch-loop/`, never next to the engine.

## Syncing the lab

The lab snapshot is a plain copy:

```sh
cp -r runtime scripts ../lab/.claude/sch/
```

Copy in that direction only. Work done in the lab snapshot is invisible to git and will be lost.
