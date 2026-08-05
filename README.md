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
scripts/worktree.mjs      The disposable per-task worktree: a worker gets its own checkout on
                          its own `sch/task-<n>` branch, outside the repository and outside
                          SCH_HOME, created once and reused (never recreated) across retries.
scripts/candidate.mjs     The delivery candidate: every changed path as CONTENT identity
                          (porcelain v2 + blob hashes), canonical hashing, and the git
                          argv guard that refuses add -A / commit -a / force / reset --hard.
scripts/delivery.mjs      The fail-closed Git transaction controller — the ONLY component
                          allowed to stage, commit or push a managed project. Diff binding,
                          approval, explicit staging, secret gate, commit, divergence, push,
                          independent remote verification, task completion.
scripts/sch-deliver-run.mjs  CLI for one delivery: --project <id> --run <RUN-id>. One run,
                          one commit, then stop.
scripts/executor.mjs      Provider-neutral AgentExecutor + ClaudeCliExecutor: a fresh
                          external worker process, allowlisted environment, SCH-owned
                          timeout/cancel, process-tree kill, bounded output.
scripts/runner.mjs        The supervised single-task orchestrator: preflight, lease,
                          baseline, prompt compilation, handoff parsing, ACTUAL git-effect
                          inspection, deterministic verification, outcome, run events.
scripts/sch-run-task.mjs  CLI for one supervised run: --project <id> --task <n>. One task,
                          one attempt, then stop. Never stages, commits or pushes.
scripts/taskgraph.mjs     The project task graph: typed dependency reasons, the false-edge
                          audit, hidden dependencies (shared paths / control files / schema),
                          cycle + self + duplicate detection, readiness with its blockers.
scripts/transitions.mjs   The CLOSED task-state machine: 14 states, one authorised actor per
                          edge, expected-version (optimistic) concurrency, the documented
                          legacy↔canonical map, and the audit record of every move.
scripts/envelopes.mjs     The typed envelope registry (7 types) that crosses every phase
                          boundary: exactly one block, identity-checked, bounded, enum-checked,
                          with an adapter for the previous milestone's worker handoff.
scripts/gates.mjs         The named gate registry. Every gate returns a REPORT — what it
                          checked, whether each item passed, its evidence, a stable hash.
                          FACTUAL gates are overridable by nobody; POLICY gates by a person.
scripts/phases.mjs        The phase engine: HUMAN / AGENT / CODE / GATE, the default-fail
                          lifecycle (PENDING→RUNNING→EXECUTED→REPORTED→GATED→ACCEPTED),
                          per-phase persistence + restart recovery, and the agent-role roster.
scripts/humangates.mjs    Typed human decisions (12 kinds) bound to project/task/run/attempt/
                          phase/state-version/proposal hash/diff hash, with expiry and
                          automatic invalidation when the thing being approved moves.
scripts/scheduler.mjs     The SEQUENTIAL graph scheduler: project lease, graph validation,
                          one ready task at a time, the 16-phase task workflow, bounded
                          retries with compact repair context, delivery through the existing
                          controller, typed stop reasons, deterministic project completion.
scripts/sch-run-queue.mjs CLI for the queue: --project <id> [--max-tasks --max-duration-ms
                          --phase --stop-after-task --dry-run]. One task at a time, then stop.
scripts/projection.mjs    The SQLite operational PROJECTION (node:sqlite, no dependency) for
                          the dashboard: migrations, WAL, idempotent event projection,
                          bounded text, rebuildable. Never the authority.
scripts/workflows.mjs     The versioned workflow-template registry: 9 templates over a CLOSED
                          handler registry. Project data names a handler id, never a module;
                          unknown handler/role/gate/envelope fails closed; a template can
                          never grant a tool or widen a write scope.
scripts/semantic.mjs      The CLOSED registry of EXECUTABLE semantic AGENT phases (scout, plan,
                          implement, repair, review, document). Each declares its role, effect
                          policy, envelope and gates. A template may declare a semantic phase
                          only if a handler exists — otherwise the template is REJECTED, never
                          recorded as "absent".
