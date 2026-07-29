---
name: sch-run
description: The SCH Loop engine, one project per loop. One pass fully completes one task per its pack — build/execute, validate, review with fresh context, complete (merge or log finding), grow the queue, and deliver when done. Enforces the offensive scope gate. Designed for /loop; run as /loop 15m /sch-run --project <id>.
---

# SCH Loop — engine

> **Engine home (`SCH_HOME`):** `$HOME/.claude/SCH-loop`. Every
> `node scripts/state.mjs …` command and every `packs/…` file below lives there.
> If your terminal is in another folder, use the absolute path, e.g.
> `node $HOME/.claude/SCH-loop/scripts/state.mjs …`.
> **`--project` is optional** — if omitted it is auto-detected from the current
> folder (the registered project whose `path` contains your cwd). Check with
> `state.mjs project-here`.. Dev git ops run
> in the project's own `path`; state + packs always come from `SCH_HOME`.

One pass = one task carried to done, or one convergence round on a task in
review. Under `/loop /sch-run --project <id>` each interval runs this once for
that project. All durable state is in `state.json`; re-read every pass, trust
nothing from memory.

## THE OPERATOR IS USUALLY AWAY — every question goes to the dashboard

A phone notification is configured (`SCH_NOTIFY_WEBHOOK`), so **every time you
block on a question, push it** — one clear sentence, with a link straight to the
project so it can be answered in one tap:

```bash
node <SCH_HOME>/scripts/notify.mjs \
  "<project> · task #<id> needs you — <the question in one line>. Reply on the dashboard." \
  --title "SCH Loop - needs you" --tags warning --priority high \
  --click "http://localhost:4600/?project=<project>"
```

Push **once per blocked task**, never on every pass. Keep it generic — task id +
short question, **never credentials, targets, or client-confidential detail**
(the channel is not private). Use `--tags white_check_mark` + normal priority for
a "queue finished / report ready" notice.

Assume the person is **not watching this terminal**; they have the dashboard on a
phone. Therefore: **anything that needs their input must be written into state**,
never only printed here. A question, a blocked decision, a dirty tree, an expired
authorization — record it as a `blocked` task with the question in `--note` (plain
language, options, example, your recommended default). It then appears in the
dashboard's red **NEEDS YOU** banner with an answer box, and their answer requeues
it at priority 1. Print it in the terminal too, and push it via
`scripts/notify.mjs` if a webhook is set. **Never end a pass with an unanswered
question that exists only in terminal output.**

Also: **always release the run-lock before ending a pass**, including when you
stop to ask something — a held lock makes every later pass no-op.

**NEVER stop the cron, and never require a terminal command to resume.** The
operator may only have the dashboard. Being blocked is normal: keep firing, let
each pass exit cheaply at the gate, and **resume automatically the moment the
blocker clears** (they answered on the dashboard / committed the tree). Do not
say "tell me to restart" — there is no terminal for them to say it in. Only stop
the cron if the operator explicitly asks.

**A DECISION task must carry its own options.** Put the full question — options
written as WORDS, not letters (`sign` / `encrypt` / `https-only`, never `A/B/C`) —
in the task `--notes`. A bare letter is unresolvable once the surrounding chat is
gone. The answer is appended, never overwrites the question.

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
- **Read the function, not the neighbourhood.** Observed in real passes: 260-line
  and 335-line ranges pulled in to look at one function. Grep for the symbol to
  get its line number, then read ~40 lines around it. Widen only if that genuinely
  is not enough. Ten targeted reads cost less than two speculative ones.
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

- **Keep the orchestrator's own footprint tiny — this is what bounds context.**
  An in-session `/loop` enqueues each pass into the SAME conversation, so whatever
  this session prints stays in context for every later pass. Therefore:
  - **Never build or review inline.** Both run in subagents, whose own context is
    discarded when they return — only their short report reaches this session.
    This is the main reason the subagent rule exists.
  - **Brief the subagent, then summarise its return in one or two lines.** Never
    paste a subagent's full report, a diff, a file, or a test log into this
    session. Quote the one decisive line.
  - **End every pass with at most 5 short lines** — what was done, its status,
    what is next. A pass that prints half a page costs that half page on every
    remaining pass of the day.
  - Target: **under ~2k tokens of orchestrator output per task.** At that size a
    long run compacts rarely and cheaply.
  - For genuinely fresh context per pass, the loop must be driven from **outside**
    the session (a scheduler running headless `claude -p`), because nothing inside
    a session can clear its own context.

