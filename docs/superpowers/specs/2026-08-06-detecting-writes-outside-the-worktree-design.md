# Detecting writes outside the worktree — design

**Status:** approved, not yet implemented
**Date:** 2026-08-06
**Baseline:** `main` at `d8f41d6`, 463 tests passing
**Follows:** ADR 0004 (contained worker execution), ADR 0006 (parallel execution)

## The problem

ADR 0004 recorded it plainly: *"A write outside the worktree is neither prevented
nor detected. Effect inspection compares the worktree before and after; anything
else is invisible."*

`inspectEffects` snapshots the repository the worker ran in. A worker that reads
the main repository's path out of its worktree's `.git` file and writes there is
invisible to it. So is a worker that writes into a *sibling* task's worktree —
and ADR 0006 just made sibling worktrees the normal case rather than the
exception.

## What this can and cannot be

**It cannot detect arbitrary writes.** A worker runs as the operator with the
operator's PATH. Detecting a write to an arbitrary path needs an OS boundary —
a sandbox, a filesystem monitor, a job object. That is a later milestone, and
pretending otherwise here would be exactly the false claim this project refuses
to make.

**It can detect writes to SCH's own territory.** Three places are enumerable,
SCH-owned, and precisely the ones a worker reaches by walking up from its
worktree:

1. **The main repository working tree** — the operator's checkout, which the
   worker's `.git` file points at.
2. **Sibling task worktrees** — every other task's checkout under the shared
   worktree root, which ADR 0004 already named as a gap.
3. **The capability pack** — the worker's own skill catalogue, which it must
   not be able to widen mid-run.

Detection, not prevention. The worker is not stopped from writing; the run is
failed afterwards and the evidence kept.

## Decision

A new leaf module `scripts/territory.mjs` fingerprints a directory: a bounded
walk producing `{ path, size, mtimeMs }` per entry, hashed. Bounded because an
unbounded walk of a large repository would cost more than the run it protects.

- `fingerprint(dir, { exclude, maxEntries })` → `{ ok, hash, entries, truncated }`
- `compare(before, after)` → `{ same, added, removed, changed }`

The runner takes fingerprints **as part of the baseline** and compares them
during effect inspection, in the same place and at the same moment as the
existing git-effect inspection.

**Exclusions are the whole correctness problem.** SCH itself writes to the main
repository during a run — run evidence lives in `.sch-loop/`. Fingerprinting that
would report SCH's own writes as the worker's. Excluded: `.sch-loop`, `.git`, and
the task's own worktree. Everything excluded is named in the evidence, so nobody
has to guess what was and was not watched.

**Truncation is reported, never silent.** A walk that hits `maxEntries` returns
`truncated: true`, and a truncated fingerprint that compares equal is recorded as
`INCONCLUSIVE` rather than as a pass. A check that cannot see everything must not
claim everything is fine.

## Failure and gate

- New failure code `OUTSIDE_WORKTREE_WRITE` → `NEEDS_DECISION`. Not `FAILED`: the
  worker may have had a legitimate reason, and a person should see what it wrote.
  Not `RETRYABLE`: running it again writes there again.
- A new FACTUAL gate `worker-stayed-in-its-worktree`, reporting what it watched,
  what it excluded, and whether any fingerprint was truncated.

## Testing

Hermetic, as always. A fake worker that writes to the main repository must fail
the run with `OUTSIDE_WORKTREE_WRITE`; one that writes into a sibling worktree
must too; one that stays home must pass. A truncated fingerprint must report
`INCONCLUSIVE` rather than success — asserted by setting `maxEntries` low.

## Out of scope

- Prevention of any kind. This is detection.
- Writes anywhere else on the filesystem: `/etc`, the home directory, another
  project entirely. Named in the README as still-not-true.
- Network activity.
