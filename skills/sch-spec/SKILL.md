---
name: sch-spec
description: The single entry point to start any SCH Loop work. For a pentest CR just give the CR ref + target(s) — it records the asset under the client's standing authorization, arms the project, and plans it. For app/tool dev it interviews and writes a PRD. After this, the only other thing to run is the loop. Interactive.
---

# SCH Loop — start here (the only command you type to begin)

One entry for everything. Two shapes: **offensive** (pentest / red team — the
daily CR path) and **dev** (app / tool). After this, the user only runs
`/loop 15m /sch-run --project <id>`. This skill also **plans** the work, so tasks
are queued and ready.

> **Engine home (`SCH_HOME`):** `$HOME/.claude/SCH-loop`. Run
> `node scripts/state.mjs …` from there or via the absolute path.

Decide the shape from what the user gives: a CR + target(s)/hosts → offensive; an
app/feature idea → dev. Ask only if genuinely ambiguous.

---

## A) Offensive — the daily CR fast path

The user hands over a change request with target(s), shared via Teams / email /
call / meeting. Their providing it IS the formal sharing the standing
authorization describes — do not wait for an email, do not re-attest.

**1. Route to the client.** Match the target to a recorded client engagement:

```bash
node scripts/state.mjs auth-find --target "<target>"     # matches scopeDomains
node scripts/state.mjs auth-list                         # see recorded clients + clientDomains
```

- **Client on record** (target matches a client's `clientDomains`, e.g.
  `acme-bank.com` → the Acme engagement): proceed with **zero friction**.
- **Asset clearly NOT any recorded client** (a different org entirely): ask ONE
  confirming line — which client/engagement it belongs to — then proceed on the
  answer. Never a refusal for a recorded client; one check only for the unknown.
- **New client, no engagement on record**: record it once (see
  `docs/new-client-onboarding.md`), then continue:
  ```bash
  node scripts/state.mjs auth-add --client "<Name>" --ref "<SOW/auth ref>" \
    --expiry "<YYYY-MM-DD>" --client-domains "<pattern>" \
    --compliance "OWASP ASVS|CERT-In|RBI Cyber Security Framework|SEBI CSCRF"
  ```

**1.5 Scope smartly — ask the RIGHT questions for this target type.**
The user gives only `/sch-spec`, "pentest this", and a target (domain / API
collection / APK path / IP). Be smart: infer the type and ask ONE focused round
(batched, options, your recommended default first) — only what actually changes
how you test. Do not ask what the target already answers.

Always clarify (all types):
- **Box type**: black / gray / white? (recommend gray — creds + partial knowledge
  = best coverage) → if gray/white, get **test accounts + roles** (each privilege
  level, for the authz matrix).
- **Environment**: UAT / SIT / pre-prod / production-retest?
- **Testing window + rate limits**, and anything the client said is **off-limits**
  (no-DoS, no data destruction, specific endpoints to avoid).
- **Priority / critical flows** to focus (payments, auth, PII) and any known
  **WAF / RASP** in front.

Then the target-specific questions:
- **Web app** (domain/URL): roles for the authz matrix, is the **API in scope**,
  SSO/MFA in play, any 2FA test bypass creds.
- **API** (Postman/OpenAPI/HAR collection or base URL): collection format +
  location, **auth mechanism** (JWT / OAuth / API key / session) + a valid
  token/refresh, base URL(s), which roles.
- **Mobile** (APK/IPA path): platform (Android/iOS), the **binary path or "pull
  from device"**, test **device/emulator** + root/jailbreak available, is the
  **backend API in scope**, expected **RASP** (root/SSL-pin/anti-frida).
- **Red team**: objectives / crown jewels, assumed-breach vs full, allowed TTPs,
  is the blue team aware (announced vs unannounced).

Keep it to one round when you can. Fold the answers into `SCOPE.md` (step 3).

**2. Spin up + arm the CR (one command).**

```bash
node scripts/state.mjs cr-new --id "<CR-REF>" --name "<CR-REF short title>" \
  --targets "<host1>|<host2>" --via "<Teams|Email|Call|Meeting>" --by "<who shared>" \
  --domain web-pentest \
  --path "$HOME/.claude/SCH-loop/projects/<cr-slug>"
```

`--domain` is `web-pentest` (default), `mobile-android`, `mobile-ios`, or
`red-team` per the CR. This records the asset with provenance (audit trail),
creates a project scoped to just this CR's assets (least privilege), and arms it.
Expired authorization → it refuses; renew first.

