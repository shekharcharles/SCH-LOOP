# <Project> — CLAUDE.md

Claude auto-reads this before every reply (and every fresh-context subagent in
this project inherits it). Non-negotiables for every change. Do not re-derive, do
not violate. **This file stays local — never commit it.** `sch-spec` fills each
`<…>` from the interview + a read of the real codebase; keep it SHORT.

## Stack
- **Backend:** <framework + version, entry point, key apps/modules>
- **Frontend:** <framework + where it lives; SSR vs SPA>. **Runs via:** <docker / dev server + port>

## Design system — single source of truth
- **Tokens + UI primitives live in `<path>`**, loaded once via `<entry template>`.
  Add to the token layer; never hardcode colors/spacing or start a second pipeline.
- **Theming / dark mode:** `<class or mechanism>`. Reuse primitives; never duplicate one.

## Workflow (how the loop runs — Boris's rules)
- **Plan first** → small verifiable tasks (files + verify step). **Subagents:** one
  task per fresh-context subagent. **Verify before done:** prove it (test/lint/log),
  no "green" without evidence — "would a staff engineer approve this?". **Explain &
  document:** one-line per change, update `CHANGELOG.md` + `HANDOFF.md`.

## Coding discipline (Karpathy's 4)
- **Think before coding:** state assumptions; ask if confused, don't guess.
- **Simplicity first:** only what's asked; no speculative abstractions; 50 lines
  over 200; ruthlessly reduce. Nothing irrelevant. If a fix feels hacky, implement
  the proper version.
- **Surgical:** touch only the code this task requires; match style; remove only
  dead code you created; preserve patterns.
- **Goal-driven:** AC = pass/fail; test first, then satisfy it.

## Hard "never do"
- **Never rename/remove a shared symbol, key, class, or i18n string without grepping
  EVERY usage and updating all of them** (i18n keys span many locale files). Ground first.
- **Never write CSS/DOM against assumed markup** — read the real template; confirm the
  selector exists and co-occurs.
- **Never commit secrets, `.env*`, keys, or this `CLAUDE.md`.** Secret-scan gates every
  commit: `node C:/Users/r00t/Desktop/loop/SCH-loop/scripts/secret-scan.mjs`.
- **Never edit outside the task's declared files.** A product/scope decision → inbox
  question, not a code change. Do not redesign the product mid-build.
- <project-specific binding constraints (security / DRM / compliance / license)>

## Quality bar
- Tests for logic/data/permission/UI-behaviour changes (<test runners>); test-first.
- UI uses the project's design skills (best-fit per task); verify in a real browser
  (one screenshot + targeted checks, never full a11y snapshots — tokens).
- Feature branch → secret-scan → commit (changelog) → review → merge.

## Lessons (auto-added — never repeat these)
<!-- Every correction (review changes / a regression) → append the one-line rule
     HERE so it is auto-read next pass and never recurs. This is how the loop
     compounds instead of re-making mistakes. -->
- (none yet)