scripts/roles.mjs         The versioned agent-role roster (scout, planner, builder, repairer,
                          reviewer, documenter) and the logical model profiles. Role, executor,
                          provider, model, tools and write scope are six separate things, and a
                          selected skill can widen none of them.
scripts/usage.mjs         Usage, cost and latency — where UNKNOWN IS NOT ZERO. Versioned, dated
                          pricing tables that ship no unverified rates; characters recorded
                          separately from tokens and labelled as characters.
scripts/evidence.mjs      Selective evidence compaction: a passing check contributes ZERO log
                          characters to any prompt, a failing one contributes bounded excerpts
                          kept from the END of the log. Every omission is recorded.
scripts/procedures.mjs    The lazy-loaded, hashed operational procedure registry. A phase gets
                          the procedure for what it is doing, never the manual — and a
                          procedure can never grant authority.
scripts/skillsources.mjs  Governed EXTERNAL skill sources: full-commit pinning, operator-only
                          sync, file/script/hook inventory, explainable risk classification,
                          static quality gate, conflict detection against SCH's own machinery,
                          and hash-bound, ROLE-SCOPED approval whose default is nothing.
scripts/subprocess.mjs    The ONE bounded subprocess implementation: argv only (no shell),
                          explicit environment, bounded output, timeout, cancellation, and
                          process-TREE termination. Timeout is the MINIMUM of every bound.
scripts/suitelock.mjs     The full-test-suite lease — one complete suite at a time, with a
                          visible holder and safe stale recovery.
scripts/sch-test.mjs      Runs the suite under that lease with a heartbeat and an explicit
                          outer timeout: `--focused`, `--status`, `--release`.
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
task-set --verify-json '[{"id":"unit","exe":"npm","args":["test"],"cwd":".","timeout_ms":600000}]'
task-set --control-category decisions        (the ONE .sch-loop/ category a task may write)
workspace-init | workspace-status                    (the per-project .sch-loop/ workspace)
run-list [--limit n] | run-get --run <RUN-id> | run-cancel --run <RUN-id>
handoff-promote --run <RUN-id>                 (raw run handoff → the durable record)
delivery-status --run <RUN-id> | delivery-list | delivery-cancel --run <RUN-id>
delivery-approve --run <RUN-id> --approver <name> [--message "..."] [--reject true]
delivery-branch-namespace --project <id> [--set "sch/task-*" --approver <you>] [--revoke true]
sch-run-task.mjs --project <id> --task <n> [--preflight-only]   (one supervised run)
sch-deliver-run.mjs --project <id> --run <RUN-id> [--dry-run]   (one Git delivery)
graph-validate | graph-show [--format markdown]      (the task graph + false-edge audit)
task-set --dep-reason "8:DATA_DEPENDENCY:api_contract"     (why this task waits for that one)
task-set --retry-policy '{"max_attempts":3,"max_repairs_per_attempt":1}'
task-set --approval-policy '{...}' | --budgets '{...}' | --dependency-policy '{"allow_cancelled":true}'
task-set --executor-role builder | --verifier-role reviewer
task-transition --task <n> --event <release|requeue|block|need_decision|fail|cancel|supersede>
                [--expect-version <v>]               (the CLOSED state machine; never a destination)
task-states                                          (canonical state of every task)
scheduler-status | scheduler-list | scheduler-cancel --scheduler <SCHED-id>
phase-list --task <n> | gate-report --task <n> [--gate <id>]
human-gate-list [--all true] | human-gate-show --gate <id>
human-gate-open --type <TYPE> --question "..." [--task <n>]
human-gate-decide --gate <id> --decision APPROVED|REJECTED --approver <name>
projection-status [--rebuild true]                   (the SQLite operational projection)
sch-run-queue.mjs --project <id> [--max-tasks n --max-duration-ms n --phase n
                 --stop-after-task n --dry-run --quiet]        (the sequential queue)
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
the **supervised external single-task runner** · the **fail-closed Git delivery
controller** · the **sequential graph scheduler** below: a first-class task graph
with typed dependency reasons, a closed task-state machine, an SSSF-style phase
engine with typed envelopes and named gates, bounded retries, typed human
decision gates, a SQLite operational projection and deterministic project
completion.

### Planned, and NOT implemented

