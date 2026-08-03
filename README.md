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
scripts/workspace.mjs     The canonical per-project `.sch-loop/` workspace: init, versioned
                          manifest, path containment, symlink/junction refusal, narrow
                          runtime ignore rules (the durable record stays trackable).
scripts/executor.mjs      Provider-neutral AgentExecutor + ClaudeCliExecutor: a fresh
                          external worker process, allowlisted environment, SCH-owned
                          timeout/cancel, process-tree kill, bounded output.
scripts/runner.mjs        The supervised single-task orchestrator: preflight, lease,
                          baseline, prompt compilation, handoff parsing, ACTUAL git-effect
                          inspection, deterministic verification, outcome, run events.
scripts/sch-run-task.mjs  CLI for one supervised run: --project <id> --task <n>. One task,
                          one attempt, then stop. Never stages, commits or pushes.
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
task-add / task-set --allow "src/**|tests/**" --forbid "..." --verify "npm test"   (run policy)
workspace-init | workspace-status                    (the per-project .sch-loop/ workspace)
run-list [--limit n] | run-get --run <RUN-id> | run-cancel --run <RUN-id>
sch-run-task.mjs --project <id> --task <n> [--preflight-only]   (one supervised run)
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
(`/api/capabilities`) · the in-session loop (`/sch-run`) that has always existed ·
the **supervised external single-task runner** below.

### Planned, and NOT implemented

Automatic retry and repair · sequential queue continuation · an independent
semantic reviewer · a target-project Git transaction controller · automatic
commit, push and remote verification · dashboard authentication · a full SCH MCP ·
automatic knowledge ingestion · parallel Git worktrees · graph fan-out and joins ·
distributed workers · SQLite / event-sourced operational state. The runner below
is **one task, one attempt, then stop** — it never commits and never pushes.

## 🧪 Supervised external single-task runner

```bash
node scripts/state.mjs workspace-init --project <id>     # once per repository
node scripts/state.mjs task-set <n> --project <id> \
     --allow "src/**|tests/**" --forbid "src/generated/**" --verify "npm test"
node scripts/sch-run-task.mjs --project <id> --task <n>
```

One explicitly selected, pre-approved task runs in a **fresh external `claude`
process**. A new process per attempt IS the fresh-context guarantee — it is
structural, not a sentence in a prompt, and clearing a terminal is not a context
reset. The outer runner owns everything the worker must not: task selection,
eligibility, skill selection, prompt compilation, timeout, cancellation, process
cleanup, the task lease, effect inspection, verification, and the outcome. **The
worker cannot mark its own work verified.**

**`.sch-loop/` — the canonical per-project workspace** (exactly that spelling,
lowercase, at the repository root). Tracked when present: `project.yaml` (a
versioned manifest carrying `repository_root: .`, never a machine path), `SPEC.md`,
`PLAN.md`, `TASK-QUEUE.md`, `LEARNING.md`, `phases/`, `tasks/`, `decisions/`,
`handoffs/`. Ignored by default: `runs/`, `artifacts/`, `logs/`, `cache/`,
`locks/`, `tmp/` — raw prompts, stdout and evidence can contain anything. The
whole directory is **never** ignored wholesale. `workspace-init` is idempotent,
preserves existing planning files, and refuses a `.sch-loop` symlink/junction, a
conflicting manifest, a foreign project id, an unsupported schema, or a repository
that is not the registered root. A run **requires** an initialized workspace and
never creates one for you.

**State authority is unchanged.** `$SCH_HOME/projects/<id>/state.json` remains
operational truth (registration, task status, dependencies, execution mode, skill
profile, locks, run references, audit). `.sch-loop/` holds the portable record.
`SCH_HOME` is deliberately **not** in the worker's environment.

**Preflight fails closed** on 37 conditions — project, task, real repository path,
repository root, execution mode, task eligibility, dependency completion,
capability profile, skill approval and hash staleness, workspace + manifest,
branch and HEAD, a clean tree and index, merge/rebase/cherry-pick/revert/bisect in
progress, an existing lease or unresolved run, path policy, verification-command
safety, the Claude executable, and the timeout/prompt/output limits.

**Context is selected, not concatenated.** Only skills the recommendation engine
picked are loaded — never every installed skill, never an `UNREVIEWED`, `DISABLED`,
`BLOCKED` or stale-approval one — and each is recorded with its content hash and
the reason it was chosen. `prompt-manifest.json` accounts for every section **in
characters, not tokens** (there is no tokenizer, so there is no token count). Over
the limit, optional context is compacted and then dropped, in order, and recorded;
the safety kernel, task, acceptance criteria, allowed paths, forbidden paths and
required verification are never touched — if they alone exceed the limit the run
fails closed.

**Then SCH checks the repository itself.** The worker returns exactly one
delimited `SCH_HANDOFF_JSON` object — validated for delimiter count, JSON, schema
version, run/project/task identity, enum values, field and array sizes — and every
claim in it is treated as untrusted. What counts is `git-effects.json`: modified,
deleted, renamed and untracked paths, each normalized and containment-checked
(absolute paths, `..`, symlink/junction escapes and `.git/` refused; forbidden
rules applied before allowed ones); plus staged files, created commits, HEAD,
branch, remote, local-config and `.git` metadata changes. Any of those is a
`FORBIDDEN_GIT_EFFECT` — evidence preserved, **nothing reverted, nothing pushed**,
and a human decides.

**Verification is SCH's own process.** Commands come from trusted task data as an
executable plus arguments (never a shell string); shell interpreters, destructive
tools, shell metacharacters and any non-read-only `git` subcommand are refused
before a run starts. A worker's "tests passed" is recorded and changes nothing.

Outcomes: `VERIFIED` · `RETRYABLE` · `NEEDS_DECISION` · `FAILED` · `CANCELLED`.
**`VERIFIED` does not mean committed, pushed, delivered, or task-done** — this
milestone deliberately implements no target-project git writes at all. Runs are
readable after a restart (`run-list`, `run-get`, `/api/runs`), events are
append-only JSONL with a versioned vocabulary, and the human-readable handoff at
`.sch-loop/handoffs/<task>/<run>.md` keeps *worker reported*, *system observed*,
*system verified* and *system outcome* strictly apart.

**Platform honesty.** Process-tree cleanup uses `taskkill /T /F` on Windows and a
process-group signal on POSIX; a grandchild that detaches itself into a new
session escapes both, and nothing here claims otherwise. Both paths are tested.

## Rules that keep it safe
- If it's not in the PRD/SCOPE or a planned task, it doesn't exist.
- One task per pass (or a bounded parallel wave); fresh context each task.
- Re-verify live state before every completion; secret-scan before every commit.
- Offensive: no active tooling against an out-of-scope/unauthorized/expired target, ever.
