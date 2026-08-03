# SCH Loop

An autonomous, multi-domain **build + security** loop for Claude Code. You give a
requirement (a PRD, or a pentest CR + target); it plans small tasks, then runs a
self-directing loop that executes each task in a **fresh-context subagent**,
validates it, reviews it, commits it (secret-scanned), and repeats — while you
watch and steer from a live dashboard on your phone.

It runs **dev** (web/backend/tool) and **offensive** (web / API / mobile / red-team
/ network pentest) work through one engine, and grafts the best patterns from
gsd-core, superpowers, spec-kit, ecc, Karpathy, and Boris Cherny's Claude Code
playbook — without installing any of them (no context bloat).

> **You only ever type two things:** `/sch-spec` to start any work, and
> `/loop 45m /sch-run` to run it. Everything else — plan, execute, verify, review,
> secret-scan, commit, learn — happens automatically.

---

## ⚡ Install prompt (copy-paste into Claude Code)

Open Claude Code in any folder and paste this. It clones, wires up the skills,
starts the dashboard, and verifies — automatically:

```text
Set up SCH Loop from GitHub. Install it into my HOME directory (next to my
.claude config), and do this exactly:

1. Clone (private repo — use gh): `gh repo clone <OWNER>/SCH-LOOP ~/.claude/SCH-loop`.
   The engine home is `$HOME/.claude/SCH-loop` — the skills already reference that
   path, so nothing to edit.
2. Init the registry: `node ~/.claude/SCH-loop/scripts/state.mjs init`.
3. Install the skills globally: copy every folder in ~/.claude/SCH-loop/skills/
   into ~/.claude/skills/ (sch-spec, sch-plan, sch-run, sch-review, sch-ship, sch-learn).
4. Global context: ensure ~/.claude/SCH-loop/SCH-LOOP.md is imported by my global
   rules — add the line `@SCH-loop/SCH-LOOP.md` to ~/.claude/CLAUDE.md (create
   CLAUDE.md if absent). Do NOT run Claude's own /init — SCH Loop is self-sufficient.
5. Start the dashboard: `node ~/.claude/SCH-loop/scripts/dashboard.mjs` (background)
   → http://localhost:4600. On Windows, ~/.claude/SCH-loop/sch-dashboard.bat also
   gives start/stop + auto-start.
6. Run /reload-skills, confirm /skills lists the six sch-* skills, then tell me how
   to start my first project.

Never commit secrets, CLAUDE.md, or engagement data — the repo is tooling only.
```

(Replace `<OWNER>` with the GitHub owner. The repo is **private** — the installer
needs `gh` authenticated with read access. To share it publicly, first purge the
git history of any earlier engagement-data commits.)

## 🛠 Manual install

```bash
gh repo clone <OWNER>/SCH-LOOP ~/.claude/SCH-loop && cd ~/.claude/SCH-loop
node scripts/state.mjs init
cp -r skills/sch-* ~/.claude/skills/          # skills are path-portable ($HOME/.claude/SCH-loop)
echo '@SCH-loop/SCH-LOOP.md' >> ~/.claude/CLAUDE.md   # global pointer (self-sufficient; no /init needed)
node scripts/dashboard.mjs                     # → http://localhost:4600 (Tailscale-reachable)
# in Claude Code: /reload-skills  → confirm /skills shows the sch-* skills
```

**Where it lives:** your **home directory** — `$HOME/.claude/SCH-loop` — alongside
`.claude/`, not the Desktop. Portable across machines/users; no hardcoded paths.

---

## 🚀 Daily use

**Dev app (greenfield or existing):**
```
cd <project folder>
claude
/model sonnet                 # token-safe
/sch-spec                     # paste your requirement → it writes PRD + CLAUDE.md, plans small tasks
/clear                        # clean context
/loop 45m /sch-run            # runs; --project auto-detected from the folder
```

**Pentest CR (client on record):**
```
/sch-spec                     # "pentest <target>, CR-1234, shared via Teams" → arms + plans
/loop 45m /sch-run --project <cr>
```

Then steer from the **dashboard** (`localhost:4600`, or your Tailscale IP on
mobile): answer any question inline, add a feature/lead, bump priority, HALT.

---

## 🧠 How it works (the v3 loop)