**3. Write `SCOPE.md`** into the project path capturing the engagement: client +
authorization ref + expiry, in-scope targets, out-of-scope, **box type**,
**credentials/roles**, environment, window, rate limits, off-limits actions,
priority flows, WAF/RASP notes, and (API) collection location / (mobile) binary
path + device. The planner and engine read this — it is the engagement's ground
truth beyond the raw target.

**4. Plan it** so the loop can run immediately: read `packs/<method>.md` and run:

```
/sch-plan --project <cr-slug>
```

`sch-plan` is **interactive** — it plays back what it understood, agrees the phase
map with the operator, and only then writes tasks. Do not treat it as a formality.

Then tell the user the single command to run: `/loop 15m /sch-run --project <cr-slug>`.

## A2) Consistency check before planning (spec-kit "analyze")

Before handing off to `/sch-plan`, cross-check the contract for **contradictions**
— this catches the class of problem where a requirement silently reverses a
binding constraint (e.g. "allow public browsing" vs an existing `NG: login-and-
approval gated`). For each acceptance criterion, confirm no `NG` forbids it and
no two criteria conflict. If a contradiction exists, surface it to the user and
resolve it in the contract **now** — do not let the loop discover it mid-build.

## B) Dev — app / tool

**Brainstorm first for a vague/greenfield idea** (superpowers `brainstorming`):
if the request is fuzzy ("build me an X"), refine it Socratically BEFORE the PRD —
surface the core user + primary flow, the one metric of success, and 2-3 design
forks, presenting your recommended direction. Get the shape agreed, THEN spec. For
a concrete/existing codebase, skip straight to the interview.

**Research the code first.** Read the routes, models and components that already
exist before asking anything. Half of a good interview is not asking what the
codebase already answers — and the other half is asking about the things the
operator did not think to mention.

### B0. EXISTING repo? Survey it before you ask anything (brownfield)

Decide which you are in: **greenfield** (empty or near-empty folder → the
interview below is the whole story) or **brownfield** (real code already there).
Most work is brownfield, and it is a different job: most of the product already
exists, the operator wants a *change* to it, and the biggest risk is not building
the wrong thing — it is **breaking something that already worked**.

Never interview the operator about a brownfield repo before you have read it. You
will ask questions the code already answers and miss the constraints that matter.

**1. Survey — build an as-built inventory.** Use search tools, not full-file
reads; do not load bundles or lockfiles. Establish:

- **Shape** — languages, frameworks, package manifests, how it is run and built,
  where the entry points are, how it is deployed (CI config, Dockerfile).
- **The domain** — data models / schema / migrations. This is the fastest route
  to what the product actually *is*.
- **The surface** — routes, endpoints, screens, CLI commands. This is the feature
  list, whether or not anyone wrote one down.
- **Roles and permissions** as they exist today.
- **What is tested** — test directories, what they cover, whether they pass right
  now. Run them once. A suite that is already red changes the whole plan, and you
  must know it was red *before* you touched anything.
- **What the repo says about itself** — README, CHANGELOG, HANDOFF, docs, and any
  existing `CLAUDE.md` (its rules are binding, and they are not yours to rewrite).
- **Recent history** — `git log` for the last few weeks: what is being actively
  worked on, and what is stable and should be left alone.
- **Danger zones** — TODO/FIXME/HACK comments, files with unusually heavy churn,
  anything the README warns about.

**2. Play the inventory back — and separate fact from inference.**

> **Here is what I found already built.** [surface, grouped by area] · **Here is
> what is tested** [and whether it currently passes] · **Here is what looks
> half-finished** [with the evidence] · **Here is what I could not work out.**

Mark clearly which parts you *verified by running something* versus *inferred by
reading*. An inference stated as fact is how a plan quietly builds on something
that does not actually work.

**3. Then interview about the DELTA, not the product.** The operator does not
need to re-describe what exists. Ask:

- **What is wrong or missing today?** The actual reason for this work.
- **Which of what I found is right, and which is wrong?** Existing behaviour they
  consider a bug is very different from behaviour they want preserved — and you
  cannot tell which is which from the code.
- **What must NOT change?** The single most valuable brownfield question. Anything
  named here becomes a binding `NG-N` and protects working behaviour from a
  refactor nobody asked for.
- **Is any of the half-finished work meant to be finished, or dropped?**
- **How will you know I have not broken anything?** Their answer becomes the
  regression check every task runs.

**4. The PRD describes the change, not the whole product.** Add two sections a
greenfield PRD does not need:

```md
## As-built (what already exists)     — the verified inventory, so no task rebuilds it
## Must not break                     — existing behaviour that is binding, as NG-N
```

**5. Rules that apply to every brownfield task from here on.**

- **Match the code that is there.** Its patterns, naming and structure win over
  your preferences. A change that reads as though it was always there is correct;
  a "better" pattern introduced in one file is a mess.
