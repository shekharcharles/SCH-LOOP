---
name: sch-plan
description: Turn a project's PRD (dev) or SCOPE + pack phases (offensive) into a task queue in its state, and fold in new inbox ideas. First run interactive; the loop calls it unattended to absorb changes. Always operates on one --project.
---

# SCH Loop — planner

> **Engine home (`SCH_HOME`):** `$HOME/.claude/SCH-loop`. Every
> `node scripts/state.mjs …` command and every `packs/…` file below lives there.
> If your terminal is in another folder, use the absolute path, e.g.
> `node $HOME/.claude/SCH-loop/scripts/state.mjs …`.
> **`--project` is optional** — if omitted it is auto-detected from the current
> folder (the registered project whose `path` contains your cwd). Check with
> `state.mjs project-here`..

Read the project's pack, its contract, and the current queue, then produce or
update the task queue. Always scoped to `--project <id>`.

## 1. Load context

```bash
node scripts/state.mjs stats --project <id>
node scripts/state.mjs task-list --project <id>        # never duplicate
node scripts/state.mjs inbox-list --project <id> --new
node scripts/state.mjs project-get --project <id>      # domain + scope
```

Read `packs/packs.json` for the project's `domain`, and `packs/<method>.md`.
Read the contract: `PRD.md` (dev) or `SCOPE.md` (offensive).

## 2A. Dev / tool packs → SMALL, verifiable feature tasks

Decompose the PRD into ordered phases and the **smallest** buildable+verifiable
units — each doable by a fresh-context subagent in one clean pass (think a
focused change, not a whole page). "UI-4 watch-page redesign" is TOO BIG; split
it (layout shell → player block → related rail → comments → responsive pass).
A too-big task is what let the loop wander and regress.

**Group the work: category → named phase → tasks.** Every task carries:
- `--category` — one of `frontend`, `backend`, `ui-ux`, `infra`, `security`,
  `testing`, `docs`. This is the top-level grouping the dashboard shows.
- `--phase-name "<human name>"` — the phase it belongs to, named in plain English
  (e.g. "Auth & accounts", "Media pipeline", "Discovery UI"), plus `--phase <n>`
  for ordering. Several tasks share one phase name; the dashboard rolls them up
  with a count and progress bar (e.g. `backend › Auth & accounts — 3/7`).
- its own `AC-N` (observable) + relevant PRD `NG-N` (binding);
- **explicit target files** (name the files it should touch);
- a **verify step** (the exact check that proves it works — a test, a command,
  a specific DOM/behaviour to confirm).

```bash
node scripts/state.mjs task-add --project <id> --phase 2 --phase-name "Auth & accounts" \
  --category backend --title "Email + password login" --ac "..." --ng "..."
```

Order so each task builds only on merged code of its `deps`.

```bash
node scripts/state.mjs task-add --project <id> --phase 2 \
  --title "Email + password login" \
  --ac "AC-1: valid creds redirect to /dashboard | AC-2: bad creds inline error" \
  --ng "NG-1: no social login this task" --deps "3" --source plan
```

## 2B. Offensive packs → phase tasks (unit = phase)

Create **one task per pack phase** (`packs/packs.json` → `phases`), chained by
deps so the methodology runs in order and `report` is last. Tag each task:

- `--target <host/package/device>` — must be an in-scope target from `SCOPE.md`.
- `--active true` for phases that run attack/exploit tooling (e.g. exploit,
  initial-access, privesc, lateral, rasp-bypass, dynamic); `--active false` for
  passive phases (recon, static, report). The loop's scope gate only fires on
  `active` tasks, so tag honestly.
- `--ac` = that phase's concrete objectives from the pack method.

```bash
# web-pentest example
node scripts/state.mjs task-add --project <id> --phase 1 --active false --target app.example.com \
  --title "Recon / mapping" --ac "subdomains | content discovery | tech fingerprint | API + GraphQL discovery"
node scripts/state.mjs task-add --project <id> --phase 3 --active true --target api.example.com \
  --title "AuthN / AuthZ" --ac "IDOR/BOLA on object endpoints | JWT alg-confusion | session mgmt" --deps "1"
# ... through phase 7 (report), report deps = all prior phase ids
```

Never create an offensive task whose `--target` is not in `SCOPE.md`. If the
scope is empty or unauthorized, do not plan active tasks — plan recon only and
tell the user to arm the scope gate.

## 3. Fold in inbox ideas — reason placement into the queue

Inbox items are tasks/leads you (or the dashboard) submitted mid-run. For each
new item: think it through against the contract + codebase/attack-surface, then
**place it intelligently** — do not just append to the end of a 150-item queue:

- **Priority** (`--priority 1..5`, 1=highest): a hot lead / critical fix / an
  active exploit path the user flagged → high priority so `task-next` picks it
  before lower-priority backlog. Routine coverage → normal (3).
- **Phase**: slot it into the right methodology phase (offensive) or stage (dev).
- **Deps** (`--deps`): if it can only run after other work (needs a merged
  feature, or a foothold from an earlier phase), set the dependency so it stays
  hidden until ready.
- If it expands product scope / changes the engagement scope, flag it as a
  PRD/SCOPE change and — interactive — stop for the user; don't silently widen scope.

```bash
node scripts/state.mjs task-add --project <id> --priority 1 --phase 4 --title "..." --source inbox --deps "..."
node scripts/state.mjs inbox-mark --project <id> <inboxId>
```

This is why the dashboard "add" box works even with a huge queue: you drop a
lead, the next pass reasons it to the correct slot and priority, not the bottom.

## 3b. NEVER leave a question only in the terminal (hard rule)

The operator is usually **away, with only the dashboard**. A question you print in
the terminal is invisible to them and stalls the loop until they happen to look.

So whenever planning raises a decision you will not make yourself (scope
expansion, an architectural choice, a risky approach), **write it into state so it
appears in the dashboard's "NEEDS YOU" banner with an answer box**:

```bash
node scripts/state.mjs task-add --project <id> --priority 1 --category <cat> \
  --phase-name "<phase>" --title "DECISION: <short question>" \
  --notes "<the question in plain language: what must be decided, the options with
  what each means in practice, a concrete example, and your recommendation + a
  sensible default so the operator can simply reply 'use your default'>"
node scripts/state.mjs task-set --project <id> <newId> --status blocked --note "<same question text>"
```

Then also print it in the terminal (for when they *are* watching), and — if a
webhook is configured — push it:
`node scripts/notify.mjs "<project>: decision needed — <one line>"`.

Plan everything that is NOT blocked by the question. Never stall the whole inbox
item on one open decision: write the unambiguous tasks now, and leave only the
genuinely-blocked ones as the DECISION task.

## 4. Confirm (interactive only)

Show the phase → task tree in chat before writing when the user is present. In
unattended mode (called by `sch-run` step 0), write directly and log.

## Rules

- Never duplicate an existing task — check `task-list` first.
- Never invent scope the contract does not support. Scope growth for dev is a
  PRD change; for offensive it is a SCOPE change — both are human decisions.
- Dev tasks small; offensive tasks are whole phases (per your chosen unit).