```
spec        interview → PRD/SCOPE + consistency-check + auto CLAUDE.md (constitution)
plan        small, verifiable tasks (explicit files + a verify step)
── per task, in a FRESH-CONTEXT subagent (kills context rot + drift) ──
  ground    read the REAL code/markup; grep every usage before renaming anything
  test      TDD: test first
  build     ONE task only, minimal (Karpathy's 4); product decisions → inbox, never coded
  verify    run tests/lint/type — evidence, not claims
review      fresh-context, diff-scoped, two-stage + Definition-of-Done checklist
commit      secret-scan gate (unbypassable hook) → changelog → merge → push
learn       every correction → a rule in the project CLAUDE.md (never repeats)
throughput  independent tasks run as a parallel wave (worktrees, merged sequentially)
```

Grafted patterns: **gsd-core** (fresh-context execution), **superpowers** (TDD,
subagent review, systematic-debugging, worktrees, brainstorming), **spec-kit**
(consistency-check, constitution, DoD checklist), **ecc** (secret-scan + hooks),
**Karpathy** (4 coding principles), **Boris/Cherny** (CLAUDE.md auto-load +
compounding lessons).

---

## 📁 What each file does

```
scripts/state.mjs         Engine + CLI: multi-project registry, tasks, findings, scope gate,
                          standing authorizations, run-lock, pass-gate, audit log, skill gate.
scripts/skills.mjs        Skill registry: read-only discovery of installed skills (built-in, repo,
                          commands, plugins, global), content hashing, trust states, per-project
                          capability profile, execution modes, deterministic task→skill advice.
scripts/dashboard.mjs     Live (SSE) dashboard — project table + per-project control,
                          answer box, skill picker, filter; fluid, no flicker. Port 4600.
scripts/secret-scan.mjs   Blocks a commit if staged changes contain secrets/.env/keys/CLAUDE.md.
scripts/secret-scan-hook.mjs  PreToolUse hook — makes the secret gate UNBYPASSABLE on git commit/push.
scripts/report.mjs        Findings → CERT-In report (Markdown + print-to-PDF HTML). Refuses while a coverage cell is untested.
scripts/poc.mjs           Captures ONE reproducible PoC per finding (curl or a pasted exchange), tokens redacted.
scripts/verify-skills.mjs Proves (from the session transcript) which skills were actually used.
scripts/skills-used.mjs   Lists real skill invocations across sessions.
scripts/notify.mjs        Push a blocked-question / done notice to Slack/Teams/ntfy (SCH_NOTIFY_WEBHOOK).
scripts/dashboard-ctl.mjs Ref-counted auto start/stop of the dashboard, driven by Claude's
                          SessionStart/SessionEnd hooks (up on first session, down on the last).
scripts/sync-skills.mjs   Installs skills/ into ~/.claude/skills (where Claude Code loads them).
                          `--check` reports drift; validate fails if the installed copy is stale.
scripts/graph.mjs         Self-contained knowledge graph (node:sqlite, FTS5, no dependencies).
                          Symbols, endpoints, findings, decisions + the edges between them.
scripts/graph-mcp.mjs     MCP server over that graph (hand-written JSON-RPC, no SDK) so
                          Claude Code / Codex / OpenCode all query it the same way.
scripts/graph-index.mjs   Keeps the graph current AUTOMATICALLY — a PostToolUse hook indexes
                          every edited file; --all does a first full pass. No manual init, ever.
scripts/graph-seed.mjs    Loads what past tasks/commits/decisions already learned into the graph.
scripts/doctor.mjs        Checks what the repo DECLARES is actually WIRED on this machine:
                          hooks registered, skills installed, no second engine copy, projects
                          still exist. `--fix` installs what's missing (`npm run doctor`).
scripts/validate.mjs      Self-check: skill frontmatter, installed-skill drift, pack refs, README
                          accuracy, portability, gitignore of engagement data, safety contracts.
packs/packs.json + *.md   Per-domain methodology (app-dev, tool-dev, web/api/mobile/red-team/network).
knowledge/*.md            Self-learning knowledge base per pack.
skills/SCH                The `/SCH` command router — one surface, routes to the skill or engine
                          command that already does the work. `state.mjs sch-commands` is its table.
skills/sch-*              The loop skills: spec, brainstorm, plan, run, review, ship, learn.
docs/adr/*.md             Architecture records: what the design is, and what it is NOT yet.
docs/CLAUDE.template.md   Per-project rules template (auto-loaded by Claude every reply).
docs/settings.template.json  Per-project .claude/settings.json: pre-approved commands + hooks.
docs/new-client-onboarding.md  Add a pentest client + the authorization-email template.
sch-dashboard.bat / .vbs  Windows: interactive start/stop + enable/disable dashboard auto-start.
```

**Generated locally, never committed:** `projects.json` (registry),
`projects/<id>/state.json`, `authorizations/`, `logs/`, `reports/`. Engagement +
client data stays on your machine.