Parallel execution in Git worktrees · fan-out / fan-in and integration joins ·
path-ownership leases · OS-level worker sandboxing · authenticated dashboard
writes · a full SCH MCP · automatic knowledge ingestion · distributed workers ·
Temporal (evaluation only) · migrating state authority into SQLite. The queue
scheduler runs **one task at a time**, in the current working tree, and stops at
a defined terminal condition. Nothing here is unattended-safe yet: see
[Worker containment](#worker-containment-what-is-not-true-yet).

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

**`.sch-loop/` is control state, and workers are default-denied from all of it.**
A task may name at most **one** durable category it is authorized to write
(`--control-category decisions`); everything else under `.sch-loop/` is refused
however broad the allow-list is, and `project.yaml`, `runs/`, `locks/` and the
other runtime directories are refused under every category. Only the *ignored
runtime* paths are exempt from the clean-tree gate — an uncommitted `SPEC.md`,
`PLAN.md`, task, decision or promoted handoff blocks a run like any other file.
A run's raw handoff stays at `.sch-loop/runs/<run-id>/handoff.md`; promotion into
the durable `.sch-loop/handoffs/` is a separate act (`handoff-promote`, and
automatically on delivery). Verification commands are stored structured —
`{id, exe, args[], cwd, timeout_ms}` — so an argument may contain a space;
`--verify "npm test"` is shorthand that compiles into that shape.

## 🚚 Fail-closed Git transaction controller

```bash
node scripts/sch-deliver-run.mjs   --project <id> --run <RUN-id>   # stops for approval
node scripts/state.mjs delivery-approve --project <id> --run <RUN-id> --approver <you>
node scripts/sch-deliver-run.mjs   --project <id> --run <RUN-id>   # commits and pushes
```

The **only** component in SCH allowed to stage, commit or push a managed project.
It takes one `VERIFIED` run and stops after one commit. It runs no worker,
selects no task, retries nothing, and never merges, rebases, cherry-picks,
amends, resets, reverts or force-pushes — those argv shapes are refused by
`assertSafeGitArgs` on **every** git call, and every invocation is recorded so a
test can prove what was not run.

**Verified-diff binding.** `VERIFIED` alone does not make a run deliverable. When
verification passes, the runner records `delivery-candidate.json`: every changed
path as *content identity* (blob hash, status, rename source, modes) plus the
verification evidence, hashed into `verified_diff_hash`, `verified_effects_hash`
and `verification_evidence_hash`. The controller recomputes all three immediately
before staging. Any drift — edited content, an added or deleted file, a rename, a
mode change, a moved HEAD, a changed branch, different verification evidence —
is `VERIFIED_DIFF_CHANGED`, and nothing is staged.

**Approval is required by default**, before the commit and again before the push.
An approval is a signature over the *specific* candidate (delivery, run, baseline
HEAD, branch, diff hash, evidence hash, commit message, remote, upstream) with an
expiry and a named approver. Change any of those and it becomes `INVALIDATED`:
yesterday's yes never authorizes today's different diff. The worker cannot
approve anything.

**Explicit staging.** `git add -- <exact verified pathspecs>`, always after `--`,
so a filename with spaces is one argument and one beginning with `-` is a
filename. Modifications, additions, deletions and renames are all handled. Then
the index is proved against the candidate by blob identity — staged paths must
equal approved paths exactly, staged content must equal verified content, nothing
approved may remain unstaged, and an index that already held someone else's work
blocks the delivery outright. On mismatch only the paths *this* transaction
staged are unstaged; working-tree content is never touched. Then the existing
secret gate runs against the exact staged content, and a failure unstages and
stops.

**Commit, divergence, push, remote verification.** One commit, message built from
trusted task data (AI co-author and session trailers refused), delivered on stdin
so it can never be read as an option. Post-commit the tree is proved again: one
parent, the verified baseline, exactly the approved blobs — and a mismatch is
`NEEDS_DECISION` with the commit left **unamended and unreset**. Then a fetch,
and hard gates: any incoming commit, any divergence, anything other than exactly
one outgoing commit, a missing or moved remote branch, a changed remote or
upstream, or a credential-bearing remote URL all stop the push. The push is an
explicit refspec. Afterwards SCH **fetches again and asks the remote** — push
stdout is the pushing process describing its own success and is never accepted as
proof; the commit's tree and parent are re-checked against what was committed.

**Only then** does the task become `delivered` — a new terminal status distinct
from `merged` (which means the in-session loop finished it *locally* and was
never pushed). `delivered` is unreachable from `task-set`; only the controller
sets it, with the commit, branch, remote, pushed range and verification time
attached. Every delivery is a transaction under `.sch-loop/runs/<run-id>/delivery/`
with append-only, fail-closed events and a read-only dashboard projection at
`/api/deliveries`. **Delivery and approval are operator authority and stay on the
CLI: they must not be exposed remotely until the dashboard has authentication,
which it does not have.**

## 🧮 Sequential graph scheduler

```bash
node scripts/state.mjs graph-validate  --project <id>     # structure + false-edge audit
node scripts/state.mjs graph-show      --project <id> [--format markdown]
node scripts/sch-run-queue.mjs         --project <id>     # run the queue, then stop
node scripts/sch-run-queue.mjs         --project <id> --max-tasks 3 --dry-run
node scripts/state.mjs scheduler-status --project <id>
node scripts/state.mjs human-gate-list  --project <id>
node scripts/state.mjs human-gate-decide --project <id> --gate <HG-id> \
     --decision APPROVED --approver <you>
```

The architectural invariant, and everything below is a consequence of it:

```text
Code owns the graph.
Agents own bounded semantic phases.
Typed envelopes cross phase boundaries.
Named gates define acceptance.
```

The model does not choose what runs next, does not decide whether a phase
passed, does not count its own retries, cannot authorise its own delivery and
cannot declare a project finished. It plans and implements inside one approved
task and hands back one typed envelope, which is then graded against evidence
SCH gathered itself.

**The task graph.** `deps` is still a list of task ids, and it now carries a
REASON: `--dep-reason "8:DATA_DEPENDENCY:api_contract"`, one of `DATA_DEPENDENCY`,
`SCHEMA_DEPENDENCY`, `FILE_CONFLICT`, `APPROVAL_DEPENDENCY`,
`ENVIRONMENT_DEPENDENCY`, `INTEGRATION_DEPENDENCY`, `ORDERING_POLICY`.
`graph-validate` refuses self-dependencies, duplicates, missing tasks, cycles,
dependencies on cancelled tasks (unless `dependencyPolicy.allow_cancelled` says
so) and unknown reason types. Separately it **audits** every edge — *does the
downstream task consume an actual output, resource, schema, approval or protected
ordering requirement?* — and an edge nobody can defend is reported as
`FALSE_EDGE_SUSPECTED` and **never deleted**: it is a plan a person wrote.
**Hidden dependencies** are computed, not stored: two tasks whose path policies
overlap, or which share a control file (`package.json`, lockfiles, `tsconfig`,
`Dockerfile`…), a schema/migration prefix or an SCH control category are ordered
whether or not anyone said so — they block readiness while the other task is in
flight, and are shown as `hidden_edges` rather than written into the graph.

**Closed task states.** `BACKLOG READY CLAIMED RUNNING VERIFYING RETRYABLE
AWAITING_DELIVERY DELIVERING NEEDS_DECISION BLOCKED FAILED DELIVERED CANCELLED
SUPERSEDED`. Each edge names exactly one authorised actor — scheduler, runner,
verifier, delivery, retry, human-gate, operator — and **a model is not on that
list at all**. Every move records previous state, new state, actor, reason,
project, task, run, attempt, state version, timestamp and causation, and an
`--expect-version` mismatch is refused so a stale process cannot overwrite newer
state. Historical statuses keep working through a documented map: `queued→READY`,
`building→RUNNING`, `review→VERIFYING`, `changes→RETRYABLE`,
**`merged→AWAITING_DELIVERY`** (it meant *finished locally, never pushed* — calling
it DELIVERED would claim a remote it never reached), `delivered→DELIVERED`,
`blocked→NEEDS_DECISION`, `stuck→FAILED`, `superseded→SUPERSEDED`. Nothing
historical is rewritten: a task with no canonical state is *read* through the map
and gains one the first time something legitimately moves it.
`task-set --status` still speaks the legacy vocabulary, but it now goes through
the transition service — it refuses a canonical state name, refuses
`delivered`, and records what it did (including, when the closed machine would
have refused the move, that refusal beside it).

**Phases.** Sixteen of them per task, each `HUMAN`, `AGENT`, `CODE` or `GATE`:

```text
prepare CODE · task-readiness GATE · compile-context CODE · implement AGENT
parse-builder-envelope CODE · inspect-effects CODE · effects-gate GATE
verify CODE · verification-gate GATE · semantic-review AGENT · review-gate GATE
prepare-delivery CODE · delivery-approval HUMAN · deliver CODE
remote-verification GATE · complete-task CODE
```

Every phase begins **unaccepted** and moves `PENDING → RUNNING → EXECUTED →
REPORTED → GATED → ACCEPTED`. `EXECUTED` means the process returned — that is all
a zero exit code has ever meant. `REPORTED` needs a valid, typed,
identity-checked envelope; `GATED` needs every required gate to have actually
run; `ACCEPTED` needs every one of them to have passed. A phase cannot skip a
checkpoint or move backwards, and each one is persisted, so a scheduler that
died between two phases is told exactly where it was instead of guessing.
Deterministic work is a `CODE` phase — an agent is never used for something a
function can do.

**Typed envelopes.** `PlannerEnvelopeV1 BuilderEnvelopeV1 ReviewerEnvelopeV1
DecisionRequestEnvelopeV1 CodeResultEnvelopeV1 GateReportEnvelopeV1
DeliveryEnvelopeV1`, sharing one base. Exactly one block, a known schema and
type, the right project/task/run/phase/attempt, bounded strings and arrays,
checked enums, artifact references that cannot absolutise or escape, and **no
field nothing validates** — an unvalidated field is where an instruction hides.
The previous milestone's worker handoff is adapted into `BuilderEnvelopeV1`, so
a worker built against the old contract still works. The invariant throughout:

```text
Envelope claims are not system evidence.
```

**Named gates.** `project-workspace-valid · task-ready · dependency-graph-valid ·
skills-approved · executor-ready · prompt-budget-valid · handoff-valid ·
worker-effects-contained · changed-paths-allowed · forbidden-git-effects-absent ·
required-verification-passed · secret-scan-passed · verified-diff-unchanged ·
delivery-approval-valid · outgoing-commit-safe · remote-commit-present ·
task-completion-valid · project-completion-valid`. Each returns a report: every
item checked, whether it passed, its evidence, and a stable `evidence_hash` — never
a bare boolean. A gate with no evidence to read **fails**; it never quietly
skips. `FACTUAL` gates state something about the repository or the remote and are
overridable by **nobody** — not an agent, not the operator, because the way past
"a secret is present" is to remove the secret. `POLICY` gates may be overridden
by a person, on the record, with a reason.

**Retries are bounded and classified.** `AGENT_TIMEOUT`, `PROCESS_TRANSIENT`, a
transient process failure, and a verification/lint/format failure *within the
task's repair budget* are retryable. `PATH_SCOPE_VIOLATION`, `SECRET_DETECTED`,
`FORBIDDEN_GIT_EFFECT`, `VERIFIED_DIFF_CHANGED`, `UNRELATED_OUTGOING_COMMITS`,
`REMOTE_CHANGED`, `POLICY_VIOLATION` and anything requiring a schema, dependency
or public-API decision are not — those are resolved by changing the world.
An unclassified code fails closed. A retry is a **new attempt in a fresh
process**; the previous attempt's directory is never overwritten, and the change
it left in the working tree is carried forward and named explicitly rather than
discarded — SCH does not throw away a worker's unapproved work to manufacture a
clean tree. A repair receives only: the task, its criteria, its path policy, the
previous attempt's summary, the failed gate reports, the relevant command output
and the current diff summary — recorded, counted, and capped. Never a transcript,
never every previous run, never the whole learning file.

**Human gates.** `ARCHITECTURE_DECISION AUTHORIZATION_POLICY DEPENDENCY_CHANGE
SCHEMA_CHANGE MIGRATION_CHANGE PUBLIC_API_BREAK SCOPE_EXPANSION
DESTRUCTIVE_ACTION UNRELATED_FAILURE AMBIGUOUS_EVIDENCE BUDGET_INCREASE
DELIVERY_APPROVAL`. A decision binds to project, task, run, attempt, phase, state
version, proposal hash and — where the repository is involved — diff hash, with
an expiry and a named approver. Change the proposal or the diff and it becomes
`INVALIDATED`. The queue **stops** while one is pending and resumes when it is
answered, continuing the attempt that was parked rather than running its worker a
second time. The same answer signs the delivery transaction, so the operator is
never asked twice in two vocabularies. Deciding is CLI-only; the dashboard shows
them and prints the command.

**Stop conditions**, all typed: `PROJECT_COMPLETED PHASE_COMPLETED NO_READY_TASK
NEEDS_DECISION BLOCKED FAILED CANCELLED MAX_TASKS_REACHED MAX_DURATION_REACHED
PROJECT_BUDGET_EXCEEDED CONSECUTIVE_FAILURE_LIMIT SCHEDULER_LEASE_LOST
POLICY_VIOLATION STOP_AFTER_TASK DRY_RUN`. "Nothing is ready" is further split
into `PROJECT_COMPLETE`, `GRAPH_DEADLOCK`, `BLOCKED_DEPENDENCIES`,
`AWAITING_APPROVAL` and `INVALID_GRAPH` — a finished project and a deadlock must
never look the same. **Completion is a gate, not an inference:** every required
task delivered/cancelled/superseded, no unresolved human gate, no blocked
required task, no active run/delivery/scheduler lease, and graph validation
passing — each clause reported with its evidence.

**Every task still** uses a fresh worker process, produces its own independent
verification, binds delivery to the verified candidate, requires the configured
approvals, pushes only through the delivery controller above, and becomes
`DELIVERED` only after that controller has proved the commit on the remote with
its own fetch. One task at a time; the next is claimed only once the previous
one's commit is actually on the remote.

**Observability.** Versioned scheduler events (`scheduler.*`) with event id,
timestamp, project, scheduler run, task, attempt, phase, actor, causation,
correlation and a **bounded** payload — worker output stays on disk and is
referenced. A SQLite operational **projection** (`node:sqlite`, no dependency)
under `SCH_HOME/projects/<id>/ops.db` — migrations, WAL, idempotent event
projection, bounded text, indexes — feeds read-only dashboard APIs
(`/api/task-graph`, `/api/scheduler`, `/api/phases`, `/api/gates`,
`/api/human-gates`, `/api/completion`, `/api/operations`, `/api/workflow`). It is
a projection, never the authority: delete it and `projection-status --rebuild
true` re-derives it from SCH state. Per-phase accounting is in **characters and
bytes** and says so — nothing here has a tokenizer, and a number labelled
"tokens" that came from dividing characters by four is not a measurement.

**Legacy `/sch-run`.** The in-session prompt-driven loop still exists and still
works, and it is now explicitly the *legacy* path. It cannot set controller-only
states, cannot name a canonical state, and — while a scheduler holds the
project's lease — cannot change task status at all (`task-set` refuses and names
the scheduler). Its status writes go through the same transition service and are
recorded. Use `/sch-run` for supervised in-session work; use
`sch-run-queue.mjs` when the queue should execute itself.

