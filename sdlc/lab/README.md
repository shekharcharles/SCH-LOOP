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

1. `go` routes brainstorm → PRD → architecture → plan → tickets without anyone naming a skill.
2. Three tickets built by the executor pane: one `build`, one `test`, one `human`.
3. A ticket inserted mid-run (`T1.2a-…`) is picked before `T1.3`.
4. One ticket forced red three times reaches `[!]`, council convenes, verdict re-dispatches it.
5. Reviewer and judge never write a file (hooks + `--disallowedTools` both hold).
6. Phase verify passes goal-backward; `sch-ship` opens a PR into this lab.
7. Executor killed mid-ticket → watchdog respawns with the failure note, `attempt` increments once.

Evidence for each lives in `.sch-loop/evidence/` and `.sch-loop/events.jsonl`.

## Not yet implemented (stubs in `.claude/skills/`)

`sch-setup`, `sch-prd`, `sch-architecture`, `sch-insert`, `sch-run`/watchdog, `task.md` parser, role config loading, Herdr transport. Build order in the design doc §7.

## Todo API

`add(title, priority)` creates an item; `priority` accepts `low`, `normal` or `high`.
Omit it and the priority defaults to `normal`; any other value throws.