(If the loop session has the `caveman` and `ponytail` plugins active, keep them at
`ultra`. This section enforces the same behavior even without them.)

## 0. Cheap gate FIRST (do this before loading anything — saves tokens)

The single most important step for cost. Make ONE call before reading any pack,
knowledge, PRD, or scope:

```bash
node scripts/state.mjs pass-gate --project <id> --interval <loop interval in minutes>
```

Pass `--interval` with the interval `/loop` is running at (e.g. `--interval 30`
for `/loop 30m /sch-run`). This call is also the loop's **heartbeat** — it stamps
`state.run` with the pass number and timestamp, which is the only way the
dashboard can tell a healthy idle loop from a cron that died. Skip the flag and
the dashboard falls back to a 45-minute grace window; skip the call entirely and
the dashboard shows **LOOP NOT RUNNING**, which is correct — it isn't.

- **`BUSY`** → another pass is still running. **STOP the pass right here.** Output
  one short line ("pass skipped — another running") and end. Do NOT load the pack,
  do NOT read files, do NOT think further. A short `/loop` interval costs almost
  nothing because of this.
- **`IDLE`** → nothing to build (no ready task, no `changes`, no new inbox). **STOP
  here too** — one line ("idle — nothing queued"), end. Don't load the methodology
  just to discover there's no work.
- **`WORK`** → there is real work. Take the lock and proceed:
  ```bash
  node scripts/state.mjs lock-acquire --project <id> --ttl 45 --holder sch-run
  ```
  (If lock-acquire now says BUSY due to a race, stop.) **Always release** at the
  end of the pass (success, blocked, or error):
  `node scripts/state.mjs lock-release --project <id>`.

Only after `WORK` + lock do the heavy steps below run. This keeps idle and
overlapping passes to a handful of tokens instead of a full methodology load.

## 0a. SAY WHAT YOU ARE DOING — before every phase that takes more than a moment

The operator watches the dashboard, not this terminal. Only tasks in `building`
used to be visible, so a pass that spent twelve minutes on a planning subagent
displayed "WAITING — no task building" throughout, and looked stalled.

**Announce every phase**, in plain words, before starting it:

```bash
node scripts/state.mjs activity --project <id> --doing "planning inbox #8 — PRD gap analysis"
node scripts/state.mjs activity --project <id> --doing "building #67 — SPA transport wrapper"
node scripts/state.mjs activity --project <id> --doing "reviewing #67 (diff, 240 lines)"
node scripts/state.mjs activity --project <id> --clear true      # at the end of the pass
```

One line, one call, and the dashboard shows it live with a running timer. A pass
that never announces anything is indistinguishable from a dead one.

## 0b. KEEP WORKING — do not sleep out the rest of the interval

A finished task does **not** end the pass. The interval decides how often a
*stopped* loop wakes up; it must never decide how fast a *working* loop goes. A
5-minute task under a 30-minute interval would otherwise waste 25 minutes, and a
45-task queue would take a day and a half of wall-clock for a few hours of work.

So after completing a task (step 6) — **and before ending the pass** — ask the
gate again, passing your own holder name so your own lock does not read as BUSY:

```bash
node scripts/state.mjs pass-gate --project <id> --holder sch-run
```

- **`WORK`** and no stop-condition below → **go back to step 3** and do the next
  task in this same pass. You still hold the lock, the pack is already loaded, and
  each task still gets its own fresh-context subagent — so continuing is cheap and
  carries none of the drift risk of a long-lived builder.
- **`IDLE`** → nothing left. Go to step 8 (deliver-check), release, end.

**Stop the pass (release the lock, end) ONLY when one of these hits:**

