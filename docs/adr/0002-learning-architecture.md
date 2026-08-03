# ADR 0002 — Learning is structured; `LEARNING.md` is a view of it

**Status:** accepted (Stage 0 — records the architecture; no store is built)
**Date:** 2026-08-03

## The failure mode

A single growing markdown file of "lessons" is the obvious design and the wrong
one. It has no provenance, so nobody can tell whether a line came from a verified
fix or a guess that felt right at 2am. It has no lifecycle, so a temporary
observation about one broken staging box becomes permanent policy. And it gets
loaded whole, so every task pays for every lesson ever recorded, most of which
have nothing to do with it.

## Categories

Learning is typed. A record is exactly one of:

| Category | What it is | Lifetime |
|---|---|---|
| `FACT` | Something true about the system, verified | until contradicted |
| `DECISION` | A choice a human made, with its reason | permanent record |
| `ASSUMPTION` | Something taken as true without verification | until confirmed or refuted |
| `LESSON` | A generalizable rule learned from an outcome | until superseded |
| `FAILURE_PATTERN` | A way this system breaks, and the tell | until fixed upstream |
| `REPOSITORY_CONVENTION` | How this codebase does a thing | until the codebase changes |
| `SECURITY_POLICY` | A rule that constrains what may be done | permanent unless revoked by a human |
| `TEMPORARY_OBSERVATION` | True right now; probably not next week | short, explicitly expiring |
| `DEPRECATED_KNOWLEDGE` | Was true, is not; kept so it is not re-learned | tombstone |

## Rules

- **The structured store is authoritative.** `LEARNING.md` (and the per-pack
  `knowledge/*.md` files) become **generated, human-readable views** of it — read
  by people, never the source of truth.
- **An agent may propose learning. It may not enact it.** A proposal is recorded
  as a proposal.
- **An unverified lesson is never standing policy.** Promotion to something that
  constrains future work requires verification or a human decision. In
  particular, nothing an agent proposes may become a `SECURITY_POLICY`.
- **Provenance is mandatory.** Every record keeps where it came from: the project,
  the task, the run, the source commit, and when. A lesson whose origin cannot be
  named cannot be trusted, and cannot be re-checked when it turns out to be
  wrong.
- **Retrieval is task-specific.** A worker asks for what bears on its task —
  these files, this component, this failure class. It does not receive the
  corpus.
- **The full corpus is never loaded automatically.** Not into a worker, not into
  the controller, not into a routine prompt.
- **Contradiction is resolved by tombstoning, not editing.** Superseded knowledge
  becomes `DEPRECATED_KNOWLEDGE` with a pointer to what replaced it, so the same
  wrong lesson is not learned twice.

## Not implemented here

Stage 0 does **not** build a learning database, a memory service or an MCP for
this. It records the target so that what does get built is not a bigger
`LEARNING.md`. The existing `sch-learn` skill and `knowledge/*.md` files continue
to work exactly as they do today; they are the view this ADR describes, ahead of
the store that will generate them.
