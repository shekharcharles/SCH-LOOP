---
name: sch-insert
description: Use when new work is discovered mid-run and must land at the right position in task.md without renumbering anything.
---

# Insert

Add one ticket at the correct place in `task.md`. Because the queue is read top to bottom, position is priority: a ticket inserted after `T1.3` runs before `T1.4`, without any scheduler change.

## Run it

```sh
node "$CLAUDE_PROJECT_DIR/.claude/sch/runtime/cli.mjs" insert - <<'JSON'
{
  "after": "T1.3",
  "type": "build",
  "title": "Rate-limit the reset endpoint",
  "deps": ["T1.3"],
  "size": "S",
  "allowed_paths": ["src/auth/**", "tests/auth/**"],
  "read_first": ["src/auth/reset.ts"],
  "action": "Add a 5-per-hour limit per email on POST /auth/reset, returning 429 with a Retry-After header.",
  "acceptance": ["6th request in an hour returns 429", "Retry-After is present and in seconds"],
  "must_not": ["no existing test deleted or skipped"],
  "verify": [{"name": "test", "command": "npm", "args": ["test", "--", "auth"]}],
  "requirements": ["AUTH-05"]
}
JSON
```

`after: "<id>"` puts it directly below that ticket's family and gives it a letter suffix (`T1.3a`, then `T1.3b`).
`phase: "2"` instead puts it at the end of that phase with the next integer id.

## Decide where it goes

| The new work… | Insert |
|---|---|
| must happen before a later ticket can be correct | `after` the ticket it follows |
| was found while building ticket X and blocks X | `after: X` — it will be picked up next |
| is independent and can wait | `phase:` at the end of the right phase |
| belongs to a phase that does not exist yet | stop; that is a plan change, route to `sch-plan` |

## Rules

- Never renumber. Never rewrite `task.md` wholesale — the write-guard hook blocks a shrinking Write, and the CLI edits in place.
- Every ticket needs `acceptance`; `build`, `test` and `chore` also need `allowed_paths` and `verify`. The command refuses an invalid ticket before it touches `task.md`.
- Pick the type honestly: `spike` for exploration, `research` for reading, `human` for something only a person can do, `decision` for a call the council or the user must make. Only `build`/`test` run TDD.
- One ticket per insert. If you are describing two things, that is two tickets.

## After inserting

Say the new id and what it displaced in the running order, in one line, then continue the run. Do not re-plan.
