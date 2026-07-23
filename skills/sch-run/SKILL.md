---
name: sch-run
description: The SCH Loop engine, one project per loop. One pass fully completes one task per its pack — build/execute, validate, review with fresh context, complete (merge or log finding), grow the queue, and deliver when done. Enforces the offensive scope gate. Designed for /loop; run as /loop 15m /sch-run --project <id>.
---

# SCH Loop — engine

> **Engine home (`SCH_HOME`):** `C:\Users\r00t\Desktop\loop\SCH-loop`. Every
> `node scripts/state.mjs …` command and every `packs/…` file below lives there.
> If your terminal is in another folder, use the absolute path, e.g.
> `node C:/Users/r00t/Desktop/loop/SCH-loop/scripts/state.mjs …`. Dev git ops run
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

Dispatch to the pack's installed skills — **use them, do not reinvent**:

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

Completion happens inside the loop, per task. The human gates are the contract
(spec) and the inbox (direction) and — for offensive — the scope gate; not this.

## 7. Grow the queue / blocked

- **Grow:** if executing revealed a needed feature/enhancement (dev) or a new
  lead worth a follow-up phase (offensive), add tasks so they get done too:
  `task-add --project <id> --source build ...`. The loop picks them up.
- **Blocked:** a real product/authorization decision → write one concrete
  question (decision, options, which AC/objective), `task-set --status blocked`,
  end pass. It returns when a human answers via the dashboard inbox.

## 8. Deliver-check

First, if this pass completed a task, invoke **`/sch-learn --project <id>`** to
distill any reusable lesson into `knowledge/<pack>.md` (generalizable only,
never target-specific).

Then: no ready or in-flight tasks **and** the contract satisfied (every PRD AC
merged / every pack phase incl. `report` done) → invoke
**`/sch-ship --project <id>`**. Otherwise end the pass.

## Hard limits

- One task per pass; one project per running loop.
- Never run an `active` task whose target is not `IN-SCOPE` at execution time.
- Re-verify live state immediately before any completion; a stale approval is
  not permission. Never complete a dev task whose branch moved since review.
- `NG-N` and RoE are absolute. Scope grows only through the queue, never silently.
