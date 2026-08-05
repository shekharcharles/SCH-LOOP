# ADR 0007 — Notice the escape you cannot prevent

**Status:** accepted · Narrows ADR 0004's largest stated gap
**Date:** 2026-08-06

## Context

ADR 0004 said it plainly: *a write outside the worktree is neither prevented nor
detected.* `inspectEffects` compares the repository the worker ran in, so a
worker that reads the main repository's path out of its own `.git` file and
writes there is invisible to it.

ADR 0006 made that worse by making sibling worktrees ordinary: N tasks now run at
once, each with a checkout the others can reach by walking up one directory.

## Decision

**Detect what cannot be prevented, and be exact about which is which.**

`scripts/territory.mjs` fingerprints a directory — a bounded walk recording
`size:mtime` per file, hashed. The runner fingerprints two territories as part of
the baseline and compares them after the worker stops:

1. the **main repository** the task was branched from, and
2. every **sibling task worktree** under the shared worktree root.

A difference fails the run as `OUTSIDE_WORKTREE_WRITE` → `NEEDS_DECISION`, with
nothing reverted and the evidence kept. A new FACTUAL gate,
`worker-stayed-in-its-worktree`, reports what was watched and what was excluded.

**Exclusions are the correctness problem, not a detail.** SCH writes its own run
evidence into `.sch-loop/` in the main repository *during the run being
inspected*; watching it would report SCH as the intruder. `.git`, `.sch-loop` and
`node_modules` are excluded, and every result names its exclusions so nobody has
to guess what was watched.

**Truncation is never silence.** A walk that hits its entry bound reports
`truncated`, and comparing a truncated fingerprint yields `inconclusive` rather
than `same`. A check that could not see everything must not sign off on
everything, so the gate fails on inconclusive rather than passing.

## Alternatives rejected

- **Content hashes instead of size+mtime.** Hashing every file in a repository
  twice per run costs more than the protection is worth. The consequence is
  stated rather than hidden: a writer that restores both the byte count and the
  mtime is not detected. This is a defence against a careless escape, not a
  determined one.
- **Watching the whole filesystem.** Not possible without an OS boundary, which
  is a later milestone. Claiming it here would be the exact false claim this
  project refuses to make.
- **Preventing the write.** Also needs the OS boundary. Detection after the fact
  is what is honestly available today.
- **Watching `SCH_HOME`.** SCH mutates it legitimately throughout a run; the
  false-positive rate would make the check useless.

## Consequences

- Every run pays two bounded directory walks per territory. Measured at no
  significant cost against the existing suite.
- Runs in the main repository itself — the legacy single-task runner — have no
  outside to watch. The gate reports "not applicable" rather than a pass.
- A worker that writes into a sibling task's checkout now fails its own run,
  which is the honest place to fail: SCH cannot know what it did to the sibling.

## What is still NOT true

- Writes to the home directory, another project, or anywhere else on disk are
  invisible.
- Nothing is prevented. The worker still runs as the operator with the
  operator's PATH and unrestricted network.
- A writer that forges size and mtime defeats this entirely.
