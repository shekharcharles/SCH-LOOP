---
name: sch-run
description: The SCH Loop engine, one project per loop. One pass fully completes one task per its pack — build/execute, validate, review with fresh context, complete (merge or log finding), grow the queue, and deliver when done. Enforces the offensive scope gate. Designed for /loop; run as /loop 15m /sch-run --project <id>.
---

# SCH Loop — engine

> **Engine home (`SCH_HOME`):** `C:\Users\r00t\Desktop\loop\SCH-loop`. Every
> `node scripts/state.mjs …` command and every `packs/…` file below lives there.
> If your terminal is in another folder, use the absolute path, e.g.
> `node C:/Users/r00t/Desktop/loop/SCH-loop/scripts/state.mjs …`.
> **`--project` is optional** — if omitted it is auto-detected from the current
> folder (the registered project whose `path` contains your cwd). Check with
> `state.mjs project-here`.. Dev git ops run
> in the project's own `path`; state + packs always come from `SCH_HOME`.

One pass = one task carried to done, or one convergence round on a task in
review. Under `/loop /sch-run --project <id>` each interval runs this once for
that project. All durable state is in `state.json`; re-read every pass, trust
nothing from memory.

## 0. Load the pack

Resolve the project and its pack:

```bash
node scripts/state.mjs project-get --project <id>     # domain, path, scope
node scripts/state.mjs stats --project <id>
```

Read `packs/packs.json` for the domain → `kind`, `dispatch`, `validate`,
`complete`, `deliver`, `concurrency`, `scope_required`, `active_gating`, and
`packs/<method>.md` for the methodology. Everything below follows the pack.

**Load prior learning:** read `knowledge/<pack>.md` and apply its accumulated
techniques, target-class patterns, and false-positive filters to this pass. The
loop gets smarter each engagement because of this file.

## 0b. Take the run lock (FIRST action — prevents overlapping passes)

```bash
node scripts/state.mjs lock-acquire --project <id> --ttl 45
```

- Returns **`BUSY …`** → a previous pass is still working. **End this pass
  immediately, do nothing else.** This is why the loop interval does not matter:
  a short interval simply no-ops while work is in flight.
- Returns **`ACQUIRED`** → proceed. A lock older than its TTL is taken over
  automatically, so a crashed session never wedges the project.
- **Always release at the end of the pass** (success, blocked, or error):
  ```bash
  node scripts/state.mjs lock-release --project <id>
  ```
  Set `--ttl` longer than your longest expected task (default 45 min).

## 1. Inbox first (never skip)

```bash
node scripts/state.mjs inbox-list --project <id> --new
```

If any new ideas exist, invoke **`/sch-plan --project <id>`** to fold them into
the queue before doing work. This is the "I thought of / was told a new thing"
path — planned before executed.

## 2. Preflight + scope gate

- **Dev packs:** confirm the project `path` repo, `origin` reachable, and a clean
  tree (`git status --porcelain` empty). Dirty → log paths, end pass.
- **Offensive packs (`scope_required: true`):** read the gate.
  ```bash
  node scripts/state.mjs scope-get --project <id>
  ```
  If `authorized` is false or `halt` is true, **do not run any `active` task**.
  You may still run passive tasks (recon/static/report, `active:false`). If the
  only ready work is active and the gate is closed, end the pass and tell the
  user to arm/resume the gate.

## 3. Converge in-flight work before new work

```bash
node scripts/state.mjs task-list --project <id> --status changes
```

A task in `changes` → fix only the reviewer's must-fix findings, re-validate,
send back to review. Cap **2 fix rounds** per task; on the third set it `stuck`
and end the pass for a human.

## 4. Pick + claim

```bash
node scripts/state.mjs task-next --project <id>
```

`none` → skip to step 8 (deliver-check). Otherwise, **before touching an
`active` task, re-check scope**:

```bash
node scripts/state.mjs scope-check --project <id> --target "<task.target>"
```

