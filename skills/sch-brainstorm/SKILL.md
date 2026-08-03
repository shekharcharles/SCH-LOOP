---
name: sch-brainstorm
description: Explore options and trade-offs for an SCH Loop project before anything is specified or planned. Records proposals separately from approved decisions, and authorizes no implementation. Interactive. Reached via /SCH brainstorm; runs between /SCH spec and /SCH plan, or any time an open question needs options rather than an answer.
---

# SCH Loop — brainstorm

> **Engine home (`SCH_HOME`):** `$HOME/.claude/SCH-loop`.

Interactive by definition. This is the one place in the loop where the right
output is **options with trade-offs**, not a decision and not code.

## The contract

1. **Explore, don't converge early.** Put at least two genuinely different
   options on the table. One option is not a brainstorm; it is a decision
   wearing a costume.
2. **Trade-offs, stated.** Each option gets what it costs, what it buys, and
   what it forecloses. An option with no downside listed has not been thought
   about.
3. **Proposals are not decisions.** Everything produced here is a proposal until
   the operator approves it. Keep the two apart in what you write and in what
   you record.
4. **Authorize nothing.** No implementation, no files edited in the target
   project, no tasks created as work. A brainstorm that starts building has
   stopped being a brainstorm.
5. **Ask when the answer changes the product.** Architecture, scope, security,
   delivery — those questions go to the operator. Anything you can defensibly
   default, default, and say what you defaulted.

## Where it lands

- A proposal the operator has **not** approved → the project inbox, marked as a
  proposal:
  `node scripts/state.mjs inbox-add --project <id> --text "PROPOSAL: <option> — trade-off: <what it costs>"`
- A decision the operator **has** approved → an event, so the record survives
  this session:
  `node scripts/state.mjs event-add --project <id> --text "DECISION: <what was decided> — because <why>"`
  and, when it changes the contract, into `PRD.md` / `SCOPE.md` via `/SCH spec`.
- An open question the operator must answer and the loop cannot default → a
  blocked task carrying the **whole** question, the options, what each one means,
  and your recommendation. The operator reads it on a phone with only the
  dashboard: if it does not stand alone on that screen, it is not a question.

## Reuse before inventing

If `superpowers-brainstorming` is discovered and approved, use it — it is the
better-developed version of this conversation, and SCH is not in the business of
re-implementing it:

```bash
node scripts/state.mjs skill-recommend --project <id> --type planning
```

Never load an unreviewed skill's body into this session on the strength of it
merely being installed. If it is UNREVIEWED, recommend approving it and continue
with this skill's contract in the meantime.

## Done when

The operator has a small set of options they can choose between, each with its
trade-off; approved decisions are recorded as decisions; everything else is
recorded as a proposal. Then `/SCH spec` (to fold a decision into the contract)
or `/SCH plan` (to decompose it). Not `/SCH run` — this skill never starts work.