### Worker containment: what is not true yet

Stated plainly, because a false claim here is worse than a missing feature:

- **Workers are not OS-sandboxed.** They run as your user, in your repository,
  with your PATH. The environment is allowlisted, `SCH_HOME` is withheld, the
  process is timed out and tree-killed, `.sch-loop/` is default-denied and every
  effect is inspected afterwards — but none of that is a sandbox.
- **Post-run effect inspection cannot see everything.** It compares the
  repository before and after. A write outside the repository, a network call, or
  a background process that outlives the run is not visible to it.
- **Git credentials remain reachable.** A malicious worker running as you could
  use your configured credential helper directly. SCH refuses to push except
  through the delivery controller; it cannot stop the operating system.
- **Therefore: fully unattended operation is not supported.** Run the queue
  where you can see it, keep delivery approval on, and treat every task's path
  policy as the real boundary. **OS-level worker containment is the critical
  next milestone.**

## 🏭 Reusable workflows, roles, observability and governed external skills

```bash
node scripts/state.mjs workflow-template-list                    # the 9 templates
node scripts/state.mjs task-set <n> --project <id> --workflow PLAN_BUILD_TEST
node scripts/state.mjs role-resolve --project <id> --role builder --task <n>
node scripts/state.mjs workflow-trace --project <id> --task <n>  # every phase + actor lane
node scripts/state.mjs usage-show --project <id>                 # UNKNOWN stays UNKNOWN
node scripts/sch-test.mjs                                        # one full suite, under a lease
```

