---
name: sch-verify
description: Use when a phase claims to be finished — checks the codebase actually delivers the phase goal, working backwards from the goal rather than forwards from the tickets.
---

# Verify

Every ticket in the phase is `[x]`. That is task completion, not goal achievement: a ticket can complete by creating a file that renders nothing. Verify what is true in the codebase.

Reports are not evidence. `.sch-loop/reports/*.md` says what the executor claimed; you check what exists.

## Method — goal-backward

1. **State the goal** from `PLAN.md` as an outcome, not a task list.
2. **Derive 3–7 observable truths** a user could check.
3. For each truth, find the artifacts that must exist, then the wiring that must connect them, then the data that must flow.

Four levels, in order — most gaps hide at level 3:

| Level | Question | How |
|---|---|---|
| exists | is the file there? | read it |
| substantive | is it real, or a stub? | look for placeholder returns, empty arrays, "coming soon", handlers that only `preventDefault` |
| wired | is it imported *and called*? | grep for use, not just import |
| flowing | does real data reach it? | trace each rendered value back to a query; a static fallback is not a data source |

A truth that asserts runtime behaviour (a state transition, a cleanup or ordering invariant) cannot be verified by presence. Either run the one named test that exercises it, or mark it **present, behaviour unverified** and route it to the human. Never call it verified.

## Write `.sch-loop/verify/<phase>.md`

```markdown
# Phase <n> verification

**Goal:** <from PLAN.md>
**Status:** passed | gaps_found | human_needed
**Score:** <verified>/<total> truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | user can reset a password | verified | src/auth/reset.ts:14 called from routes.ts:9; test auth/reset.test.ts passes |
| 2 | reset emails render | human needed | requires a mail client; no automated check |

## Gaps
- truth: <what failed>
  missing: <the specific thing to add>
  artifacts: <file — what is wrong>
```

## Outcomes

- **passed** — no gaps, no human items. Route to `sch-ship`.
- **gaps_found** — turn each gap into a ticket with `sch-insert`, positioned in this phase, then `go`. One gap-closure round; a second failure is a council gate.
- **human_needed** — `[?]`, notify, and say exactly what the person must look at and what "good" looks like.

## Rules

- Never mark a truth verified because the code looks right.
- A debt marker (`TODO`, `FIXME`, `XXX`) added by this phase is a gap unless it references a tracked issue.
- Do not fix anything here. Verification that repairs its own findings is not verification.
