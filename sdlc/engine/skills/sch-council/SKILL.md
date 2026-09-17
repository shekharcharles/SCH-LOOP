---
name: sch-council
description: SCH-LOOP v2 evidence-weighted multi-model Council for consequential development decisions.
---

# Council

Council is for architecture, security, debugging, product, design, or course-correction questions that benefit from disagreement.

It is not the same as ticket verification.

## When the loop convenes one by itself

You do not call this for a red ticket. The recovery ladder does. When a ticket burns every executor
attempt, `escalate.mjs` convenes a council on the failure, writes the verdict onto the ticket, and puts
the ticket back in the queue **once**. The next executor reads the verdict as part of its brief.

The gate is in `.sch-loop/config.md`: `council_mode` (`gated` | `always` | `off`) and
`council_minimum_seats`. Seats come from `roles.json`, so which CLIs sit on a council is configuration,
never code. A ticket gets one council; a second red goes to the human, because a second council on the
same red is the loop arguing with itself at full token price.

A seat that cannot answer — installed but logged out, rate limited, gone — costs its own seat and
nothing else. The debate continues on the seats that answered, and `absentSeats` in the council state
records who was missing. Below two answering seats the council fails and the ticket goes to the human.

## Execution

Do not stage the debate yourself. Proposals written in one context by one model are
not independent, and a synthesis of your own arguments is not a Council verdict.
Run the engine:

```sh
node "$CLAUDE_PROJECT_DIR/.claude/sch/runtime/cli.mjs" council <spec.json>
```

Spec:

```json
{
  "question": "One decision, stated precisely, with the options if they are already known.",
  "roles": ["architect", "security", "minimalist"],
  "context": {"constraint": "frozen facts the seats may rely on"}
}
```

- Available roles include the four seeded in `roles.json`: `architect`, `skeptic`, `pragmatist`,
  `critic`. The rest are listed below.
- `roles` are seated across *distinct* providers before any provider repeats, and the
  chair prefers a provider that holds no seat. A council on one model is one model
  arguing with itself. Available roles: `architect`, `security`, `implementer`,
  `tester`, `sre`, `performance`, `minimalist`, `historian`, `devils-advocate`.
- Default roles are `architect, security, minimalist` if omitted. Two seats minimum.
- `seats` may be given explicitly as `[{"role","providerId","model"}]` to override, and
  `chair` as `{"providerId","model"}`.
- `context` is frozen at the start and is the only shared ground the seats get. Put the
  real constraints in it; a council briefed on nothing debates nothing.

Cost: seats × 3 phases, plus one adversarial challenge and one synthesis. Three seats
is eleven model calls and runs for minutes. Use it for decisions that are expensive to
reverse, not for choices you can default.

The verdict is printed to stdout; run metadata and the transcript directory go to
stderr. Exit `0` when the council completed, `1` when it failed or was cancelled.
`council-show <id>` re-reads a past council; `status` lists them.

If the engine cannot run, say so. Do not substitute a summary of your own reasoning
for a verdict — a fabricated council is worse than no council, because it carries the
authority of a process that never happened.

## What the engine does

1. Freeze the exact question and repository context.
2. Select roles and provider/model for every seat.
3. Generate independent proposals in separate clean contexts.
4. Freeze proposals before any peer sees them.
5. Anonymize proposals for critique where practical.
6. Run cross-critique.
7. Run rebuttals.
8. Run a dedicated adversarial challenge.
9. Chair synthesizes using explicit evidence-weighted criteria.
10. Preserve material dissent, unknowns, reversal conditions, and required next evidence.
11. Council is read-only and cannot mark a ticket complete.
12. Accepted Council decisions flow back through spec/plan/tickets when they change approved implementation.

The Chair must not use simple majority voting.

Scoring weights are fixed in `runtime/council.mjs`: correctness 25, security 20,
maintainability 15, testability 15, complexity 10, performance 5, reversibility 5,
evidence 5.
