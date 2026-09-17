---
name: sch-prd
description: Use when an approved brainstorm needs a PRD with numbered requirements before any architecture or planning work.
---

# PRD

Turn `.sch-loop/BRAINSTORM.md` into `.sch-loop/PRD.md`. Requirements only — what must be true and why. No file paths, no libraries, no task breakdown; those belong to `sch-architecture` and `sch-plan`.

## Before writing

Read `.sch-loop/BRAINSTORM.md`. Its locked decisions (`D-01`, `D-02`, …) are non-negotiable; its deferred ideas must not reappear here.

Ask only what you cannot infer, one question at a time, and only when the answer changes scope:

1. Who has this problem — a specific role, not "users"?
2. What is the observable pain today?
3. What evidence says it is real? A quote, a ticket, a metric, an observed workaround.
4. What is the minimum that tests the hypothesis?
5. What are you explicitly not building?

Missing evidence is written as `Assumption — needs validation via <method>`. Never invent a plausible-sounding requirement.

## Write `.sch-loop/PRD.md`

```markdown
# PRD: <product or feature>

## Problem
<2–3 sentences: who, what pain, what it costs to leave unsolved>

## Evidence
- <quote, metric or observation>
- <or: Assumption — needs validation via user interview>

## Users
- **Primary**: <role, context, what triggers the need>
- **Not for**: <who this excludes>

## Hypothesis
We believe **<capability>** will **<solve problem>** for **<users>**.
We will know we are right when **<measurable outcome>**.

## Requirements (v1)
### <CATEGORY>
- [ ] **<CAT>-01**: <specific, testable, user-facing statement>
- [ ] **<CAT>-02**: …

## Out of scope
| Item | Why |
|---|---|

## Success metrics
| Metric | Target | How measured |
|---|---|---|

## Open questions
- [ ] <question that could change scope>

## Traceability
| Requirement | Phase | Status |
|---|---|---|
| <CAT>-01 | TBD | Pending |
```

## Rules

- Every requirement gets an ID `CAT-NN`. `sch-plan` must map every one to exactly one phase; an unmapped requirement is a planning error, so do not create requirements you cannot defend.
- Requirements are user-observable. "bcrypt is installed" is not a requirement; "passwords are never stored in plain text" is.
- v2 ideas go under Out of scope with a reason, never into v1 "just in case".
- Do not start architecture. When the PRD is approved, route to `sch-architecture`.

## Gate

Present the PRD and stop. The user approves, edits, or rejects. Approval is what unlocks `sch-architecture`; record it by setting `lifecycle_stage: ARCHITECTURE` in `.sch-loop/state.json`.
