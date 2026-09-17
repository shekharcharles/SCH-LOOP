---
name: sch-plan
description: Use when an approved architecture needs slicing into phases and vertical slices before tickets are written.
---

# Planning

Turn `.sch-loop/ARCHITECTURE.md` into `.sch-loop/PLAN.md`. That path matters: `sch-tickets` slices on it,
and `sch-verify` reads each phase's goal from it. This skill used to write `.sch-loop/plans/plan.md`, which
nothing downstream has ever read.

## Write `.sch-loop/PLAN.md`

```markdown
# Plan: <project>

## Phase 1 — <name>

<the phase goal as an OUTCOME a user could check, not a task list. `sch-verify` reads exactly this
paragraph and verifies the codebase against it, so write it as something that can be true or false.>

Slices:
- <vertical slice: one thing that works end to end when it lands>
  - covers: R-01, R-04
  - paths: src/…, tests/…
  - verify: <the command that proves it>
  - risk: <what could go wrong, and the stop condition>

## Phase 2 — <name>
…
```

## Rules

- Phases are ordered by dependency, not by layer. "All the models, then all the views" is not a plan.
- A slice is vertical: it works end to end when it lands, or it is not a slice.
- Every requirement ID from `PRD.md` appears in some slice. An unmapped requirement is a planning error.
- Name the verification command per slice. A slice nobody can check is not planned, it is hoped for.
- Do not build, and do not propose a rewrite the architecture did not ask for.
