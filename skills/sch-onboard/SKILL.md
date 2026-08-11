---
name: sch-onboard
description: Adopt an EXISTING repository into SCH Loop. Reads the code, runs its own build and tests, finds broken and unused code with real tools, and reports what it understood, what is missing, and what it could not verify — then asks exactly three questions and hands off to brainstorming. Use for any repo that already has code. Interactive.
---

# SCH Loop — adopt an existing repository

`sch-spec` interviews an operator about a product that does not exist yet. Point
it at a repository that already exists and it interviews you anyway — it never
reads the code, never runs the build, never says what it found. This skill is
that missing step.

> **Engine home (`SCH_HOME`):** `$HOME/.claude/SCH-loop`. Run
> `node scripts/…` from there or by absolute path.

**The output is understanding, not tasks.** Nothing is planned here. You end by
asking three questions and handing to `/SCH brainstorm`.

---

## The one rule

**Every claim cites evidence, or it is not made.**

The collector below writes `.sch-loop/onboard/evidence.json` — file counts, the
languages by line, the exit code of the repo's own test command, tool output for
dead code, git churn, files nothing imports. You may state what that file
supports and what you have read with your own eyes. You may not state:

- "there are no tests" — unless a test command ran and you can name its exit code
- "this code is unused" — unless a dead-code tool reported it, and even then see §4
- "the architecture is X" — unless you read the files that make it X, and can cite them
- "this is well/badly written" — an impression is not a finding; name the defect and the line

When you cannot verify something, say so **in the report, by name**. A gap in the
evidence is a finding about the engagement, not a hole to fill with plausible
prose. `advise-project-approach` puts it well: never pretend file inspection
happened when only descriptions were provided.

---

## 1. Register and index

If the project is not registered yet:

```bash
node scripts/state.mjs project-add --id <slug> --name "<Name>" --domain app-dev \
  --path "<absolute repo path>" --description "<fill this in AFTER you understand it>" --stack "<same>"
node scripts/graph-index.mjs --project <slug> --all
```

The graph must be indexed before the collector runs, or the "nothing imports
this" list comes back empty and you will report a false clean.

## 2. Collect the evidence

```bash
node scripts/onboard.mjs --project <slug>            # runs the repo's own build/test
node scripts/onboard.mjs --project <slug> --no-run   # inventory only, baseline stays UNKNOWN
```

Default to the full run. It executes only commands the repository itself
declares (`package.json` scripts, `pytest` under a `pyproject.toml`, `go test`,
`cargo test`) — never a command you invented. If a repo declares nothing, that
is the finding.

**Read `evidence.json` in full before writing a word of the report.**

Dead-code tools are run only when already installed. A missing tool is listed
under `tools_missing` — report it as a gap and offer the one-line install; never
install anything into the operator's project to make your report look complete.

## 3. Read the code that matters

The evidence tells you where to look; it does not do the looking. Read, at
minimum:

1. **Entry points** — what starts, and what it starts. `main`, `server`, `index`,
   route registration, CLI parsing, worker bootstraps.
2. **The hottest files** — `git.hottest_files` is the churn list. What changes
   most is where the risk and the real domain live.
3. **The largest files** — `inventory.largest_files`. A 2,000-line file is
   usually several ideas that never got separated.
4. **The data model** — schema, migrations, models, types. This is the product's
   actual vocabulary.
5. **The boundaries** — every external system: database, queue, payment, auth,
   storage, another team's API.
6. **Config and secrets handling** — how it is configured per environment, and
   whether anything sensitive is committed. Run `node scripts/secret-scan.mjs`
   and report the result either way.

Use the graph first — `sch_graph_search`, `sch_graph_explore` — before opening
files. A "does this already exist?" question is a graph question; crawling the
repo to answer it is the single most expensive thing this phase can do.

## 4. Broken and unused — carefully

Report these separately, because they carry different weight:

- **Broken** — the baseline failed, an import resolves to nothing, a script
  references a file that is not there, a test is skipped with a TODO. Cite the
  exit code or the line.
- **Unused (tool-reported)** — knip / ts-prune / vulture output. Reliable enough
  to act on, with review.
- **Unreferenced (graph)** — `graph.never_imported`. This is a list to **ask
  about, never to delete from**. Entry points, route files, migrations, fixtures,
  scripts and test helpers are all legitimately unimported. Presenting this list
  as dead code is the single easiest way to destroy a working repository.

## 5. Write the two documents

`UNDERSTANDING.md` at the repo root:

```md
# <Project> — what this is
## In one paragraph          — what it does, for whom
## How it runs               — entry points, commands, environments
## Architecture as built     — the real shape, with file paths
## The domain                — objects, their fields, their life cycle
## External systems          — what it talks to, and what breaks when that is down
## The baseline right now    — build/test/lint, each with its exit code
## What I could NOT verify   — by name. No apologies, no filler.
```

`GAPS.md`, ordered by impact, never by how easy it was to find:

```md
# <Project> — gaps and opportunities
## Broken now                — with evidence
## Unused / dead             — tool-reported, with the tool named
## Risk concentrations       — churn x size x no tests
## Missing safety nets       — tests, types, error handling, observability
## Enhancements worth doing  — each with the problem it solves, not the tech it uses
```

Then record the durable facts where the loop can find them:

```bash
node scripts/state.mjs project-meta --project <slug> \
  --description "<now you can write it truthfully>" --stack "<what you actually found>"
node scripts/state.mjs event-add --project <slug> --text "DECISION: … — because …"
```

## 6. Play it back, then ask exactly three questions

Summarise what you understood in a few lines and let the operator correct it
before anything else happens.

Then ask **three** questions — not five, not "a few". Three forces you to spend
them on what the code genuinely cannot answer. Pick from:

- **Intent** — which of the things you found is the product, and which is
  scaffolding nobody has removed?
- **Direction** — what is this repository *for* over the next quarter?
- **Constraint** — what must not change: an API contract, a database, a
  deployment, a customer promise?
- **Pain** — what breaks most often, or costs the most time?

A question whose answer is already in the code is a wasted question. Read first.

## 7. Hand off

```
/SCH brainstorm --project <slug>     # options and trade-offs, with the answers in hand
```

Brainstorm, then spec, then plan. **Do not plan from this document.** Onboarding
establishes what is true; brainstorming establishes what to do about it; only
then is there anything worth breaking into tickets.

---

## Rules

- Read the evidence file before the report; read the code before the questions.
- Never install a tool into the operator's project. Report it as missing.
- Never delete, refactor or "tidy" anything. This phase writes two markdown files
  and registry metadata. Nothing else.
- Unreferenced ≠ dead. Ask.
- Three questions. If you have a fourth, it means you have not read enough.
- End by handing to brainstorming, never by planning.