If it returns anything but `IN-SCOPE`, do **not** execute it — set the task
`blocked` with the reason and end the pass. This is the hard safety gate: no
active tooling ever runs against an out-of-scope or unauthorized target.

Then claim: `task-set --project <id> <taskId> --status building --note claimed`.
Re-read it; if it changed under you, drop and re-pick.

## 5. Execute (per pack method)

Dispatch to the pack's installed skills — **use them, do not reinvent**.

**Actually invoke them.** Reading a skill's name in `packs/*.md` is NOT dispatch.
For each skill the task needs, call it with the **Skill tool** so the invocation
is recorded in the session transcript (that transcript is the audit trail —
`scripts/skills-used.mjs` verifies it). Then record what you used:
`task-set --skills "<skill1>|<skill2>"`. Claimed skills that never appear in the
transcript are a reporting failure — the two must match. If a task genuinely
needs no skill (trivial edit), record none rather than claiming one.

- **Dev/tool:** implement only this task's `AC-N`; `NG-N` binding; repo style.
- **Offensive:** run this phase's methodology from `packs/<method>.md`, against
  the task's in-scope `target` only, within the RoE (rate limits, window,
  no-destruction) recorded in the scope. Orchestrate with background sub-agents;
  for `sequential`/`sequential-device` packs run one active task at a time and
  never leave a device armed idle (arm → test → disarm).

If an objective is ambiguous, conflicts with an `NG`/RoE, or needs a human
decision, go to step 7-blocked. Never guess.

## 6. Validate → review → complete

**Validate** by the pack's `validate`:
- `playwright` (web/app-dev): launch app, drive the AC flow in a real browser
  (`mcp__playwright__*`), screenshot, check console/network. Fix + re-validate.
- `run-the-tool` (tool-dev): invoke the CLI/lib, assert output/exit code.
- `poc-evidence` (pentest): reproduce each finding — raw request/response +
  screenshot / decrypted Burp request; ground truth, not a guess.
- `objective-proof` (red team): beacon callback / access token / screenshot.

**Review**: spawn a fresh **`Agent`** running `/sch-review --project <id>` for
this task id (clean context — the executor never reviews itself). It returns
`approved` / `changes` / `escalate`.

- `changes` → `task-set --status changes`, end pass (step 3 converges next).
- `escalate` → `task-set --status blocked`, end pass.
- `approved` → **complete** per the pack, after re-verifying live state:
  - `git-merge` (dev): tree clean + branch still on reviewed commit + tests
    green → merge to default, delete branch.
  - `finding-logged` / `objective-logged` (offensive): record each result with
    `state.mjs finding-add` — `validated` (with PoC evidence path) for issues,
    `tested-clean` for classes that held (this proves coverage). Write the
    evidence into `<project>/reports/`. A phase is done only when every
    applicable class is `validated` or `tested-clean` — no untested cells.
  - Then `task-set --project <id> <taskId> --status merged --note "<done ref>"`
    (`merged` is the generic "done" status for every pack).

**Record what was used and what changed (every completed task):**

1. **Skills used** — record which installed skills this task dispatched to, so
   it is visible on the dashboard and auditable:
   ```bash
   node scripts/state.mjs task-set --project <id> <taskId> --skills "taste-skill|gsap-scrolltrigger"
   ```
