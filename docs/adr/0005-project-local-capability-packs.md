# ADR 0005 — Give the worker a catalogue, not the operator's catalogue

**Status:** accepted · Narrows ADR 0004's containment to the skill surface
**Date:** 2026-08-05

## Context

ADR 0004 contained where a worker *runs* — a disposable worktree, a stripped
environment, a bounded process. It did not contain what a worker *knows how to
do*.

A worker inherited the operator's entire installed skill catalogue: every skill
in `~/.claude`, every plugin, every methodology the operator happens to use. SCH
selects skills per task and injects the chosen ones into the prompt, so the
selection was real — but it governed only what was *recommended*, never what was
*reachable*. A worker could invoke anything installed on the machine.

That is a containment gap and a correctness gap at once. A task scoped to one
capability could reach for an unrelated methodology mid-run; two overlapping
skill sets could contradict each other inside one prompt; and a built-in that
schedules future agents could create work outside SCH's queue, lease and path
policy entirely — the one thing this system exists to prevent.

## Decision

**One generated capability pack per task, and the worker is launched with that
and nothing else.**

- `scripts/pack.mjs` builds a plugin directory containing exactly the skills SCH
  approved for the task. It is generated per run, never copied from a template
  and never hand-edited.
- The pack is built **outside the managed repository**, beside the worktree. A
  generated `.claude/` inside the worktree would be an unexpected file change and
  would trip the clean-tree gate.
- The worker is launched with `--plugin-dir <pack> --setting-sources project`.
  The second flag is what suppresses `~/.claude`; the first is what replaces it.
- Anything that can execute is refused at pack time. `SKILL.md` and its
  supporting documents are carried; hooks, scripts and nested plugin manifests
  are refused, and every refusal is recorded in the pack rather than dropped
  silently.
- Built-in skills are policed by **versioned data**, not by code: an allow list,
  a deny list, and a list of every built-in this build has seen. A name on
  neither list is denied, and a name on both is denied — the safe reading of an
  editing mistake is the restrictive one.
- Preflight builds the pack **before** the worker is prepared. A pack that cannot
  be built fails the run as `PACK_UNAVAILABLE`, which is `NEEDS_DECISION` rather
  than `RETRYABLE`: a worker launched without its pack falls back to whatever the
  CLI finds, which is precisely the failure this ADR exists to prevent, and
  retrying does not change it.
- The pack's lifetime matches the worktree's: removed on `DELIVERED` and
  `CANCELLED`, kept on `FAILED`, because on a failed task it is part of the
  evidence of what the worker was given.

**Required skills are injected; recommended skills are indexed.** A required
skill's body still goes into the prompt in full. A recommended one contributes a
single line naming its pack invocation id. The asymmetry is deliberate and is not
a token optimisation: SCH *guarantees* a required skill is in context, and making
that guarantee depend on the model choosing to invoke it would invert this
system's rule that code owns the decision and the model owns bounded execution
inside it.

## Alternatives rejected, and why

- **`--safe-mode`.** Suppresses far more than the global catalogue, leaving a
  project unable to grant a worker any skill at all. Containment that also
  removes the capability is not containment, it is amputation.
- **`--bare`.** Forces `ANTHROPIC_API_KEY` and breaks subscription
  authentication, which is how this system is actually run.
- **A `.claude/` directory inside the worktree.** The natural place, and wrong:
  it is a file change the worker did not make, and the clean-tree gate would
  correctly report `UNEXPECTED_FILE_CHANGE` on every run.
- **Denying built-ins in code rather than data.** A denylist compiled into logic
  cannot be versioned, reviewed or diffed. As data it can be, and the "unknown
  means denied" rule then covers built-ins a future CLI ships that nobody here
  has classified.

## Consequences

- A skill that needs its own scripts cannot be packed. Only documents are
  carried. This is a real capability loss, taken deliberately: shipping a
  worker an executable that SCH did not verify would undo ADR 0004.
- Skill selection now has teeth. A skill SCH did not select is not merely
  un-recommended, it is absent — so a wrong selection is now a wrong *capability*
  and shows up as a failed task rather than as a worker quietly reaching past it.
- The pack is another artifact with a lifetime, and a lifetime is a thing that
  can leak. It is tied to the worktree's so there is one rule, not two.

## What is still NOT true

- **A denied built-in is still listed to the worker.** Denial blocks invocation,
  not discovery: `--disallowed-tools "Skill(init)"` returns *"Skill execution
  blocked by permission rules"* when invoked, while the name remains in the
  worker's skill list. Roughly a dozen names therefore remain as context cost.
  No flag removes them without removing the pack as well.
- **None of this is an OS boundary.** Every caveat in ADR 0004 stands unchanged.

## How to re-verify this against a new CLI release

The strongest verification — *a real worker's skill listing contains no globally
installed skill* — cannot live in the test suite. `tests/helpers.mjs` guarantees
no real model is ever invoked, and that guarantee is worth more than the
assertion. The suite therefore asserts the deterministic half: that SCH
constructs the right pack and the right argv.

The behavioural half was established by probe, and the probe is reproducible:

```bash
claude -p --plugin-dir <pack> --setting-sources project \
  <<< "List the exact name of every skill available to you, one per line."
```

Run it against a new CLI release rather than trusting this note. If a future CLI
stops listing denied skills, the residual above can be deleted — and
`tests/containment.test.mjs` carries a known-gap test whose comment says so.