1. **The gate says `IDLE`** — genuinely nothing left that can run.
2. **5 tasks completed in this pass** — a hard cap. Keeps the orchestrator's
   context lean and gives the operator a natural checkpoint.
3. **25 minutes of wall-clock in this pass** — end cleanly before the next alarm
   rather than being interrupted mid-task.
4. **A preflight condition blocks ALL work** — a dirty tree (dev) or a closed
   scope gate (offensive). Nothing can proceed, so ending is the only option.

**A blocked task is NOT a reason to stop the pass.** This is the mistake to
avoid: one task raising a question, or planning producing a `DECISION:` task,
says nothing about the other forty in the queue. Mark it blocked, notify, and
**move to the next ready task**. Only when the gate itself returns `IDLE` — no
ready task, no `changes`, no new inbox — is the pass actually finished.

The same applies to a task that goes `stuck`: record it, leave it for the human,
and carry on with work that is unaffected. Stopping the whole pass because one
item needs an answer is how an operator ends up watching an idle loop with a full
queue.

The lock TTL (45 min) is deliberately longer than the wall-clock cap, so a pass
that is genuinely working is never mistaken for an abandoned one.

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

You are calling it in **unattended mode** (nobody is watching this terminal), so
it skips the play-back and confirmation steps. It still decomposes properly: one
inbox message often contains several separate requirements and becomes several
right-sized tasks, each tagged `--source inbox#<id>` so the operator can trace
what their message became. Anything genuinely ambiguous becomes a DECISION task on
the dashboard — never a guess.

## 2. Preflight + scope gate

**FIRST: has the operator already answered the thing that is blocking you?**
Before reporting any blocker, check whether a task about it already exists **and
carries an answer** (`task-get <id>` → `answers[]`, or notes beginning
`ANSWERED:`). If it does, **carry the answer out now, in this pass** — that is the
whole point of asking. Then set the task `merged` and continue.

Reporting "blocked, unanswered" for a question that was answered hours ago is the
worst failure this loop has: the operator did their part, watched nothing happen,
and has no way to tell the difference between a loop that is waiting and a loop
that is ignoring them. An answer is an instruction, not a note.

- **Dev packs:** confirm the project `path` repo, `origin` reachable, and a clean
  tree (`git status --porcelain` empty). **A dirty tree must not silently no-op
  every pass** — it blocks all work, so surface it where the operator will see it:
  record it once as a blocked task
  (`task-add --title "BLOCKED: uncommitted changes in the working tree" --notes
  "<the exact file list> — commit or revert them, then this clears"`, then
  `task-set --status blocked`), and notify. Do not create a duplicate on later
  passes if one already exists. Then end the pass.
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

