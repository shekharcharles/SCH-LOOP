# <Project> — CONSTITUTION

Non-negotiables every build pass must respect. A fresh-context subagent reads this
before touching the code — do not re-derive it, do not violate it. `sch-spec`
fills each `<…>` from the interview + a read of the real codebase; keep it SHORT.

## Stack (do not change without a task that says so)
- **Backend:** <framework + version, entry point, key apps/modules>
- **Frontend:** <framework + where it lives; SSR vs SPA>
- **Runs via:** <docker / dev server + port>

## Design system — single source of truth
- **Tokens + UI primitives live in `<path>`**, loaded once via `<entry template>`.
  Add to the token layer; never hardcode colors/spacing or invent a second CSS
  pipeline.
- **Dark mode class / theming mechanism:** `<class or system>`. Every color must
  resolve in all themes via tokens.
- Primitives are `<prefix>`-prefixed. Reuse them; never duplicate a primitive.

## Hard "never do" list
- **Never rename/remove a shared symbol, key, class, or i18n string without
  grepping EVERY usage and updating all of them.** (i18n keys live across many
  locale files — changing one breaks the lookup everywhere.) Ground first.
- **Never write CSS/DOM against assumed markup** — read the real template/component
  and confirm the selector exists and co-occurs.
- **Never commit secrets, `.env*`, keys, or `CLAUDE.md`** — the secret-scan gate
  blocks it; keep them git-ignored.
- **Never edit outside the current task's declared files.** No opportunistic
  refactors, no product redesign. A discovered product/scope decision → inbox
  question, not a code change.
- <project-specific binding constraints, e.g. security/DRM/compliance posture>

## Coding discipline (Karpathy's 4 — every change)
- **Think before coding:** state assumptions; ask if confused, don't guess.
- **Simplicity first:** only what's asked; no speculative abstractions; 50 lines
  over 200; ruthlessly reduce. Nothing irrelevant.
- **Surgical:** touch only code this task requires; match existing style; remove
  only dead code you created; preserve patterns.
- **Goal-driven:** AC = pass/fail; test first, then satisfy it.

## Quality bar
- Tests required for logic/data/permission/UI-behaviour changes (<test runners>).
  Test-first where practical.
- UI work uses the project's design skills (best-fit per task) and is verified in
  a real browser (one screenshot + targeted checks, never full a11y snapshots).
- Every completed task: update `CHANGELOG.md`, refresh `HANDOFF.md`.

## Branch / commit
- Feature branches; secret-scan → commit (with changelog) → review → merge to the
  default branch. Keep sensitive detail out of git.
