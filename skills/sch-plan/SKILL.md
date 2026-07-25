---
name: sch-plan
description: Turn a project's PRD (dev) or SCOPE + pack phases (offensive) into a task queue. INTERACTIVE by default — plays back what it understood, gets the operator's agreement on the phase map, then decomposes each phase into small verifiable tasks. The loop also calls it unattended to fold new inbox items. Always operates on one --project.
---

# SCH Loop — planner

> **Engine home (`SCH_HOME`):** `$HOME/.claude/SCH-loop`. Every
> `node scripts/state.mjs …` command and every `packs/…` file below lives there.
> If your terminal is in another folder, use the absolute path, e.g.
> `node $HOME/.claude/SCH-loop/scripts/state.mjs …`.
> **`--project` is optional** — auto-detected from the current folder. Check with
> `state.mjs project-here`.

**The plan is the product.** Everything downstream — what gets built, in what
order, how big each piece is, whether the loop stays on-task — is decided here. A
weak plan cannot be rescued by a good builder: it produces tasks that are too big
to finish cleanly, in an order that blocks itself, missing the half of the
requirement nobody said out loud. Spend the effort here.

## Two modes — know which one you are in

| Mode | When | Behaviour |
|---|---|---|
| **Interactive** (default) | The operator ran `/sch-plan`, or `sch-spec` handed off after writing the contract | Full loop below: play back understanding → agree the phase map → decompose → confirm → write. Ask as many rounds as it takes. |
| **Unattended** | `sch-run` step 1 calls it to fold new inbox items mid-loop | Skip §2 and §4 (no human is watching). Do §1, §5 placement rules, §6 write. Anything genuinely ambiguous becomes a DECISION task (§7), never a guess. |

If you are unsure which mode you are in, you are interactive.

---

## 1. Load everything first — never plan from the prompt alone

```bash
node scripts/state.mjs project-get --project <id>      # domain, path, scope, stack
node scripts/state.mjs stats --project <id>
node scripts/state.mjs task-list --project <id>        # never duplicate an existing task
node scripts/state.mjs inbox-list --project <id> --new
```

Read, in this order:

1. The contract — `PRD.md` (dev) or `SCOPE.md` (offensive). This is the agreement.
2. `packs/packs.json` for the project's `domain`, then `packs/<method>.md` — the
   methodology and its phases.
3. `knowledge/<pack>.md` — lessons from previous projects of this kind.
4. **The actual codebase**, for anything that already exists. Read the routes/
   models/components that the work will touch. A plan written without looking at
   the code invents work that is already done and misses work that is required.
   For an offensive project, read the recon output if any phase has run.

---

## 2. Play back what you understood — BEFORE proposing any task

**Interactive mode only. Do not skip this.** The operator wrote a contract in
their words; you read it in yours. The gap between those two is where every bad
plan comes from, and it is invisible until you say it out loud.

Write back, in **plain language a non-developer can check**, a brief containing:

- **What this is** — two or three sentences. What the product does, for whom.
- **Who uses it** — each role, and what that role can do.
- **The core journeys** — the three-to-six paths a real person takes through it,
  start to finish ("a member signs up → uploads a video → it transcodes → it
  appears in their profile → others comment").
- **What already exists** — from your read of the code, what is genuinely built
  already versus what the contract asks for. Be specific.
- **What is explicitly out** — the non-goals, restated.
- **What I am unsure about** — every place the contract could be read two ways.
  List them as numbered questions, not as assumptions.

Then ask, directly:

> **Does this match what you want? Anything I have understood wrong, or left out?**

**Iterate until the operator confirms.** They may correct you three times. That is
the cheapest possible place for a correction to happen — a misunderstanding caught
here costs one message; caught after twenty tasks are built it costs days. Do not
rush to the task list because the brief "looks about right".

### Then fill the gaps with real questions

The spec interview gets the shape. Planning needs the level of detail a builder
can act on without guessing. Ask in **rounds of 1–4 questions**, each with
concrete options and your recommendation first, until every item below is either
answered or explicitly marked not-applicable:

- **Order and priority** — what must exist first for this to be usable at all?
  What is the smallest version worth having (the MVP line)? What is explicitly
  "later"? Drawing this line is the single highest-value question you can ask.
- **Data shape** — what objects exist, what fields, what happens to them over
  time (draft → published → archived → deleted)? What is deleted for real versus
  hidden?
- **Permissions in practice** — for each role and each object: who can see, create,
  edit, delete? Where the contract says "admin can moderate", ask what moderating
  actually does.
- **Empty, error and limit states** — what is on screen with no data yet? What
  happens when something fails, when a file is too big, when a name is taken?
  These are half of the real work and are almost never in a contract.
- **External systems** — what does it talk to, what happens when that is down?
- **Anything that changes the design if it is true** — expected scale, offline
  use, data-residency or privacy obligations, regulated data, deadlines.

Stop asking when you can answer yes to: **could two different engineers read this
plan and build the same observable behaviour?** Not before.

---

## 3. Decide the shape — phases, then order, then size

This is the reasoning the operator asked for. Do it explicitly, and show your
working in §4.

### 3.1 Group into phases that mean something

A phase is a **coherent slice of the product**, not a layer of the stack and not a
sprint. `"Auth & accounts"`, `"Media pipeline"`, `"Discovery & browse"`,
`"Moderation"` are phases. `"Phase 2"` and `"Backend work"` are not — they tell
the operator nothing on the dashboard.

Every task carries two grouping fields:

- `--category` — one of `frontend`, `backend`, `ui-ux`, `infra`, `security`,
  `testing`, `docs`. The dashboard's top-level column.
- `--phase-name "<human name>"` — the coherent slice, plus `--phase <n>` for order.

Rules for phases:

- **6–12 tasks per phase.** Fewer than 3 and it is not a phase, fold it in. More
  than ~15 and it is really two phases wearing a coat.
- A phase should be **independently demonstrable** — when it is done, you can show
  the operator something that works end to end, not a half-wired layer.
- **Vertical, not horizontal.** "Auth & accounts" containing its models, its API
  and its screens beats "All models" then "All APIs" then "All screens". A
  horizontal plan produces nothing usable until the very end and hides integration
  failures until it is expensive to fix them.

### 3.2 Order by what unblocks the most

Order phases so each one builds only on **merged** work:

1. **Foundations that everything needs** — data model, auth, the app shell. If
   twenty tasks all need a `User` to exist, that comes first.
2. **The spine of the primary journey** — the one path that makes the product
   worth having, built end to end, thin. Prove the whole thing works before
   widening it.
3. **Widen** — the remaining journeys and roles.
4. **Harden** — permissions, limits, error and empty states, moderation.
5. **Finish** — polish, docs, release checks.

Within a phase, order by dependency and set `--deps` accordingly. A task whose
dependencies are unmet stays invisible to the loop until they merge, so the order
you write here is the order that actually happens.

### 3.3 Size: one task = one clean sitting for a stranger

Each task must be completable by a **fresh-context subagent in one pass** — it
gets no memory of anything else. That is roughly a focused change: one endpoint,
one component, one migration plus its model, one screen's layout.

**A task is too big if** its title needs "and", it touches more than a handful of
files, you cannot state a single check that proves it works, or you could not
describe it fully to a stranger in three sentences.

> `UI-4 watch-page redesign` — far too big. Split it:
> layout shell → player block → related rail → comments → responsive pass.

Oversized tasks are the specific failure that made earlier loops wander and
regress. When in doubt, split. Five small tasks that each land cleanly beat one
large task that half-lands and needs three correction rounds.

### 3.4 What every task must carry

- `--ac` — its own acceptance criteria, **observable** ("bad credentials show an
  inline error", not "auth works"). This is what the reviewer judges against.
- `--ng` — the relevant binding non-goals from the PRD.
- **Target files** — name the files it should touch, in the AC or notes. A
  boundary stops sprawl.
- **A verify step** — the exact check that proves it: a test to run, a command, a
  specific thing to see on screen.

```bash
node scripts/state.mjs task-add --project <id> --phase 2 --phase-name "Auth & accounts" \
  --category backend --title "Email + password login" \
  --ac "AC-1: valid credentials redirect to /dashboard | AC-2: bad credentials show an inline error, no redirect | verify: run auth tests + log in through the browser once" \
  --ng "NG-1: no social login in this task" --deps "3" --source plan
```

---

## 4. Show the plan and get agreement — before writing anything

**Interactive mode only.** Present the plan as a tree the operator can actually
read, and stop:

```
BACKEND
  Auth & accounts            7 tasks   ← nothing else can start until this lands
  Media pipeline             9 tasks
FRONTEND
  App shell & navigation     5 tasks
  Discovery & browse         8 tasks
...
MVP line: phases 1-4 (29 tasks). Everything after that is "later".
```

For each phase give one line on **why it is there and why in that position**. Then
ask:

> **Does this order and grouping match how you want it built? Anything to move,
> merge, split, or drop from the first release?**

Iterate until they agree. Only then write the tasks. Writing 60 tasks the operator
did not agree to is worse than writing none — they now have to review a queue
instead of a plan.

---

## 5. Fold in inbox items — reason each one into place

Inbox items are requests you (or the dashboard) submitted mid-run. For each new
item, think it through against the contract and the real codebase, then **place it
deliberately** — never append to the end of a 150-item queue:

- **Decompose it the same way.** One inbox message often contains eight separate
  requirements. Split them into properly-sized tasks; do not create one task
  called "do the inbox item".
- **Priority** (`--priority 1..5`, 1 = highest): a hot fix or something the
  operator flagged as urgent → 1–2 so `task-next` takes it before backlog.
  Routine → 3.
- **Phase**: slot it into the phase it belongs to. If it genuinely starts a new
  slice, name a new phase.
- **Deps**: if it can only run after other work, set the dependency so it stays
  hidden until ready.
- **Scope change?** If it expands the product beyond the PRD, say so. Interactive:
  stop and ask. Unattended: create it as a DECISION task (§7) — never silently
  widen scope.

**Tag every task created from an inbox item with `--source inbox#<inboxId>`** —
the literal id, e.g. `--source inbox#6`, never a bare `inbox`. That id is the
operator's trace: the dashboard shows an `INBOX #6` chip on each resulting task,
and typing `inbox#6` in the filter lists exactly what that one message became.

```bash
node scripts/state.mjs task-add --project <id> --priority 1 --phase 4 \
  --phase-name "Moderation" --category backend --title "..." --source inbox#6 --deps "..."
node scripts/state.mjs inbox-mark --project <id> <inboxId>
```

---

## 6. Offensive packs — the unit is the phase

Create **one task per pack phase** (`packs/packs.json` → `phases`), chained by
deps so the methodology runs in order and `report` is last. Tag each:

- `--target <host/package/device>` — must be an in-scope target from `SCOPE.md`.
- `--active true` for phases that run attack tooling (exploit, initial-access,
  privesc, lateral, rasp-bypass, dynamic); `--active false` for passive phases
  (recon, static, report). The scope gate only fires on `active` tasks — tag
  honestly.
- `--ac` = that phase's concrete objectives from the pack method.

```bash
node scripts/state.mjs task-add --project <id> --phase 1 --active false --target app.example.com \
  --title "Recon / mapping" --ac "subdomains | content discovery | tech fingerprint | API + GraphQL discovery"
node scripts/state.mjs task-add --project <id> --phase 3 --active true --target api.example.com \
  --title "AuthN / AuthZ" --ac "IDOR/BOLA on object endpoints | JWT alg-confusion | session mgmt" --deps "1"
```

Never create an offensive task whose `--target` is not in `SCOPE.md`. If the scope
is empty or unauthorized, plan **recon only** and tell the operator to arm the gate.

---

## 7. A question must never live only in the terminal (hard rule)

The operator is usually **away, with only the dashboard**. A question printed in
the terminal is invisible to them and stalls the loop until they happen to look.

Whenever planning raises a decision you will not make yourself — scope expansion,
an architectural fork, a risky approach — **write it into state** so it appears in
the dashboard's red NEEDS YOU banner with an answer box:

```bash
node scripts/state.mjs task-add --project <id> --priority 1 --category <cat> \
  --phase-name "<phase>" --title "DECISION: <short question>" \
  --notes "<the question in plain language: what must be decided, the options as
  WORDS (sign / encrypt / https-only — never A/B/C) with what each means in
  practice, a concrete example, and your recommendation + a default so the
  operator can simply reply 'use your default'>"
node scripts/state.mjs task-set --project <id> <newId> --status blocked --note "<same text>"
```

Then print it in the terminal too, and push it:
`node scripts/notify.mjs "<project>: decision needed — <one line>"`.

**Plan everything that is NOT blocked by the question.** Never stall an entire
inbox item on one open decision — write the unambiguous tasks now and leave only
the genuinely-blocked one as the DECISION task.

---

## Rules

- Never duplicate an existing task — check `task-list` first.
- Never invent scope the contract does not support. Growth is a PRD change (dev)
  or a SCOPE change (offensive) — both are human decisions.
- Dev tasks are small and verifiable; offensive tasks are whole phases.
- In interactive mode, **nothing is written until the operator agrees the shape.**
- Every task: a category, a named phase, its own AC, its NGs, target files, and a
  verify step. A task without an observable AC cannot be reviewed and will bounce.
