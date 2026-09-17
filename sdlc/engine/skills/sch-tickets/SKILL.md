---
name: sch-tickets
description: Use when an approved plan must become the executable queue — writes task.md and one JSON per ticket.
---

# Tickets

Turn `.sch-loop/PLAN.md` into `task.md` (the human queue) and `.sch-loop/tickets/<id>-<slug>.json` (the machine contract). One command per ticket; nothing is hand-written into `task.md`.

## Shape of the work

- **Tracer first.** The first ticket of every phase is the thinnest path that touches every layer that phase will modify, wired end to end, with a real `verify`. Expansion tickets build out from the proven slice. A ticket that only "lays foundation" is a horizontal layer wearing a vertical hat.
- **After each ticket a user can do something they could not before.** If that is not true, the slice is wrong.
- **2–3 tickets per concern.** A ticket touching more than about five files is two tickets.
- **Order is priority.** The queue is read top to bottom, so put a ticket where it must run; dependencies are the exception, not the mechanism.

## Write each ticket

```sh
node "$CLAUDE_PROJECT_DIR/.claude/sch/runtime/cli.mjs" insert - <<'JSON'
{
  "phase": "1",
  "type": "build",
  "title": "Password reset flow",
  "size": "M",
  "deps": ["T1.2"],
  "read_first": ["src/auth/login.ts", ".sch-loop/ARCHITECTURE.md"],
  "allowed_paths": ["src/auth/**", "tests/auth/**"],
  "action": "Create POST /auth/reset that accepts {email}, always answers 202, and stores a 15-minute token. Use the existing mailer; do not add a dependency.",
  "interfaces": ["POST /auth/reset {email} -> 202", "resetToken(email): string"],
  "acceptance": ["valid email returns 202 and a token row exists", "unknown email returns 202 and no row is created", "a token older than 15 minutes is rejected"],
  "must_not": ["no existing test deleted or skipped", "the token is never written to a log"],
  "verify": [{"name": "test", "command": "npm", "args": ["test", "--", "auth"]}],
  "requirements": ["AUTH-03"]
}
JSON
```

## Fields that decide behaviour

| Field | Effect |
|---|---|
| `type` | `build`/`test` run TDD and review · `spike`/`research`/`docs` do not · `human`/`decision` never spawn an executor · `chore` reviews lightly |
| `size` | picks the timeout: XS 5 min, S 15, M 30, L 60 |
| `allowed_paths` | the write boundary. Anything outside fails the attempt. Required for code types |
| `acceptance` | becomes the Judge's checklist and the reviewer's spec verdict |
| `must_not` | anti-Goodhart: the boundary that stops "delete the failing test" from counting as done |
| `verify` | argv arrays, never a shell string. Must be able to fail |
| `council: true` | convene the council before this ticket runs |
| `gate: blocking-human` | never auto-approved, in any mode |

## Rules

- Every requirement ID from `PLAN.md` appears in at least one ticket. An unmapped requirement is a planning error — report it, do not quietly drop it.
- Never write "v1", "simplified for now", "static placeholder", "wired later". If it does not fit, split the phase and say so.
- `action` is directive prose. No code blocks — implementation belongs to the executor.
- Validate before you celebrate: `cli.mjs tasks` should show every ticket parsed, with the deps you intended.

## Gate

Present the queue (`cli.mjs tasks`) as a short table: id, type, title, deps, size. The user approves or edits. Then `go`.
