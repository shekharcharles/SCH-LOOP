# SCH Loop

A local, multi-project AI **work factory** built on Claude Code skills, for a
security consultant running many engagements. You start a piece of work with one
command, and a self-directing loop plans it, executes it (dispatching to your
installed security/dev skills), validates it, reviews it with fresh context,
completes it, and — for pentests — writes the report. A local dashboard
(reachable from your phone over Tailscale) shows every engagement and lets you
steer from anywhere.

**You only ever type two things:**

```
/sch-spec                              start any work (pentest CR or dev)
/loop 15m /sch-run --project <id>      run it — one task per pass, to done
```

Everything else — planning, review, exploitation, report, learning — happens
automatically inside those.

---

## Contents / where things live

```
scripts/state.mjs      the engine + CLI: projects, tasks, findings, scope gate,
                       standing authorizations, provenance, audit log.
scripts/dashboard.mjs  zero-dep web dashboard (port 4600, binds 0.0.0.0 for Tailscale).
packs/packs.json       per-domain config (dispatch skills, validate, complete, deliver).
packs/*.md             per-domain methodology bodies (web/mobile/red-team/app/tool).
knowledge/*.md         self-learning knowledge base per pack (grows across engagements).
skills/                sch-spec, sch-plan, sch-run, sch-review, sch-ship, sch-learn.
authorizations/*.txt   stored client authorization emails (paper trail, local only).
logs/audit-*.jsonl     append-only audit log (every action + scope decision).
projects.json          registry: clients (authorizations) + projects.
projects/<id>/state.json   per-project isolated state.
docs/new-client-onboarding.md   how to add a client + the authorization email template.
```

## The six packs (domains)

| Pack | validate | complete | deliver | scope gate |
| --- | --- | --- | --- | --- |
| `app-dev` | Playwright (real browser) | git-merge | deploy | no |
| `tool-dev` | run the tool | git-merge | package/publish | no |
| `web-pentest` | PoC evidence | finding logged | CERT-In report | **yes** |
| `mobile-android` | PoC evidence | finding logged | CERT-In report | **yes** |
| `mobile-ios` | PoC evidence | finding logged | CERT-In report | **yes** |
| `red-team` | objective proof | objective logged | engagement report | **yes** |

The engine is domain-agnostic; each pack **dispatches to your installed skills**
(`performing-*`, `testing-*`, `taste-skill`, `gsap-*`, …) — it never reinvents.
The `web-pentest` pack is a full WSTG v4.2 + OWASP + API-Top-10 + ASVS
methodology with **coverage-as-contract** (every class logged `validated` or
`tested-clean` — zero false negatives).

## The loop, end to end

```
/sch-spec            SPEC   → scope the work (smart questions), arm, write PRD/SCOPE
/sch-plan (auto)     PLAN   → methodology → phase/feature tasks in the queue
/loop /sch-run       RUN    → one task per pass:
   ├ execute                 dispatch to the right installed skill for the task
   ├ validate                browser (dev) / PoC evidence (pentest) / run (tool)
   ├ /sch-review             fresh-context review vs the contract
   ├ exploit/chain           combine primitives into proven impact (pentest)
   ├ complete                merge (dev) / log finding (pentest)
   ├ grow queue              discovered dependency/lead → new task
   ├ /sch-learn              distil a reusable lesson into knowledge/<pack>.md
   └ /sch-ship               when done → deploy / CERT-In report
```

## Setup (once)

```powershell
# 1. install the skills globally so /sch-spec works from any folder
Copy-Item -Recurse -Force C:\Users\r00t\Desktop\loop\SCH-loop\skills\sch-* $HOME\.claude\skills\
# in Claude Code:  /reload-skills   (confirm /skills lists the sch-* skills)

# 2. init + start the dashboard (leave running)
cd C:\Users\r00t\Desktop\loop\SCH-loop
node scripts/state.mjs init
node scripts/dashboard.mjs           # http://localhost:4600  (or Tailscale IP on phone)
```

Skills carry an `SCH_HOME` note so they run from any folder (they use the
absolute engine path). You can launch Claude Code from anywhere.

## Daily pentest flow (a CR arrives)

