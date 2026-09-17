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
| 1 | `go` routes brainstorm → PRD → architecture → plan → tickets without anyone naming a skill | **NOT MET** — never run. `lifecycle_stage` is still `BRAINSTORM`, there is no `BRAINSTORM.md`/`PRD.md`/`ARCHITECTURE.md`, and every ticket here was written by hand as a spec file |
| 2 | Three ticket types run: `build`, `test`, `human` (the human one spawns no executor) | partly — T1.1, T1.2, T1.3 all ran correctly, but as subprocesses of one terminal. No Herdr pane was ever opened |
| 3 | A ticket inserted mid-run (`T1.2a`) is picked before `T1.3` | met — queue order verified |
| 4 | One ticket forced red reaches `[!]`, the council convenes, its verdict re-dispatches it | met — T1.4a: `[!]` → 3 seats (one absent) → 7.6k verdict → re-dispatched carrying it |
| 5 | Reviewer and judge never write a file (hooks + `--disallowedTools` both hold) | met — a real reviewer seat in bypass mode answered "CANNOT — write was denied" |
| 6 | Phase verify passes goal-backward; `sch-ship` opens a PR into this lab | met — phase 2 verified 7/7 truths, `ship 2` opened PR #1 |
| 7 | Executor killed mid-ticket → respawn with the failure note, `attempt` increments once | met — `.sch-loop/evidence/criterion-7-kill-recovery.json` |

Evidence for each lives in `.sch-loop/evidence/` and `.sch-loop/events.jsonl`.

### Not proven, and honest about it

The per-ticket loop is real. The things around it are not yet.

- **The front half of the lifecycle has never run.** Brainstorm, PRD, architecture and plan exist as
  skills. No run has produced any of their artifacts. Every ticket in this lab was a hand-written spec.
- **Herdr has never been used.** `notifyOrchestrator` returns `{skipped: true}` when
  `SCH_ORCHESTRATOR_AGENT` is unset, and it was unset for every run here — so every notification this
  lab ever "sent" was a silent no-op. The orchestrator/executor-pane split is designed, not exercised.
- **`sch-setup` has never onboarded a project.** This lab's `CLAUDE.md` carries no managed block; it
  was written by hand. Setup has unit tests and no live run.
- **There is no dashboard.** `roles.json` makes models, flags and seats configurable — which was the
  point — but choosing them is still editing JSON.
- **One project, one language, one trivial shape.** A zero-dependency Node package with `npm test`. No
  build step, no compile errors, no dependencies, no framework. Every timeout and every prompt is tuned
  against that.
- **The engine exists twice.** `../engine/` is tracked, `.claude/sch/` is the working copy, and they are
  kept in step by hand with `cp`. Nothing enforces it.

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
