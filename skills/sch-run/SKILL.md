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

## Token discipline (applies to EVERY pass — the loop runs unattended, tokens add up)

- **Output: caveman-ultra.** Terse. No narration of tool calls, no filler, no
  restating the plan, no essays. One short line per real step. State each fact once.
- **Code: ponytail-ultra.** Smallest working diff. Reuse what exists, stdlib/native
  before deps, one line before fifty. No scaffolding "for later", no speculative
  abstractions. Ship the lazy version that works.
- **Commands: use `rtk`.** Wrap dev/shell commands with the RTK proxy to cut
  command-output tokens 60-90% (e.g. `rtk git status`, `rtk git diff`). If the RTK
  hook is active it rewrites automatically; otherwise prefix manually.
- **Read only what you need.** Load only the relevant pack phase (not the whole
  methodology), only the files the task touches. Do not re-read files already in
  context. Do not dump long logs — quote the one decisive line.
- **Never read a large file whole.** Bundles / minified JS / lockfiles / big
  data (>~50 KB) — use `grep`/`head`/targeted line-ranges, never a full Read.
  (A single 2.9 MB bundle read can blow an entire budget.)
- **Model routing.** Run the loop and its review sub-agents on **Sonnet** for
  routine build/validate/review; reserve Opus for genuinely hard reasoning. On a
  Max plan, Opus consumes the limit several times faster for the same work.
- **Browser: screenshots + tiny evaluates only, never full snapshots** (see
  Validate). A11y-tree snapshots are the single biggest per-pass token sink.
- **One task per pass.** Do not wander into adjacent work; the queue holds it.
- **Stateless by design — a fresh context loses nothing.** Everything durable is
  on disk: `state.json` (tasks/findings/events), `CHANGELOG.md` + `HANDOFF.md`
  (what's done / in flight / next), `git log`, `knowledge/<pack>.md`,
  `logs/`. This pass re-reads what it needs and needs no memory of prior passes.
  So the session context should be **cleared, not compacted** — run `/clear`
  before a run rather than letting context accumulate. Best of all, run each pass
  with clean context (a cloud routine via `/schedule` does this automatically).

(If the loop session has the `caveman` and `ponytail` plugins active, keep them at
`ultra`. This section enforces the same behavior even without them.)

## 0. Cheap gate FIRST (do this before loading anything — saves tokens)

The single most important step for cost. Make ONE call before reading any pack,
knowledge, PRD, or scope:

```bash
node scripts/state.mjs pass-gate --project <id>
```

- **`BUSY`** → another pass is still running. **STOP the pass right here.** Output
  one short line ("pass skipped — another running") and end. Do NOT load the pack,
  do NOT read files, do NOT think further. A short `/loop` interval costs almost
  nothing because of this.
- **`IDLE`** → nothing to build (no ready task, no `changes`, no new inbox). **STOP
  here too** — one line ("idle — nothing queued"), end. Don't load the methodology
  just to discover there's no work.
- **`WORK`** → there is real work. Take the lock and proceed:
  ```bash
  node scripts/state.mjs lock-acquire --project <id> --ttl 45
  ```
  (If lock-acquire now says BUSY due to a race, stop.) **Always release** at the
  end of the pass (success, blocked, or error):
  `node scripts/state.mjs lock-release --project <id>`.

Only after `WORK` + lock do the heavy steps below run. This keeps idle and
overlapping passes to a handful of tokens instead of a full methodology load.

## 0c. Load the pack (only on a WORK pass)

```bash
node scripts/state.mjs project-get --project <id>     # domain, path, scope
```

Read `packs/packs.json` for the domain, and `packs/<method>.md` for the
methodology. **Load only the phase/section relevant to the task you're about to
do** — do not re-read the entire 15 KB methodology every pass if you only need one
phase. Read `knowledge/<pack>.md` for accumulated lessons.

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

## 5. Execute — in a FRESH-CONTEXT subagent, one task only (v3, kills rot + drift)

**Do NOT build inline in the loop session.** The accumulating loop context is what
made a build task wander into product-strategy essays and burn tokens. Instead,
**spawn a fresh `Agent`** (model `sonnet`) with a tight brief for this ONE task,
clean context. The loop session stays a lean orchestrator.

The subagent brief contains ONLY: the task id, its `AC-N`/`NG-N`, the project
`path` + `CONSTITUTION.md`/`HANDOFF.md`, and the pack's relevant phase. Tell it:

1. **Stay strictly on this task.** Implement only its `AC-N`. **Do not redesign
   the product, do not amend the PRD, do not touch adjacent features.** If you
   discover a product/scope decision (e.g. "this contradicts NG-4"), **do not act
   on it** — return it as a one-line blocked question for the operator. Wandering
   off-task is the failure we are eliminating.
2. **Ground in the REAL code before editing** (this fixes the regressions):
   - Before renaming/removing any symbol, key, class, or string, **grep every
     usage** and update all of them, or don't rename. (A `translateString("SAVE")`
     key lives in 21 locale files — never change it blind.)
   - Before writing CSS/DOM, **read the actual markup** the selectors target — do
     not style against assumed structure.
   - Verify the element/class you rely on actually exists and co-occurs.
3. **TDD where it applies:** write/adjust the test first, watch it fail, then make
   it pass (superpowers RED-GREEN). Dispatch to the fitting installed skill
   (design skill for UI, backend skill for API — best-fit, not all).
4. **If a fix makes things worse, STOP guessing** — do 4-phase root-cause
   (systematic-debugging), don't pile on more edits.

The subagent returns: what changed, files touched, test/lint/type results, and
any blocked question. The orchestrator records it and moves to validate/review.

