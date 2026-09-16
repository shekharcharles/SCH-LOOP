---
name: sch-setup
description: Use when onboarding a repository to SCH-LOOP, or when roles.json, the fence hooks, or the CLAUDE.md managed block need to be (re)written. User-invoked only.
---

# Setup

Onboard this project. Idempotent: an existing `task.md`, `config.md` or `roles.json` is left alone unless `--force` is passed. The CLAUDE.md managed block is replaced in place, never duplicated, and nothing outside the project is written.

## Run it

```sh
node "$CLAUDE_PROJECT_DIR/.claude/sch/runtime/cli.mjs" setup
```

Report back, in this order:

1. **Live seats** — which CLIs were found, with versions. Say plainly which council seats are disabled because their CLI is absent.
2. **Roles** — executor / reviewer / judge provider. Models are `null` (provider default) by design; the dashboard pins them.
3. **Written / skipped** — the file list the command returns.
4. **Fences** — run `cli.mjs fences` and state whether bypass mode is permitted yet.

## What it writes

| Path | Purpose |
|---|---|
| `.sch-loop/roles.json` | which CLI plays which role, and the exact argv. No model, no flag is hard-coded in engine code. |
| `.sch-loop/config.md` | retry caps, council mode, context limits, timeouts, protected paths |
| `.sch-loop/state.json` | lifecycle stage, current ticket, attempt |
| `task.md` | the empty queue |
| `.claude/hooks/{write-guard,destructive-bash}.mjs` | fences 2 and 3 |
| `.claude/settings.json` | registers those hooks (merged into an existing file, never replaced) |
| `CLAUDE.md` | the managed block between `SCH-LOOP:PROJECT:START/END` |
| `.gitignore` | `.sch-loop/private/`, `evidence/`, `heartbeat`, `events.jsonl`, `.worktrees/` |

## After setup

Say what the user must decide, then stop:

- Which model each role should use (`cli.mjs roles` shows the current argv; the dashboard Roles page edits it).
- Whether a webhook for phone notifications is wanted (`SCH_NOTIFY_WEBHOOK`).
- Which herdr agent id the executor should nudge (`SCH_ORCHESTRATOR_AGENT`).

Then route to `sch-brainstorm` — a project with no `BRAINSTORM.md` has nothing to plan.

## Rules

- Never run this against a project that already has a different lifecycle owner without saying so first.
- Never write to `~/.claude` from this skill. A global install is a separate, explicit decision.
- If no agent CLI is on PATH, the command refuses rather than seeding a roles file that cannot run. Report the refusal; do not invent a provider.