---

## 🔒 Safety

- **Secret-scan gate** (script + unbypassable PreToolUse hook): never commits
  API keys, `.env`, private keys, or `CLAUDE.md`.
- **Scope gate** (offensive): every active task re-checks the target against the
  client's signed authorization; out-of-scope / unauthorized / expired = refused,
  logged. Client findings/evidence stay local, never pushed.
- **Per-project settings** (`docs/settings.template.json`): pre-approve safe
  commands + auto-format after edits — safer than a blanket YOLO flag.

## 📋 Full CLI reference

```
init | stats --project <id> | pass-gate --project <id>
project-add | project-list | project-here | project-get --project <id>
auth-add | auth-list | auth-find --target <t> | auth-add-domain | cr-new ...
scope-get | scope-check | scope-set | scope-arm-from-auth   (offensive)
skills-set --project <id> --skills a|b | skills-get --project <id>
skill-discover | skill-list [--trust|--source|--capability] | skill-get <id> | skill-trust <id> --state APPROVED
profile-get | profile-set --mode <mode> [--task-type <t> --recommended a|b] | profile-validate   (all --project)
skill-recommend --project <id> [--task <n> | --type <t> --phase <n> --files a|b]
sch-commands [<name>]                                (the /SCH command table)
task-add | task-list [--status] | task-set <n> --status ... | task-next | task-answer   (all --project)
finding-add | finding-list | finding-set | chains   (offensive)
retest-new --from <src-project> [--id <new>]        (post-remediation re-verification)
provenance --ref <auth-ref>                          (who shared which asset, when, how)
inbox-add | inbox-list [--new] | inbox-mark
lock-acquire | lock-release | lock-status
```

## ✅ Development / self-check

```bash
npm run validate   # skills, packs, README accuracy, portability, safety contracts
npm test           # engine tests: scope gate, authorizations, queue, chains, secret-scan
npm run check      # both (what CI runs)
```
Requires **Node >= 20**. No dependencies.

## 🧭 `/SCH` — the command surface

One namespace, routed by `skills/SCH`: `/SCH` (status of the active project),
`status`, `project`, `spec`, `brainstorm`, `plan`, `skills`, `run`, `review`,
`learn`, `graph`, `pause`, `resume`, `stop`, `approve`, `dashboard`, `doctor`.
Case-insensitive; canonical spelling is `/SCH <name>`. The table is data —
`node scripts/state.mjs sch-commands` — so the router, the CLI and the dashboard
cannot drift apart. The two-command flow (`/sch-spec`, `/loop … /sch-run`) still
works unchanged.

**Skills are discovered, not typed.** `skill-discover` walks the built-in,
repo-local, `.claude/commands`, plugin-cache and user-global roots, reads each
`SKILL.md` **as text** (nothing is executed, no script named in metadata is
followed), hashes the body, and infers capabilities from explicit metadata, a
built-in adapter table (superpowers / GSD), then keywords — inference is flagged
incomplete rather than passed off as fact. Everything third-party lands
`UNREVIEWED`; approval is a human act, recorded against the exact content hash,
and an edited skill goes stale automatically. Per project, a **capability
profile** holds the execution mode (`SINGLE_TASK`, `SUPERVISED_PHASE`,
`AUTONOMOUS_PROJECT`, `PAUSED` — there is no unlimited mode) and the skills per
task type; `skill-recommend` answers "which skills for this task" with a reason
attached, and never selects an unreviewed, disabled or blocked skill for
autonomous use. A project without a profile keeps working on safe defaults.

### Implemented today

Unified `/SCH` routing contract · skill discovery + trust records · project
capability profiles · deterministic task→skill recommendation · execution-mode
configuration and validation · dashboard-readable capability state
(`/api/capabilities`) · the in-session loop (`/sch-run`) that has always existed.

### Planned, and NOT implemented

Autonomous execution driven from outside the session · fresh Claude worker
processes per task · a Git transaction controller · an authenticated dashboard ·
an SCH MCP · the structured learning database (see `docs/adr/0002`) · automatic
queue continuation · parallel worktrees · automatic commit and push. `/SCH run`
runs today's in-session loop; nothing here simulates the runner that does not
exist yet.

## Rules that keep it safe
- If it's not in the PRD/SCOPE or a planned task, it doesn't exist.
- One task per pass (or a bounded parallel wave); fresh context each task.
- Re-verify live state before every completion; secret-scan before every commit.
- Offensive: no active tooling against an out-of-scope/unauthorized/expired target, ever.
