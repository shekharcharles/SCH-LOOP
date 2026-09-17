# SCH-LOOP v4 lab

Throwaway project that proves the Conductor loop before anything is installed globally. Everything the loop needs lives under this folder; nothing resolves to `~/.claude`.

```
.claude/settings.json   hooks: write-guard + destructive-bash (fences 2 and 3)
.claude/hooks/          the two fences + hooks.test.mjs
.claude/skills/sch-*/   13 skills snapshotted from ~/.claude/SCH-loop @ 7820c36 (paths rewritten to $CLAUDE_PROJECT_DIR/.claude/sch)
.claude/sch/            engine snapshot: runtime/ + scripts/ from the same commit
.sch-loop/              config.md · roles.json · state.json · tickets/ briefs/ reports/ reviews/ evidence/ council/
task.md                 the queue (empty until sch-tickets)
src/ tests/             sample app under test (node:test, zero deps)
```

Design: `../../docs/SCH-LOOP-v4-DESIGN.md`. Decisions so far: SDLC-only loop (pentest lives in `../../pentest/` later) · council gated · Claude Opus reviews, Sonnet judges · IDs `T1.4-slug` · all three fences mandatory.

## Run

```sh
npm test                 # sample app, must be green before any ticket
npm run hooks:test       # both fences behave
npm run engine:providers # which CLIs the engine can see
```

Open the executor pane from the orchestrator terminal (Herdr binary here is `herdr.exe`):

```sh
herdr new --cwd "D:/SCH-LOOP/sdlc/lab" -- claude --model opus --dangerously-skip-permissions --remote-control
```

Then, in the orchestrator terminal inside this folder: `go`.

## Exit criteria (all must hold before `sch-setup --global` exists)

| # | Criterion | Evidence |
|---|---|---|
| 1 | `go` routes brainstorm → PRD → architecture → plan → tickets without anyone naming a skill | met — proven on a fresh project, not here: one sentence of goal produced 48k characters of brainstorm, PRD, architecture and plan, then the ticket queue. `cli.mjs stages` / `stage <id>` / `plan-to-tickets` |
| 2 | Three ticket types run: `build`, `test`, `human` (the human one spawns no executor) | met — T1.1, T1.2, T1.3. Herdr is separately proven: a real pane received a notification |
| 3 | A ticket inserted mid-run (`T1.2a`) is picked before `T1.3` | met — queue order verified |
| 4 | One ticket forced red reaches `[!]`, the council convenes, its verdict re-dispatches it | met — T1.4a: `[!]` → 3 seats (one absent) → 7.6k verdict → re-dispatched carrying it |
| 5 | Reviewer and judge never write a file (hooks + `--disallowedTools` both hold) | met — a real reviewer seat in bypass mode answered "CANNOT — write was denied" |
| 6 | Phase verify passes goal-backward; `sch-ship` opens a PR into this lab | met — phase 2 verified 7/7 truths, `ship 2` opened PR #1 |
| 7 | Executor killed mid-ticket → respawn with the failure note, `attempt` increments once | met — `.sch-loop/evidence/criterion-7-kill-recovery.json` |

Evidence for each lives in `.sch-loop/evidence/` and `.sch-loop/events.jsonl`.

### Still not proven

- **One language, one runtime.** Two projects now, but both Node with `npm test`: no build step, no
  dependencies to install, no compiled language. Every timeout and prompt is tuned against that shape.
- **A package install has never been needed.** `destructive-bash` makes one a `human` ticket by design,
  which is right, but that path has not been walked end to end.
- **The council has convened once.** Three seats, one of them absent. Its cost and its failure modes
  rest on a single sample.

### Settled since

- The front half runs. `.sch-loop/{BRAINSTORM,PRD,ARCHITECTURE,PLAN}.md` are produced by
  `cli.mjs stage <id>`, each validated for substance rather than existence, and `plan-to-tickets` turns
  the plan into the queue with every ticket validated as it is written.
- Herdr delivers. A real pane received a notification, and every notification is also written to
  `.sch-loop/notifications.jsonl` so it survives whether or not a transport exists.
- `sch-setup` installs a project that runs: engine, both fences, skills, and a self-check that exits
  non-zero if any of it is missing.
- The roles dashboard exists: `cli.mjs dashboard`, one loopback page, one file written.
- The engine lives once, in `../engine/`. Everything under this lab's `.claude/` is installed from it
  and gitignored.

## The recovery ladder

| Tier | Trigger | What happens | Where |
|---|---|---|---|
| 0 | no output | nudge | `spawn.mjs` silence watch |
| 1 | crash, timeout, loop | `attempt++`, respawn fresh with the failure note | `self-correct.mjs` |
| 2 | rate limit, overloaded | back off 1→2→4→8 min, attempt unchanged | `watchdog.mjs` |
| 3 | attempts exhausted | `[!]`, council convenes, re-dispatch ONCE with its verdict | `escalate.mjs` |
| 4 | council skipped, failed, or a second red | `[?]`, notify, move to the next unblocked ticket | `escalate.mjs` |

A council survives a seat that cannot answer: an installed-but-logged-out CLI costs its own seat, and the debate continues as long as two seats remain.

## Todo API

`add(title, priority)` creates an item; `priority` accepts `low`, `normal` or `high`.
Omit it and the priority defaults to `normal`; any other value throws.
