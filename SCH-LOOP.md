# SCH Loop — autonomous build/pentest loop (present on this machine)

`SCH_HOME` = `$HOME/.claude/SCH-loop`. Engine CLI:
`node $HOME/.claude/SCH-loop/scripts/state.mjs <cmd>`. Dashboard:
http://localhost:4600 (Tailscale-reachable). Skills are installed globally
(`sch-spec`, `sch-plan`, `sch-run`, `sch-review`, `sch-ship`, `sch-learn`).

**Two commands run everything:** `/sch-spec` starts any work (dev PRD or pentest
CR); `/loop <interval> /sch-run` runs it (`--project` auto-detects from the
current folder). The detailed methodology lives in the skills — follow them,
don't re-derive.

**One surface:** `/SCH` routes the whole family (`status`, `project`, `spec`,
`brainstorm`, `plan`, `skills`, `run`, `review`, `learn`, `graph`, `pause`,
`resume`, `stop`, `approve`, `dashboard`, `doctor`) to the skill or engine
command that already does the work. Bare `/SCH` reports the active project's
status. The table is data: `state.mjs sch-commands`. Skills are **discovered**,
not typed — `state.mjs skill-recommend --project <id> --task <n>` says which to
use and why; an UNREVIEWED/DISABLED/BLOCKED skill is never selected for
autonomous use, and approval is a human act. Execution modes (`SINGLE_TASK`,
`SUPERVISED_PHASE`, `AUTONOMOUS_PROJECT`, `PAUSED`) are configuration only —
**the external autonomous runner does not exist yet**; `/SCH run` is today's
in-session loop.

**Interval:** ask the engine, don't guess —
`state.mjs interval-advice --project <id>` (also shown on the dashboard). A pass
**keeps working** after each task (up to 5 tasks / 25 min) instead of sleeping out
its interval, so the interval only decides how long a *stopped* loop waits.

**Editing a skill?** The repo is the source of truth but Claude Code loads
`~/.claude/skills`. After any change: `node $SCH_HOME/scripts/sync-skills.mjs`
(`npm run validate` fails on drift).

**Non-negotiables the loop must honor:**
- Each task executes in a **fresh-context subagent**, ONE task only — never wander
  off-task, never redesign the product; a discovered decision → a blocked task
  with the question, which surfaces on the dashboard.
- **Ground-truth before editing** — grep every usage before renaming a symbol/key/
  class; read the real markup before writing CSS/DOM.
- **Secret-scan before every commit:** `node $SCH_HOME/scripts/secret-scan.mjs`
  (exit 1 = blocked). **Never commit** secrets, `.env*`, keys, or `CLAUDE.md`.
- Each project has a contract — `PRD.md` (dev) or `SCOPE.md` (offensive). Read it,
  obey it. Its `NG-N` / RoE are absolute.
- **The operator is usually away with only the dashboard.** Never leave a question
  in terminal output alone, and never stop the cron or ask them to type something
  to resume.
- **Run the loop on Sonnet** (`/model sonnet`) to conserve tokens; Opus only for
  hard reasoning.
- Offensive work is scope-gated; client findings/evidence stay local, never pushed.

If a request is about running/monitoring/answering this loop, use the dashboard +
these skills; check claude-mem for prior loop state.