**Workflow templates.** The scheduler used to run one workflow, hardcoded twice —
a 16-entry array *and* sixteen hand-written call sites, so editing the array
changed nothing. There are now nine versioned templates: `SCOUT`, `PLAN_ONLY`,
`BUILD_ONLY`, `PLAN_BUILD`, `PLAN_BUILD_TEST`, `BUILD_REVIEW`, `FULL_SDLC`,
`SECURITY_REVIEW`, `DOCUMENTATION_ONLY`. Selection precedence is **task override
→ task-type project policy → project default → system default**, and the choice
is recorded on the task with the exact template id, version and hash.

A template is **data validated against closed registries**. It names a handler
id, never a module path; an unknown handler, role, gate or envelope fails closed.
A template **cannot** grant a tool, widen a write scope or weaken a task's path
policy — attempting it is a validation failure, not a silently dropped field.
Changing a template invalidates template-bound approvals on unfinished tasks.

> **The default is `FULL_SDLC`, not the "safer" non-delivering template.** A
> non-delivering default would silently stop delivering for every project that
> already exists. That is a regression wearing safety's clothes. Delivery inside
> `FULL_SDLC` is still gated by an approval a person gives.

**Roles, models and authority are six separate things.** `scout`, `planner`,
`builder`, `repairer`, `reviewer`, `documenter` — each a stable id with a
version, a *logical* model profile (`economical`, `workhorse`, `high-reasoning`,
`frontier-review`, `local-private`), a prompt template, a context policy, tools
and a write scope. Read-only roles are enforced in code, not documented. A
worker role's write scope is the **task's**, intersected — never the union. An
unavailable executor or model profile **fails preflight**; fallback to a cheaper
profile requires `modelPolicy.allow_fallback`, and fallback to another
*provider* requires a second, separate approval. `local-private` is declared and
deliberately unavailable, so asking for it fails rather than quietly using a
cloud model.