**COMPOUND every correction (Boris's #1 habit — run-forever unlock).** When a
review returns `changes`, or you catch a regression, do not just fix it — **write
the rule to the project's `CLAUDE.md`** (append one line under `## Lessons
(auto-added)`), because `CLAUDE.md` is auto-read every future pass so the mistake
can never recur. Example: a bad blind rename → add "never rename i18n key X
without updating all locale files." A fix that only lives in this pass fixes one
task; a rule in `CLAUDE.md` fixes every future task. This is what stops the loop
re-making the same regression. (Also mirror durable/generalizable lessons to
`knowledge/<pack>.md` via `sch-learn`.)

**RETRACT A WRONG DIAGNOSIS IN WRITING.** When a theory you recorded turns out to
be false, say so explicitly where you recorded it — the task notes and
`CLAUDE.md` — rather than quietly writing a new one beside it. One engagement
accumulated five successive explanations for the same failure ("the environment
is unstable", "anti-automation blocks us", "the auth service is down", …), none
true and none retracted. A fresh context cannot tell a superseded theory from a
current one, so every stale guess it inherits reads as an established fact and
sends it down the same dead end. "This was WRONG, here is why, the actual cause
is X" is worth more than the correction itself.

**WRITE THAT FILE WITH THE `Write`/`Edit` TOOL — never through a shell heredoc.**
A pass wrote the hard-won working login recipe into `CLAUDE.md` with
`cat > CLAUDE.md <<EOF` (unquoted delimiter). The shell ran every backtick as a
command substitution, so **every inline `code` span and the entire ```js block
were replaced by nothing** — silently. The file still looked plausible: prose
intact, the actual snippet gone, sentences ending "…Angular ignores a plain ."
The next pass then failed to log in exactly as before.
- Markdown is full of backticks. `Write` has no shell in the path; use it.
- If a heredoc is genuinely unavoidable, the delimiter **must** be quoted
  (`<<'EOF'`), which disables substitution.
- After writing any guidance file, **read back the section you just wrote** and
  confirm the code survived. A recipe that lost its code is worse than no
  recipe: it reads as if the problem were already solved.

## 3d. Parallel wave (optional — throughput for independent tasks)

When several **ready** tasks are independent — deps met, and they touch
**different files** (no overlap) — dispatch them as a **wave** of fresh-context
subagents in parallel instead of one at a time (superpowers
`dispatching-parallel-agents` + `using-git-worktrees`):

- Cap the wave at **3** concurrent subagents (avoid thrash + merge chaos).
- Each subagent works in its **own git worktree/branch** so they never touch each
  other's tree. Same one-task-only, ground-first brief as step 5.
- **Merge sequentially, not in parallel:** for each returned branch, in turn —
  secret-scan → review (fresh) → rebase on default → resolve any conflict →
  merge. Never merge two branches simultaneously.
- Only wave tasks that genuinely don't overlap (e.g. two different pages). If in
  doubt about file overlap, run them sequentially. UI tasks sharing the token CSS
  are NOT independent — sequence those.

If not waving, proceed one task per pass (step 4).

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

**Never build inline** — an accumulating loop context is what makes a build task
wander off-topic and burn tokens. **Spawn a fresh `Agent`** (model `sonnet`), clean
context, one task. The loop session stays a lean orchestrator.

### GIVE THE BUILDER THE FEWEST TOOLS THAT DO THE JOB (measured: ~60% cheaper)

Five measured builds on the same project, same model, comparable tasks:

```
full tool access      84k · 88k · 120k · 125k        (16-50 tool uses)
Read/Edit/Grep/Glob   35k                            (24 tool uses)
```

Cost barely tracks tool USES — going from 16 to 50 raised it 36%. It tracks the
**tool SCHEMAS the agent carries**, which are re-sent on every turn. A builder
with the whole MCP surface pays for Chrome, Playwright, ghidra, pentest tooling
and everything else on every single turn, whether or not it touches them.

- **Editing code?** Use a code-only agent (`Read`, `Edit`, `Write`, `Grep`,
  `Glob`). It cannot run the build, the tests or git — **you** run those after it
  returns, which costs a fraction of what its schemas would have.
- **The task genuinely needs a browser or the container?** Then it needs those
  tools, and you pay for them — but say so in the pass notes, because that is
  the expensive path.
- **Verify what it could not.** A restricted builder cannot check line endings or
  run tests; do both yourself before committing. A real CRLF flip slipped through
  exactly this way and was caught by the commit gate.

### 5a. LOCATE FIRST — never send a builder in blind (the biggest cost lever)

A fresh subagent knows nothing about this codebase. Hand it `"enforce upload
quotas per role"` with no file names and it will spend 40-80 tool calls and
100k+ tokens rediscovering what you could have found in three greps. That is the
entire difference between a task taking 3 minutes and taking 14.

**If the task does not already name its target files, find them BEFORE
dispatching**, in the orchestrator, cheaply:

```bash
# the choke point, not every mention — name the function/route/model
rtk grep -rn "user_allowed_to_upload\|def upload" --include=*.py files/
```

**ASK THE GRAPH FIRST — before any grep, any read, any index.**

SCH Loop has its own knowledge graph (`sch_graph_*` MCP tools, self-contained, no
external service). It holds what previous passes already worked out: choke
points, endpoints, roles, the JS function that does the crypto, findings,
decisions, lessons — each with a one-line summary and its call paths.

```
sch_graph_explore  project=<id>  query="<what you are looking for>"
```

A hit returns the location, what it is, and **everything that calls it** — the
blast-radius check a rename needs — in one round-trip. No hit means nobody has
recorded it yet; locate it the normal way below, then **record it** so the next
task never repeats the work:

```
sch_graph_record  project=<id>
  nodes=[{kind:"symbol", name:"user_allowed_to_upload", path:"files/methods.py",
          line:412, summary:"single choke point for BOTH upload paths"}]
  edges=[{from:"IsAuthorizedToAdd", to:"user_allowed_to_upload", kind:"calls"}]
```

**Record on every task, not just when it feels notable.** A discovery that is not
recorded is paid for again, by the next fresh subagent, at full price. This is
the mechanism that makes the loop get cheaper over time instead of costing the
same forever.

**Offensive work records as it goes, from the first request.** Recon output is
graph material: each host, endpoint, parameter and role is a node; the response
that revealed it is the summary; a validated finding links to the endpoint it was
found on and the evidence that proves it. Then a question three days later —
"this response body is encrypted, what produces it" — is one graph call instead
of re-reading a bundle.

**Then, if the project also has a `.codegraph/` index, `codegraph_explore` is the
next call — not a fallback.** One call returns the relevant symbols' verbatim source,
every caller of each one, and a warning where no tests cover them. Measured on
this project: the same question that cost ~35 greps and reads returned in a
single call, including all 7 callers of the choke point.

- Query it with the symbols/behaviour you are looking for; a natural-language
  question works.
- **Treat what it returns as already Read** — re-opening those files is pure
  waste, and it says so in its own output.
- Its "blast radius" list *is* the ground-truth check: every caller you must
  update before renaming anything, without a separate grep pass.
- Budget is a couple of calls per project; spend the second on an area the first
  did not cover rather than falling back to Read.

Not indexed? Say so once to the operator (`codegraph init` in the repo) and use
targeted greps meanwhile. Indexing is their call, not yours.

Then **write what you found back into the task** so it is never rediscovered —
and so the engine can see which tasks share ground:

```bash
node scripts/state.mjs task-set --project <id> <taskId> \
  --files "files/methods.py|files/admin.py|tests/api/test_upload_quota.py" \
  --note "files/methods.py: user_allowed_to_upload is the single choke point"
```

### CLUB CO-LOCATED TASKS INTO ONE SUBAGENT (the big token lever)

Two tasks on the same files pay for the same ground truth twice — the same reads,
the same call graph, the same test setup. That shared discovery is the largest
single cost in a pass. Once the lead task's files are recorded, ask:

```bash
node scripts/state.mjs task-batch --project <id> --with <taskId>
```

It returns ready tasks whose files overlap. If it returns any, brief **ONE**
subagent with the whole group:

- **Ground truth is established once**, up front, for all of them.
- Then the tasks are done **one at a time, in order** — each with its own `AC-N`,
  its own verify step, and **its own commit**. They do not become one task; a
  merged mega-task is exactly the drift that made earlier loops wander.
- If any task in the group turns out to be wrong or blocked, it stops there and
  reports — the earlier commits stand.
- **Cap 3.** Never batch an offensive `active` task, and never batch a task that
  depends on another in the same group.

**This is the mirror image of the parallel wave (§3d).** Disjoint files → several
agents at once. Overlapping files → one agent, sequentially. Same question asked
twice, opposite answers, and between them they cover every case.

### RECORD WHAT IT COST (every completed task, no exceptions)

**Record EVERY subagent separately, the moment it returns** — its return line
reports both numbers. One total per task hides where the money goes; a task that
looked like a 95k build was really a 95k builder plus a 65k reviewer, and only
the builder was ever recorded.

```bash
node scripts/state.mjs task-set --project <id> <taskId> --agent builder  --tokens 99016 --tool-uses 41
node scripts/state.mjs task-set --project <id> <taskId> --agent reviewer --tokens 64900 --tool-uses 17
```

Use the role as the agent name (`builder`, `reviewer`, `planner`, `wave-1` …).
`state.mjs timing` then reports cost per role, so "which part of a pass is
expensive" is answerable from data instead of guessed at.

**A merge is refused without a cost.** If you genuinely built inline with no
subagent, say so — `--tokens unknown` — but prefer a subagent: building inline
spends the orchestrator's own context, which is the thing every other rule here
exists to protect.

Without this, `state.mjs timing` cannot say whether the loop is getting cheaper,
and every efficiency change is a matter of opinion. With it, `timing` reports the
first half of the run against the most recent half and gives you the real number.

Budget this at ~2-4 searches. You are locating, not solving.

**Give the builder a tool budget: ~35 tool uses.** If it burns through that, the
task was underspecified or too big — it must return what it learned (as a file
map) rather than grinding on. The next pass then starts informed.

### 5b. Hand over the ENVIRONMENT FACTS — establish them once, not once per task

A fresh builder also rediscovers the environment every single time. Observed
across three consecutive passes on the same project, each builder independently
worked out that `pytest` is missing from the web image — roughly eight wasted
tool calls each, three times over:

```
pytest … → not found → python -m pytest → which pytest → pip show pytest
→ manage.py test → find requirements → cat requirements-dev.txt → pip install …
```

**Establish these once at the start of the pass, then paste them into every
brief:**

- **The exact command that runs tests**, verified working (e.g.
  `docker compose exec -T web python -m pytest tests/api/x.py -q`), plus any
  one-off setup already done this pass (`pytest is already installed in the
  running container`).
- **The exact build/deploy commands** for frontend work, from `HANDOFF.md` —
  including the copy step and any cache-buster bump, since a source edit without
  them is a silent no-op.
- **Known-broken things not to chase**: pre-existing failing tests and why
  (e.g. `tests/api/test_new_media.py::test_file_upload` fails on missing ffmpeg,
  unrelated to any change).

When the builder reports a new environment fact, **write it into the project's
`CLAUDE.md`** — that file is auto-read by every future subagent, which is the
only way the discovery stops repeating.

**Shell paths:** the Bash tool is POSIX. `D:\pmcms\x` fails; use `D:/pmcms/x` or
`/d/pmcms/x`. Wrong-form paths cost a call each and are a recurring tax on
Windows.

Brief it with: the task id, its `AC-N`/`NG-N`, **the target files you just
located and what each one is for**, **the environment facts above**, the project
`path` + `CLAUDE.md`/`HANDOFF.md`, and the pack's relevant phase. Its rules:

1. **On-task only.** Implement just its `AC-N`; `NG-N` binding. Do not redesign the
   product, amend the PRD, or touch adjacent features. A discovered product/scope
   decision (e.g. "contradicts NG-4") is **returned as a one-line blocked question**,
   never acted on.
2. **Ground in the REAL code before editing.** Before renaming/removing any symbol,
   key, class or string, **grep every usage** and update all — or don't rename (an
   i18n key like `translateString("SAVE")` lives in ~21 locale files). Before writing
   CSS/DOM, **read the actual markup**; confirm the selector exists and co-occurs.
