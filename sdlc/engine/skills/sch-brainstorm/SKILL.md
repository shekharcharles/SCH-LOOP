---
name: sch-brainstorm
description: Use when the problem or the shape of the solution is still uncertain, before any requirements exist.
---

# Brainstorm

Use when the problem or solution is still uncertain. Inspect repository truth first. Ask only decisions repository inspection cannot answer. Produce `.sch-loop/BRAINSTORM.md`. That path matters: `sch-prd` reads it, and this skill used to write
`.sch-loop/discovery/brief.md` instead, which broke the chain at its first link.

This artifact informs the build; it does not authorize one.

## Write `.sch-loop/BRAINSTORM.md`

```markdown
# Brainstorm: <what this is about>

## Outcome
<what is true for someone once this exists, in two or three sentences>

## Who it is for
<a specific role, not "users">

## Workflows
<the two or three journeys that matter, each as a sequence>

## Constraints
<what is fixed: platform, existing code, time, compatibility>

## Failure cases
<what going wrong looks like, and which of those must not happen>

## Locked decisions
- D-01 — <decision>. Why: <reason>.
- D-02 — …

## Deferred
<ideas explicitly not being pursued now, so they do not reappear downstream>

## Assumptions
- Assumption — needs validation via <method>

## Open questions
<what a person still has to answer>
```

## Rules

- Inspect the repository before asking anything. Most questions have answers in the code.
- A locked decision is binding on every later stage. Do not lock what you have not thought about.
- Never invent a fact to fill a section. Write it as an assumption and name how to check it.
