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
`SUPERVISED_PHASE`, `AUTONOMOUS_PROJECT`, `PAUSED`) are configuration; `/SCH run`
is today's in-session loop.

**Supervised external runner (one task, one attempt, then stop):**
`state.mjs workspace-init --project <id>` once per repository, then
`sch-run-task.mjs --project <id> --task <n>`. It runs the task in a **fresh
external `claude` process** — a new process IS the context reset; `/clear` and a
cleared terminal are not. SCH owns the timeout, the kill, the lease, the prompt,
the effect inspection and the verification; the worker cannot mark itself
verified. A task needs `--allow`, `--forbid` and `--verify` before it is eligible.
Evidence lands in `<repo>/.sch-loop/runs/<run-id>/` (ignored) with the readable
handoff at `.sch-loop/runs/<run-id>/handoff.md` (raw, ignored; promoted into
`.sch-loop/handoffs/` only on delivery or `handoff-promote`). `VERIFIED` means the
change is in policy and the required commands passed — **not** committed, **not**
pushed, and the task is **not** done.

`.sch-loop/` is SCH control state: a worker is **denied all of it** unless the
task names one durable category (`--control-category decisions`). Only the
ignored runtime dirs are exempt from the clean-tree gate — an uncommitted
`SPEC.md`, decision or promoted handoff blocks a run.

**Delivery (one run, one commit, then stop):**
`sch-deliver-run.mjs --project <id> --run <RUN-id>`. It is the only thing allowed
to stage, commit or push a managed project. It recomputes the verified content
hashes and refuses on any drift, requires an operator approval bound to that
exact diff/branch/remote/message, stages explicit pathspecs after `--`, runs the
secret gate on staged content, makes one commit, blocks on any incoming or
unrelated outgoing commit, pushes without force, then **fetches again and asks
the remote** before marking the task `delivered` (a terminal status distinct from
`merged`, unreachable from `task-set`). Approve with
`state.mjs delivery-approve --run <RUN-id> --approver <you>`. Sequential queue
continuation and automatic retry are the NEXT milestone and do not exist.

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