3. **TDD:** test first, watch it fail, make it pass.
4. **A fix that worsens things → stop guessing;** do 4-phase root-cause debugging.
5. **Karpathy's 4:** *think before coding* (state assumptions; ask one question if
   confused, never silently guess) · *simplicity first* (only what the AC asks; no
   speculative abstractions or unrequested error handling; 50 lines over 200) ·
   *surgical* (only code this task requires; match style; remove only dead code you
   created) · *goal-driven* (AC = pass/fail).

Returns: what changed, files touched, test/lint/type results, any blocked question.

**Dispatch skills for real.** Reading a skill name in `packs/*.md` is NOT dispatch —
call it with the **Skill tool** (the transcript is the audit trail; `skills-used.mjs`
verifies it), then record `task-set --skills "a|b"`. Claimed-but-not-invoked is a
reporting failure.

**Design skills — best-fit, per task.** The operator pins design skills to the
project; they apply **only to UI/design tasks**, and you pick the 1-2 that fit — not
all: new screen → `taste-skill`; polish/audit → `impeccable`; upgrade → `redesign-skill`;
tokens → `design-dna`; animation → `motion-design`/`gsap-*`. **Backend/DRM/infra/recon/
test tasks need none.** The engine hard-gates merge: a UI task can't complete unless
≥1 pinned design skill appears in the transcript. If a task is wrongly flagged as
design, complete with `--force true --note "not design work"` (logged).