**A selected skill can never expand tools or write scope.** It is content, not
authority. `roles.mjs` enforces that by intersection and records what it refused.

**Prompt observability.** Every AGENT phase persists `system-prompt.txt`,
`user-prompt.txt`, `prompt-manifest.json`, `context-manifest.json`,
`agent-config.json` and `usage.json`. The manifest carries template/role/skill/
procedure ids **and hashes**, included, omitted and compacted sections, character
counts, and separate hashes for the system and user prompts. The context
manifest carries a hash per input — metadata, never a second copy of the prompt.
Credential-shaped values are redacted before anything is written. **Raw prompts
are local-only:** no dashboard API exposes one, and `/api/workflow-trace` says
`raw_prompts_available: false` in its own payload.

**Usage, cost and latency — where UNKNOWN is not zero.** The Claude CLI reports
no token counts to SCH, so `usage_status` is honestly `UNKNOWN` and every token
and cost field is `null` with a reason attached. Character counts are recorded
*beside* them and labelled as characters; nothing divides them by four and calls
the result tokens. Pricing tables are versioned and dated and **ship no rates**
this engine cannot verify — an estimate exists only where an operator configured
one, and every cost record carries the table version that produced it.
Aggregation sums what is known and **counts** what is not; a budget gate never
passes on an UNKNOWN.

