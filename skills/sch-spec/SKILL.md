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

Research the code first. Interview in rounds (1-4 questions, options, recommended
first) — only genuine product decisions. Confidence test: *could two engineers
ship the same observable behavior?* No round cap. Write `<path>/PRD.md`:

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
node scripts/state.mjs project-add --id <slug> --name "<Name>" --domain app-dev --path "<abs path>"
```
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