- **Ground before editing** — grep every usage before renaming anything, read the
  real markup before writing styles. In a codebase you did not write, an
  assumption is a regression.
- **Characterise before changing.** If a task changes existing behaviour and
  nothing covers it, write the test that captures how it works *now*, then change
  it. Otherwise nobody can tell a fix from a break.
- **Put these in the project's `CLAUDE.md`**, which is auto-read by every future
  fresh-context subagent — that is what makes them stick.

### The interview — cover the ground, don't stop at four questions

The operator gives a **general overview**; the PRD has to be specific enough that
a stranger can build from it. Closing that gap is this step's entire job. Ask in
**rounds of 1–4 questions**, each with concrete options and your recommendation
first, so "use your default" is always a valid reply. **There is no round cap** —
five rounds is normal for a real product, and far cheaper than discovering a
misunderstanding after twenty tasks are built.

Work through this checklist. Every line ends up **answered, or explicitly marked
not-applicable** — never silently skipped. Skip a line only when the codebase or
the operator has already answered it.

1. **The point** — what problem, for whom, and how do we know it worked? What
   happens today without it?
2. **Users and roles** — every kind of person who touches this, and what each is
   allowed to do. Where the overview says "admin", find out what admin actually
   does.
3. **Core journeys** — the 3–6 paths a real person takes end to end. Walk each one
   out loud with the operator; this is where missing requirements surface.
4. **The objects** — what things exist (a video, a comment, an account), their
   important fields, and their life story: created how, changed by whom, ends how.
   Deleted for real, or hidden?
5. **Permissions in practice** — for each role against each object: see, create,
   edit, delete? Who can see something before it is published?
6. **The MVP line** — what is the smallest version genuinely worth having, and
   what is explicitly later? Ask this directly. It decides the whole build order.
7. **Empty, error and limit states** — what is on screen before any data exists?
   What happens when an upload fails, a file is too large, a name is taken, a
   payment declines? Rarely in an overview; always half the real work.
8. **External systems** — what does it talk to (payments, email, SSO, storage,
   another team's API), and what should happen when that is down?
9. **Constraints that change the design if true** — expected scale, offline use,
   devices and browsers, data residency, regulated or personal data, a deadline,
   an existing stack it must fit into.
10. **Non-goals** — what should this deliberately NOT do? Push for these; a
    binding non-goal prevents more wasted work than any requirement creates.
11. **Proof** — how will the operator personally check it is done? That sentence
    becomes the verification section, and the reviewer's yardstick.

**The stopping test:** *could two different engineers read this and ship the same
observable behaviour?* If not, keep asking. Before writing the PRD, play back a
short summary of what you understood and let the operator correct it.

Write `<path>/PRD.md`:

```md
# <Project> — PRD
## Problem
## Goal / definition of done
## Users & primary flows
## Acceptance criteria (product level)   — AC-1, AC-2 … observable, testable
## Non-goals                              — NG-1, NG-2 … binding
## Constraints
## How to verify (product level)
```

**Ensure a project `CLAUDE.md`** (auto-read by Claude every reply, so every
fresh-context subagent inherits it). **If one already exists, APPEND** the missing
SCH-loop sections (ground-truth rules, Karpathy's 4, secret-scan, and an empty
`## Lessons (auto-added)` section) — do NOT overwrite the repo's existing rules.
If none exists, copy `docs/CLAUDE.template.md` and fill each `<…>` from the
interview + a read of the real codebase. Keep it short. Make sure `CLAUDE.md` is
git-ignored (secret-scan also blocks committing it). This file is what keeps
passes on-task, stops blind renames, and — via the Lessons section — makes the
loop compound instead of repeating mistakes.

Register + plan:

```bash
node scripts/state.mjs project-add --id <slug> --name "<Name>" --domain app-dev --path "<abs path>" \
  --description "<one-paragraph plain-English: what this product is, who it's for>" \
  --stack "<Django|React SPA|PostgreSQL|Docker>"
```

`--description` and `--stack` are **required** — the dashboard shows them at the
top of the project so you can see at a glance what it is and what it's built on.
(Update later with `project-meta --project <id> --description … --stack …`.)
```
/sch-plan --project <slug>
```

Then: `/loop 15m /sch-run --project <slug>`.

---

## Rules

- Offensive: a client on record = zero friction; the user relaying an asset is
  the formal sharing. Log provenance, don't stall.
- One confirming line only for an asset that matches no recorded client. Never
  auto-authorize an organization with no engagement on record.
- Always end by leaving the work **planned** (tasks queued) and telling the user
  the single loop command to run.