**Selective evidence compaction.** A passing check contributes **zero** log
characters to any prompt — one line, an artifact reference and a hash. A failing
check contributes bounded excerpts kept from the **end** of the log, where the
failure is, plus a classification (`TEST_FAILURE`, `LINT_FAILURE`, `TIMEOUT`,
`UNCLASSIFIED`, …) and a sanitized argument vector. Limits are
`0 / 4000 / 8000 / 10 checks / 1 previous attempt`, and every omission is
recorded.

**One bounded subprocess implementation.** Workers and verification commands now
share `subprocess.mjs`: argv only (never a shell string), explicit environment,
bounded output, timeout, cancellation, **process-tree** termination
(`taskkill /T /F` on Windows, a process-group signal on POSIX) with cleanup
evidence, and a bounded post-kill wait so it can never sit on a pipe forever.
The effective timeout is the **minimum** of command, phase, task, scheduler and
operator bounds — a large default can no longer override a smaller ceiling.

**Governed external skill sources.** An external skill is somebody else's
instructions running in your agent, with your credentials, on your code. So:
sources are pinned to a **full 40-character commit** (a branch is a promise the
other end can rewrite after you read it); synchronisation is an **operator**
action a worker can never trigger; credential-bearing URLs, symlinks, path
escapes and uninspected submodules are refused; discovery grants **no** trust; a
static quality **PASS is not an approval**; approval binds to
`(source commit, content hash)` and lapses when either moves; approval is
**role-scoped with a default of nothing**; and push, deploy, scheduling and
worktree skills are **never** eligible for a worker role. Every skill is
inventoried (scripts, hooks, executables, network and environment references,
git and global-config capabilities) and given an **explainable** risk level with
its reasons, plus conflict detection against SCH's own scheduler and delivery
controller.