**Offensive packs — same model.** Each phase runs in a fresh-context subagent with
`SCOPE.md` as its constitution (in-scope targets, RoE, off-limits, box type, creds).
Test ONLY this phase's in-scope target, stay on its objectives; a discovered lead →
the queue (`--source build`) or the report, **never a scope expansion**. Run the
methodology from `packs/<method>.md` within the RoE; `sequential`/`sequential-device`
packs run one active task at a time (arm → test → disarm, never leave a device armed).
**Data safety:** client findings, creds, PII and evidence stay in
`projects/<id>/reports/` — **never git-committed or pushed**.

Ambiguous objective, conflict with an `NG`/RoE, or a decision only a human can make
→ step 7-blocked. Never guess.

## 6. Validate → review → complete

**Validate** by the pack's `validate` — **keep it token-cheap:**
- `playwright` (web/app-dev): **NEVER `browser_snapshot`** (it dumps the whole
  accessibility tree = tens of thousands of tokens). Use **one targeted
  screenshot** + `browser_evaluate` returning a **tiny** result (a boolean / a few
  values: does the element exist, is the text/color right, any console error).
  Cap total browser calls to **~2–3 per task**. Validate once at the end, not
  after every edit. A failed check → fix, then one re-check, not a loop of snapshots.
  **This is a budget rule, not a blindfold.** Take fewer screenshots — then
  actually LOOK at the ones you take. On offensive work especially, a screenshot
  you captured and never read is the most expensive call in the pass: you paid
  for it and learned nothing. Name what is on the screen and reason about it
  (see "Observe → reason → act" in the pentest pack) before deciding what next.

  **The call cap does NOT apply to offensive browser work** (journey mapping,
  authenticated testing, anything driving a real target). There, correctness
  outranks call count: wait for each screen to be genuinely ready, confirm every
  action landed before taking the next, and never rush a login — a raced step can
  lock a client's test account or manufacture a false result, which costs far
  more than the calls it saved. Calm and composed, one confirmed step at a time.
  See "Pace" in `packs/web-pentest.md`.
