---
name: sch-plan
description: Turn a project's PRD (dev) or SCOPE + pack phases (offensive) into a task queue in its state, and fold in new inbox ideas. First run interactive; the loop calls it unattended to absorb changes. Always operates on one --project.
---

# SCH Loop — planner

> **Engine home (`SCH_HOME`):** `C:\Users\r00t\Desktop\loop\SCH-loop`. Every
> `node scripts/state.mjs …` command and every `packs/…` file below lives there.
> If your terminal is in another folder, use the absolute path, e.g.
> `node C:/Users/r00t/Desktop/loop/SCH-loop/scripts/state.mjs …`.

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

## 2A. Dev / tool packs → feature tasks

Decompose the PRD into ordered phases and smallest-buildable feature tasks (one
day or less each). Each task gets its own `AC-N` and inherits relevant PRD
`NG-N`; no task's AC may require an NG. Order so each task is buildable from
merged code of its `deps`.

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

## 4. Confirm (interactive only)

Show the phase → task tree in chat before writing when the user is present. In
unattended mode (called by `sch-run` step 0), write directly and log.

## Rules

- Never duplicate an existing task — check `task-list` first.
- Never invent scope the contract does not support. Scope growth for dev is a
  PRD change; for offensive it is a SCOPE change — both are human decisions.
- Dev tasks small; offensive tasks are whole phases (per your chosen unit).