> The regex command guards here are **defence in depth, not a sandbox.** They
> make the obvious dangerous thing visible to a reviewer. A determined author
> evades them, and the answer to that is the reviewer.

**Test-suite discipline.** One complete suite at a time, per repository, under a
lease with a visible holder and safe stale recovery. A focused run is refused
while a full suite is live. `sch-test.mjs` prints a heartbeat every 30s and
enforces an explicit outer timeout — because a buffered, silent suite and a hung
one look identical, and that confusion once produced a wrong diagnosis and an
unnecessary rewrite.

### Every declared semantic phase executes

All six semantic handlers — `scout`, `plan`, `implement`, `repair`, `review`,
`document` — run a **real fresh external worker** through one shared path in
`semantic.mjs`. All nine templates execute the phases they declare, and
`workflow-template-validate` proves it (`every_declared_phase_executable: true`).
A template that declares an AGENT phase with no registered handler is **rejected
at validation**, not recorded as absent at run time.

The resolved role is the **execution authority**: it decides the prompt
template, the context policy, the expected envelope, the write scope and the
budgets, and the worker cannot widen any of them.

**Read-only means caught, not prevented.** The Claude CLI gives SCH no tool
sandbox — there is no API that stops a worker writing a file. So a read-only
role runs with an **empty allow-list** (the prompt authorizes nothing and says
so), and SCH inspects the repository afterwards: any change at all fails the
phase as `ROLE_POLICY_VIOLATION`, evidence preserved, nothing reverted. That is
enforcement after the fact, and it is named as such rather than dressed up as
isolation.

Completion is typed, so nothing claims a remote it never reached:
`READ_ONLY_COMPLETED` (scout, security review) · `PLAN_COMPLETED` (plan only) ·
`AWAITING_DELIVERY` (built and verified, not pushed) · `DELIVERED` (committed,
pushed and remotely verified) · `NEEDS_DECISION` · `FAILED`.

### What is still NOT wired, stated plainly

- The `repair` handler is registered and validated but shares the builder's call
  site; there is no separate repair phase in any built-in template yet.
- Role resolution is the execution authority, but only one executor exists — the
  Claude CLI. Per-phase model routing is configuration no second executor
  consumes yet, and the CLI does not accept a reasoning/model argument from SCH.
- Usage is `UNKNOWN` for every real run, because nothing reports it. That is the
  honest state, not a placeholder to be filled with zeros.
- The scheduler runs phases in a fixed canonical order; a template chooses WHICH
  phases run, not the order they run in.

## Rules that keep it safe
- If it's not in the PRD/SCOPE or a planned task, it doesn't exist.
- One task per pass (or a bounded parallel wave); fresh context each task.
- Re-verify live state before every completion; secret-scan before every commit.
- Offensive: no active tooling against an out-of-scope/unauthorized/expired target, ever.