2. **CHANGELOG.md** (in the project's own `path`) — append one entry per
   completed task: date, task id + title, what changed (files/behaviour), the
   merge/commit ref, and skills used. Create the file if missing.
3. **HANDOFF.md** (in the project's `path`) — **overwrite** it each pass so it
   always reflects current reality: what is done, what is in flight, what is next
   in the queue, open questions/blockers, how to resume (branch, commands to run
   the app/tests), and any known issues. This is the "pick up where it left off"
   document for you or another session.

These three plus `state.json` (tasks/findings/events) and `logs/audit-*.jsonl`
are the complete record of what the loop did and why.

Completion happens inside the loop, per task. The human gates are the contract
(spec) and the inbox (direction) and — for offensive — the scope gate; not this.

## 7. Grow the queue / blocked

- **Grow:** if executing revealed a needed feature/enhancement (dev) or a new
  lead worth a follow-up phase (offensive), add tasks so they get done too:
  `task-add --project <id> --source build ...`. The loop picks them up.

- **Chain (offensive):** whenever you `finding-add` a `validated` finding, ask
  "what does this primitive unlock?" and spawn a **chain-hunt task**
  (`--source chain`) for each realistic escalation, unless the finding's
  `chainDepth` already reached `CHAIN_MAX` (3). Record chained findings with
  `finding-add --parents "<id>"` so lineage + depth are tracked. Common chains:
  - SSRF → cloud metadata → creds → data / lateral
  - IDOR/BOLA + mass-assignment → privilege escalation / tenant takeover
  - reflected/stored XSS + weak CSRF/SameSite → account takeover
  - open redirect + OAuth `redirect_uri` → token/code theft → ATO
  - file upload + path traversal / LFI → RCE
  - SQLi → auth bypass → admin → RCE (stacked/`xp_cmdshell`/`INTO OUTFILE`)
  - exposed secret/key → API/cloud access → data
  A proven chain outranks its individual parts — reviewers rate it higher. Stay
  within RoE (no destructive actions); the depth cap prevents infinite spawning.
- **Blocked:** a real product/authorization decision → write one concrete
  question (decision, options, which AC/objective), `task-set --status blocked`,
  end pass. It returns when a human answers via the dashboard inbox.

## 7b. Effort budgets & rabbit-hole escape (mandatory)

An autonomous loop must never spin forever on one thing. Enforce every pass:

- **Bounded effort per task.** Each task (a phase, a specific vuln attempt, a
  chain-hunt) has a budget — a small number of attempts/passes. Track it in the
  task notes (attempt count).
- **Progress = a coverage delta.** A pass "made progress" only if a coverage cell
  moved (`validated`/`tested-clean` via `finding-add`) or a hypothesis was
  confirmed/denied. Re-trying the same payload with no cell moving is NOT progress.
- **Budget hit + no progress → stop the rabbit hole.** Record what was tried,
  mark the task `stuck` (or the specific class `tested-clean` if genuinely
  exhausted, e.g. WAF-bypass loop done), log the reason, and **move to the next
  task**. Never keep grinding one endpoint/payload — breadth first, the queue
  holds the rest.
- **Chain-depth cap.** A chain-hunt task may spawn a follow-up only up to a fixed
  depth (default 3 hops), and each hop must be a *validated* finding. Beyond that,
  stop and report the chain as-is. This prevents infinite self-spawning.
- **Bound the self-extending queue.** Only add a new task when it targets a
  concrete, un-covered cell or a validated-finding chain — never speculative busywork.

## 8. Deliver-check

First, if this pass completed a task, invoke **`/sch-learn --project <id>`** to
distill any reusable lesson into `knowledge/<pack>.md` (generalizable only,
never target-specific).

Then decide "finished" by the **coverage matrix**, not by "nothing queued":

**Offensive — testing is finished only when ALL hold:**
1. The attack surface is fully enumerated (recon phase done → the host × endpoint
   × parameter × role inventory exists).
2. **Every applicable class against every cell is `validated` or `tested-clean`**
   (`finding-list` shows no un-covered cell). A phase with untested cells is NOT
   done, even if its task looks complete.
3. No open chain-hunt tasks (within the depth cap).
4. Only `stuck` tasks remain for a human — those are escalated, not "done".

When 1-4 hold → invoke **`/sch-ship --project <id>`** (produces the report via
`scripts/report.mjs`). **Dev** — every PRD AC maps to a merged task. Otherwise end
the pass; the next interval continues. If only `stuck` tasks remain, end and leave
them for the human — do not fabricate completion.

## Hard limits

- One task per pass; one project per running loop.
- Never run an `active` task whose target is not `IN-SCOPE` at execution time.
- Re-verify live state immediately before any completion; a stale approval is
  not permission. Never complete a dev task whose branch moved since review.
- `NG-N` and RoE are absolute. Scope grows only through the queue, never silently.