If an objective is ambiguous, conflicts with an `NG`/RoE, or needs a human
decision, go to step 7-blocked — never guess.

**Actually invoke them.** Reading a skill's name in `packs/*.md` is NOT dispatch.
For each skill the task needs, call it with the **Skill tool** so the invocation
is recorded in the session transcript (that transcript is the audit trail —
`scripts/skills-used.mjs` verifies it). Then record what you used:
`task-set --skills "<skill1>|<skill2>"`. Claimed skills that never appear in the
transcript are a reporting failure — the two must match.

**DESIGN SKILLS — smart, per-task (not all, not every task).** The operator pins
a set of good design/UI skills to the project (dashboard picker / `skills-set`).
These apply **only to UI/design tasks**, and you use the **best-fit one(s) for
this specific task**, not the whole set:

- New screen/component → `taste-skill`; polish/audit an existing screen →
  `impeccable`; upgrade/redesign → `redesign-skill`; tokens/system → `design-dna`;
  animation → `motion-design` / `gsap-*`. Pick 1–2 that fit — do not fire all six.
- **Backend / DRM / infra / recon / test tasks are NOT design work — no design
  skill is required or expected.** Just build.

For a UI/design task, invoke the fitting design skill with the **Skill tool**
before writing the UI, then complete. The engine hard-gates the merge: a UI task
won't complete unless **at least one** of the operator's design skills shows up in
the transcript (unfakeable). Non-design tasks are never gated. If the engine
wrongly flags a task as design when it isn't, complete with `--force true --note
"not design work"` (logged).

- **Dev/tool:** implement only this task's `AC-N`; `NG-N` binding; repo style.
- **Offensive:** run this phase's methodology from `packs/<method>.md`, against
  the task's in-scope `target` only, within the RoE (rate limits, window,
  no-destruction) recorded in the scope. Orchestrate with background sub-agents;
  for `sequential`/`sequential-device` packs run one active task at a time and
  never leave a device armed idle (arm → test → disarm).

If an objective is ambiguous, conflicts with an `NG`/RoE, or needs a human
decision, go to step 7-blocked. Never guess.

## 6. Validate → review → complete

**Validate** by the pack's `validate` — **keep it token-cheap:**
- `playwright` (web/app-dev): **NEVER `browser_snapshot`** (it dumps the whole
  accessibility tree = tens of thousands of tokens). Use **one targeted
  screenshot** + `browser_evaluate` returning a **tiny** result (a boolean / a few
  values: does the element exist, is the text/color right, any console error).
  Cap total browser calls to **~2–3 per task**. Validate once at the end, not
  after every edit. A failed check → fix, then one re-check, not a loop of snapshots.
- `run-the-tool` (tool-dev): invoke the CLI/lib, assert output/exit code.
- `poc-evidence` (pentest): reproduce each finding — raw request/response +
  screenshot / decrypted Burp request; ground truth, not a guess.
- `objective-proof` (red team): beacon callback / access token / screenshot.

**Review** (token-cheap): spawn a fresh **`Agent`** running `/sch-review` for this
task id — but **scope it to the diff, not the repo**, and **on a cheaper model**.
Pass the agent: the task's `AC-N`/`NG-N`, the `git diff` of the branch, and the
list of changed files. Tell it NOT to re-explore the whole codebase (that re-read
is what cost ~80k tokens/task). A fresh agent reviewing a focused diff costs a
fraction. Run the agent with `model: "sonnet"` unless the change is genuinely
subtle. It returns `approved` / `changes` / `escalate`.

- `changes` → `task-set --status changes`, end pass (step 3 converges next).
- `escalate` → `task-set --status blocked`, end pass.
- `approved` → **complete** per the pack, after re-verifying live state:
  - `git-merge` (dev): tree clean + branch still on reviewed commit + tests
    green. **SECRET-SCAN GATE before every commit/push** — the loop must never
    push a secret:
    ```bash
    git add -A && node <SCH_HOME>/scripts/secret-scan.mjs   # exit 1 = BLOCKED
    ```
    If it exits 1, **do not commit** — remove the secret / gitignore the file /
    use env vars, re-stage, re-scan. Never `--force` past it. Also confirm
    `CLAUDE.md`, `.env*`, keys are git-ignored. Only on exit 0 → commit (with the
    changelog entry) → merge to default → delete branch → push.
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
- **Blocked:** a real product/authorization decision → `task-set --status blocked
  --note "<question>"`, end pass. It returns when the operator answers from the
  dashboard.

  **Write the question in plain language a non-developer can answer.** The person
  reading it on their phone may not be a developer, and will not know your jargon.
  Every blocked question MUST have:
  1. **What you need to decide**, in everyday words — no unexplained jargon
     (write "who can do what in the app", not "role axis / RBAC taxonomy").
  2. **The options, spelled out** with what each means in practice.
  3. **A concrete example** of the result of each option.
  4. **Your recommendation + a sensible default**, so they can simply reply "yes,
     use your default" and be done.

  ❌ Bad: `Needs product decision: role axis (User/Admin/SuperAdmin tiers vs RBAC
  member/contributor/manager), which quota dimensions, and defaults.`

  ✅ Good: `Who should be allowed to upload, and how much? Option A (simple):
  three levels — Viewer (watch only), Creator (can upload), Admin (manages
  everything). Option B (flexible): finer roles per team. Example with A: a
  Creator gets 5 GB total and 500 MB per video; a Viewer gets none.
  Recommended: A, with 5 GB / 500 MB — reply "use default" to accept.`

  If the operator's answer is still ambiguous, ask ONE short follow-up in the same
  plain style rather than guessing.

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
