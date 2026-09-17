---
name: sch-build
description: Use when one specific ticket should be built now — runs fences, worktree, executor, checks, review, judge and the fail-closed merge for that ticket only.
---

# Build

Run one ticket through the full pipeline. For a whole queue use `sch-run`; this is the single-step form.

```sh
node "$CLAUDE_PROJECT_DIR/.claude/sch/runtime/cli.mjs" ticket T1.4
```

Add `--dry-run` to see the worktree, the fence result and the exact argv each role would be spawned with, without calling a model.

## Do not perform the loop yourself

You are not an acceptable judge of a diff you produced, and a Manager decision reached by reasoning is not a Manager decision. The engine owns the sequence:

1. **fences** — bypass mode refuses to start without a worktree, the write-guard hook and the destructive-bash hook. Reviewer and judge must be tool-restricted read-only, whatever permission mode they run in.
2. **worktree** — `sch/<id>-<slug>` under `.worktrees/<id>`. The main checkout is never edited by the executor.
3. **executor** — fresh process, ticket JSON + `read_first` only. TDD for `build`/`test`: the failing test comes first and must fail for the intended reason.
4. **check** — typecheck, lint, the ticket's `verify`, path containment, `must_not`, secret scan, and diff-matches-claims (the executor's own file list must equal git's).
5. **review** — fresh reviewer, two verdicts. Every CRITICAL/HIGH is handed to a second fresh process that tries to refute it; anything unrefuted or unverifiable stays blocking.
6. **judge → Manager** — fresh judge sees the diff and the evidence, never the executor's reasoning. Code decides PASS / RETRY / HUMAN.
7. **deliver** — commit exactly the changed files, fail-closed merge into the project, remove the worktree.

## Reading the outcome

`.sch-loop/reports/<id>.md` is the interface. It carries what was built, which checks failed, the review verdict, context tokens, and `what_did_not_work`. Read that, not the transcript.

| Result | What it means | Next |
|---|---|---|
| `PASS` | merged, `task.md` shows `[x]` | next ticket |
| `HUMAN` after 3 attempts | `[!]` | council when gated, else the user |
| `refused` | a fence does not hold | fix the fence; never disable one |
| merge conflict | branch kept, nothing lost | resolve, or insert a rebase ticket |

## Rules

- A failed delivery is a blocker, never a silent success. If the commit or merge fails, the ticket is `[!]` with the branch intact.
- Retries fix only the failed requirement. Already-passing requirements are protected; rewriting them is how a green ticket goes red.
- Package installs are a `human` ticket, not a deviation the executor may take.
- An architectural change discovered mid-ticket stops the ticket and produces a `decision` ticket. It is not absorbed.