- `run-the-tool` (tool-dev): invoke the CLI/lib, assert output/exit code.
- `poc-evidence` (pentest): reproduce each finding — raw request/response +
  screenshot / decrypted Burp request; ground truth, not a guess. **Write the PoC
  file before logging the finding**: `finding-add --status validated` refuses an
  evidence path that is not on disk, and one shared phase report is not a PoC for
  eight findings. One file per finding, under `reports/evidence/`.
- `objective-proof` (red team): beacon callback / access token / screenshot.

**Review — right-size it. A review must never cost more than the build.**

Measured on real passes, review was running 65-85k tokens per task: 33-45% of the
total, to look at a diff the orchestrator already has. That is not a review, it is
a second exploration.

**Small, well-covered change** — under ~40 changed lines, tests green, no
security/auth/crypto/payment/migration surface? **Skip the subagent.** Check the
`AC-N` against the diff yourself and complete. A one-line config change does not
need a fresh agent to read the repo.

**Otherwise** spawn a fresh **`Agent`** running `/sch-review`, `model: "sonnet"`, with:
- the task's `AC-N`/`NG-N`,
- the **`git diff` text itself** (paste it — do not make the agent fetch it),
- the changed-file list.

Hard limits for that agent: **no repo exploration, ~8 tool uses, no reading files
that are not in the diff.** Its evidence is the diff plus the test/lint output it
runs — not a re-read of the codebase. If a diff is genuinely too subtle to judge
without more context, it says so and escalates rather than going exploring.