```
/sch-spec
  → "pentest app.uat.<client>.com, CR-4821, shared via Teams"
  → it asks the scoping questions (black/gray box, creds/roles, environment,
    window, priority flows; API collection or APK path if relevant)
  → routes to that client's engagement, records the asset with provenance, arms
    the project scoped to just that asset, writes SCOPE.md, and plans the phases.
/loop 15m /sch-run --project cr-4821
  → recon → config → auth → authz → injection → logic/API → client-side →
    exploitation/chaining → report. Every active step is scope-gated.
```

You never re-attest for a recorded client. Add a newly-shared asset any time; it
is covered because it was shared (audit-logged).

## Authorization & the scope gate (why it protects you)

Offensive work runs **full-auto within a signed scope**, enforced per active
task and logged:

- Each **client** has a standing authorization recorded once (ref + expiry +
  `clientDomains`). See `docs/new-client-onboarding.md` for the process and the
  **authorization email template to send a new client**.
- Assets are an **allowlist that grows as the client formally shares them** (any
  channel — Teams/call/meeting/email). No per-asset email needed.
- Every active task re-checks scope at execution; **out-of-scope, unauthorized,
  or expired → refused**, and the decision is written to `logs/`.
- **HALT** (dashboard button or `scope-set --halt true`) stops all active work
  instantly.
- A client with **no engagement on record is refused** until recorded once. This
  is deliberate — the line between authorized testing and attacking a third party.

Recorded clients live only in your local `projects.json` (git-ignored) — no
engagement data is bundled in this repo. Add each via `docs/new-client-onboarding.md`.

## The dashboard

- **Root** = one card per project (each CR/engagement), with badges + counts.
- **Project view** = scope panel (client, authorized, expiry, targets; **HALT** /
  arm buttons) → KPIs → **add-idea box** (type a new lead → planned next pass) →
  lanes (Inbox → In review → Building → Queue → Blocked → Done → Activity) →
  per-task **bump / hold / requeue** buttons.
- Auto-refreshes every 5s. Reach it from your phone via Tailscale.

## Audit & compliance

- `logs/audit-YYYY-MM-DD.jsonl` — append-only, one line per action and per scope
  decision (target, client, ref, IN-SCOPE/REFUSED, timestamp).
- Per-asset **provenance** (who shared it, how, when) on every authorization.
- Reports map findings to **OWASP ASVS / Top-10 / API Top-10, CERT-In, RBI Cyber
  Security Framework, SEBI CSCRF**.

## Self-learning

- `knowledge/<pack>.md` accumulates generalizable techniques, target-class
  patterns, false-positive filters, dead-ends. `sch-run` reads it before a pass;
  `sch-learn` appends after. Never stores client/target-specific data.
- Teach an approach once → it is persisted (pack methodology, knowledge base, or
  memory) and reused across engagements.

## Full CLI reference (`node scripts/state.mjs <cmd>`)

```
init | stats --project <id>
project-add --id --name --domain [--path] | project-list | project-get --project <id>

# clients (standing authorizations)
auth-add --client --ref [--signatory] [--client-domains a|b] [--domains a|b] [--expiry YYYY-MM-DD] [--roe] [--compliance a|b]
auth-list | auth-find --target <t> | auth-remove --ref <ref>
auth-add-domain --ref <ref> --domains a|b [--via] [--by] [--cr] [--note]
provenance --ref <ref>

# per-CR
cr-new --id <CR> --targets a|b [--name] [--domain web-pentest] [--via] [--by] [--path] [--ref]
scope-get --project <id> | scope-check --project <id> --target <t> | scope-set --project <id> [--halt true|false] ...
scope-arm-from-auth --project <id> --target <t>

# tasks & findings
task-add | task-list [--status] | task-get <n> | task-set <n> --status ... | task-next     (all --project <id>)
finding-add --project <id> --title --category [--severity] [--cvss] [--status validated|tested-clean] [--evidence]
finding-list --project <id> [--status] | finding-set --project <id> <n> ...

# inbox
inbox-add --project <id> "<text>" | inbox-list --project <id> [--new] | inbox-mark --project <id> <n>
```

## Rules that keep it safe

- One task per pass; one project per running loop.
- No active tooling against an out-of-scope / unauthorized / expired target — ever.
- Re-verify live state immediately before every completion.
- Scope grows only through the queue / recorded shares, never silently.
- Engagement reports stay in the project; never published externally.
