# SCH Loop — autonomous build/pentest loop (present on this machine)

`SCH_HOME` = `$HOME/.claude/SCH-loop`. Engine CLI:
`node $HOME/.claude/SCH-loop/scripts/state.mjs <cmd>`. Dashboard:
http://localhost:4600 (Tailscale-reachable). Skills are installed globally
(`sch-spec`, `sch-plan`, `sch-run`, `sch-review`, `sch-ship`, `sch-learn`).

**Two commands run everything:** `/sch-spec` starts any work (dev PRD or pentest
CR); `/loop 45m /sch-run` runs it (one task per pass; `--project` auto-detects
from the current folder). The detailed methodology lives in the skills — follow
them, don't re-derive.

**Non-negotiables the loop must honor (v3):**
- Each task executes in a **fresh-context subagent**, ONE task only — never wander
  off-task, never redesign the product; a discovered decision → the inbox question.
- **Ground-truth before editing** — grep every usage before renaming a symbol/key/
  class; read the real markup before writing CSS/DOM.
- **Secret-scan before every commit:** `node $SCH_HOME/scripts/secret-scan.mjs`
  (exit 1 = blocked). **Never commit** secrets, `.env*`, keys, or `CLAUDE.md`.
- Each project has a `CONSTITUTION.md` (dev) or `SCOPE.md` (offensive) — read it,
  obey it.
- **Run the loop on Sonnet** (`/model sonnet`) to conserve tokens; Opus only for
  hard reasoning.
- Offensive work is scope-gated; client findings/evidence stay local, never pushed.

If a request is about running/monitoring/answering this loop, use the dashboard +
these skills; check claude-mem for prior loop state.