It returns `approved` / `changes` / `escalate`.

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
- **Blocked ONLY when a human is the only way forward.** `blocked` means "a
  person must answer this". It does not mean "something else has to happen
  first". Before you block, ask **who unblocks this?**
  - *Another task* → it is a **dependency**, not a question:
    `task-set <id> --status blocked --note "blocked on task 55: needs a session"`
    — the engine sees the task number, records `deps:[55]` and leaves it
    **queued**. It asks nobody and wakes up the moment #55 merges.
  - *A retry later* → leave it `queued` with a note. A queue is not a waiting room.
  - *The operator, and nobody else* → block, and only on the ONE task that owns
    the question.

  **Never fan the same question across sibling tasks.** Ten tasks each blocked
  with a copy of "SIT login is down" produced ten identical dashboard questions;
  the operator answered every one, five times over, and nothing moved because
  each answer only requeued its own task. One blocker task, everything else
  depends on it.

- **A blocker you diagnosed is a hypothesis until you verify it in the real
  flow.** An earlier pass invented a health check — a bare `POST` to a Keycloak
  key-publish endpoint — got a 500, declared "the SIT environment is down", and
  blocked ten tasks. The endpoint returns 500 for *any* request lacking session
  context; inside a real browser login it returns 200. The environment was fine
  and the credentials were valid the whole time.
  - **Never invent a health check and treat its failure as ground truth.** A
    probe you made up, run outside the flow it belongs to, tests your probe.
  - Before declaring an outage or an environment fault, **reproduce it on the
    real path** (drive the actual login/journey) and say which response signature
    it matched.
  - If the operator says "I did this manually and it works", that is ground
    truth and your diagnosis is wrong. Fix your automation, do not re-ask.

- **DEFAULT TO DECIDING, NOT ASKING.** The operator handed over a scope, the
  credentials and the contract, and expected the work to happen. A question they
  must answer before anything moves is a stopped engagement. A question they can
  **overrule later** is a running one.

  Before you block, ask: *do I have a defensible default?* If yes — and it is
  reversible, in scope, and not destructive — **take it and keep going**:
  ```bash
  node <SCH_HOME>/scripts/state.mjs task-set --project <id> <taskId> \
    --status blocked --assume "<the call you are making, in one line>" \
    --brief "<the full question, options, and why you chose this one>"
  ```
  `--assume` does not block. It records the decision, leaves the task **queued**,
  and shows the operator "proceeding: X — tap to change" on the dashboard. If
  they disagree, their answer requeues the task at priority 1 and you redo that
  part. That is a far cheaper trade than an idle engagement.

  Most "questions" are this. Which of three test approaches — pick one, say why.
  A naming or format choice — pick the conventional one. Whether to test a class
  the pack already lists — test it. Depth of coverage on an edge case — decide,
  and record it as a coverage cell either way.

  **Only a genuine block stops the work:** something irreversible or destructive,
  something outside the authorized scope (a third party's system, a host not on
  the scope list), something only the operator physically possesses (a test
  account, a credential, a file from the client), or a contract change that
  contradicts `SCOPE.md`/`PRD.md`. Everything else is yours to call.

  And if the answer is "wait for something external" — an outage, a fix, a slow
  environment — that is **not** a question at all. Leave the task queued with a
  note, **work the rest of the queue**, and retry it later. Never convert an
  incident report into a dashboard question: there is nothing to answer, and it
  buries the questions that do need a person.

- **Blocked:** a real product/authorization decision → `task-set --status blocked
  --note "<question>"`, then **push a notification** so the operator sees it even
  away from the dashboard:
  `node <SCH_HOME>/scripts/notify.mjs "<project>: task #<id> needs you — <one-line question>" --title "SCH Loop"`
  (no webhook set = harmless no-op). End pass. It returns when the operator answers
  from the dashboard.

  **Write the question in plain language a non-developer can answer, and put ALL
  of it in `--brief`.** That is the field the dashboard renders. `--notes` is a
  one-line summary for the task table, so a note that says "see the task notes
  for the full question" points the operator at the very text they are reading —
  three real questions shipped in exactly that state and were unanswerable. The
  engine now refuses a block whose question is under 80 characters, contains no
  question mark, or refers the reader to somewhere else.

  **What is on the screen is the whole question.** The operator has the
  dashboard and nothing else — no repo, no logs, no context from your pass.
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
