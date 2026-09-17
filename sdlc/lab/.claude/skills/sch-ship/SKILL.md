---
name: sch-ship
description: Use when a phase has passed verification and the work should leave this machine — re-runs the release gates and opens the pull request.
---

# Ship

Run it:

```sh
node .claude/sch/runtime/cli.mjs ship <phase> --dry-run   # every gate, nothing pushed
node .claude/sch/runtime/cli.mjs ship <phase>             # gates, then the pull request
```

Always dry-run first. It is the same code path minus the push, so a green dry run means the only thing left is the network.

## What the gates are

They run in this order and the first NO-GO stops everything. Code owns them; no model votes.

| Gate | NO-GO when |
|---|---|
| branch | `HEAD` is the base branch — there is nothing to open a pull request *from* |
| queue | any ticket in the phase is not `[x]` |
| phase verification | `.sch-loop/verify/phase-<n>.md` is missing, unreadable, or not `passed` |
| working tree is clean | anything uncommitted, untracked included |
| there is something to ship | no diff against the base |
| no secrets in the diff | an added line matches a secret pattern |
| release checks | the configured check command exits non-zero |

## Rules

- Never ship because a council approved a design. A council approves an idea; these gates check an artifact.
- Never ship a phase whose verification is `gaps_found` or `human_needed`. Absence of a verification file is not approval.
- The release record at `.sch-loop/releases/phase-<n>-<timestamp>.md` names the gate that stopped it and carries the rollback steps. Read it before rerunning, not after.
- A failed `gh pr create` is a NO-GO, never a silent success.

## Rollback

Every release record ends with the three steps for the pull request it opened: close it, delete the branch, and note that the base branch was never written to. Follow the record rather than reconstructing it.
