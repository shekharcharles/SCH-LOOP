---
name: sch-run
description: Use when tickets exist and the user says go — starts the code-owned dispatch loop that runs every ready ticket and stops only when a human is needed.
---

# Run

Start the watchdog. It reads `task.md` top to bottom, runs the first ticket whose dependencies are done, applies the recovery ladder, and keeps going until nothing is dispatchable.

```sh
node "$CLAUDE_PROJECT_DIR/.claude/sch/runtime/cli.mjs" run
```

Dispatch is owned by code, not by you. Do not pick tickets by hand while it runs; do not open app source.

## Before starting

```sh
node "$CLAUDE_PROJECT_DIR/.claude/sch/runtime/cli.mjs" fences
```

Bypass mode refuses to start unless all three fences hold. If it reports failures, fix them (or run `sch-setup`) — never disable a fence to make the run start.

## What happens per ticket

Worktree → executor (fresh process, bypass, confined to `allowed_paths`) → deterministic checks → reviewer (fresh, read-only, two verdicts) → judge (fresh, read-only) → Manager decides PASS / RETRY / HUMAN → fail-closed merge → report → `task.md` status.

## Recovery ladder — no human until tier 4

| Tier | Trigger | What the watchdog does |
|---|---|---|
| 1 | crash, timeout, or a repeating tool loop | kill, `attempt++`, respawn fresh with what happened |
| 2 | rate limit or overloaded | back off 1 → 2 → 4 → 8 minutes; the attempt is not spent |
| 3 | attempts exhausted | mark `[!]`, convene council when gated |
| 4 | council inconclusive, or a `human`/`decision` ticket | mark `[?]`, notify, move to the next unblocked ticket |

A configuration fault (bad `roles.json`, unreadable ticket) stops the whole run — every later ticket would hit the same wall.

## Reporting back

After the run, report only:

- what is done (ids),
- what is blocked and the one-line reason from `.sch-loop/reports/<id>.md`,
- the single next action for the user.

Never re-read transcripts. The report envelope is the interface.

## While it runs

```sh
node ".claude/sch/runtime/cli.mjs" heartbeat   # is the watchdog alive
node ".claude/sch/runtime/cli.mjs" tasks       # queue state
```

A stale heartbeat means the watchdog is gone, whatever the file says; restart with `go`, and `sch-resume` repairs any `[~]` left behind.
