---
name: sch-learn
description: Distill reusable, generalizable lessons from a finished SCH Loop task or engagement into the pack's knowledge base, so the next run starts ahead of zero. Reads findings + reviewer notes; appends deduped rules; never stores client/target-specific data. Called by sch-run/sch-ship or run directly with --project.
---

# SCH Loop — self-learning

Turn one engagement's experience into durable methodology. Runs after a phase or
at ship. Always `--project <id>`.

> **Engine home (`SCH_HOME`):** `$HOME/.claude/SCH-loop`. Run
> `node scripts/state.mjs …` from there or via the absolute path; the knowledge
> base lives at `SCH_HOME/knowledge/<pack>.md`.

## 1. Gather

```bash
node scripts/state.mjs project-get --project <id>          # domain → which knowledge/<pack>.md
node scripts/state.mjs finding-list --project <id>         # what was found + tested-clean
node scripts/state.mjs task-list --project <id>            # phases + notes
```

Also read the project's reviewer verdicts and `reports/` working notes. Read the
existing `knowledge/<pack>.md` first.

## 2. Distill — generalizable only

For each recurring or non-obvious lesson, write ONE reusable entry under the
right heading (Working techniques / Target-class patterns / False-positive
filters / Dead-ends / Tooling notes):

- A **working technique** that beat a control (a bypass, an oracle, a chain).
- A **target-class pattern** ("on Spring targets always probe /actuator/...").
- A **false-positive filter** (how you confirmed something was NOT a bug).
- A **dead-end** worth not repeating.
- A **tooling note** (a flag/tamper/config that worked).

**Hard filter:** strip every client/target-specific detail — no hosts, params,
creds, tokens, payload values tied to the target, or finding contents. If a
lesson only makes sense with the target named, it is NOT knowledge-base
material; leave it in `reports/`.

## 3. Append, deduped

- If a near-identical entry exists, **reinforce** it: bump its `seen:` count and
  merge any new nuance. Do not add a duplicate.
- Otherwise append a new entry with `seen:1`.
- Keep entries short — title, when-it-applies, the technique/filter.

Write the updated `knowledge/<pack>.md`. Log it:

```bash
node scripts/state.mjs event-add --project <id> --text "sch-learn: +N knowledge entries"
```

## Rules

- Never store target-specific data in the knowledge base.
- Never delete another engagement's lessons; only reinforce or add.
- Knowledge is methodology, not a findings dump. Findings stay in the project.
