# SCH Loop — backlog, August 2026

Every ticket: one concern, its own verification, explicit blocking edges. A
ticket that cannot state how it is checked is not ready to be worked.

Size: **S** ≤ 1 file, no new concepts · **M** 2–4 files or one new concept ·
**L** touches a load-bearing path (scheduler, delivery, gates) and ships tests in
the same commit.

Order below is the recommended one. `blocks` names what cannot start until this
lands.

---

## Epic A — exploitation safety

The only items whose absence has a consequence worse than inconvenience: today
nothing separates "I am testing whether this is vulnerable" from "I am exploiting
it against live production".

### A1 — `EXPLOITATION_AUTHORIZED` gate type · M · deps: none · blocks: A2, A3, A4
Add the gate kind to `humangates.mjs` alongside the existing 12. Payload: target,
intended action, the validated findings it intends to exploit, the authorization
ref, the RoE clause relied on.
**AC** — the kind is registered; opening one with a missing auth ref is refused;
`human-gate-list` shows it; expiry behaves like every other gate.
**Verify** — `node --test tests/humangates.test.mjs`

### A2 — scheduler blocks phases 9–13 without an approved gate · L · deps: A1
Hook into the existing open-gate stop (`HUMAN_GATE_PENDING`) rather than adding a
new stop reason. A task whose phase is in the gated set and has no APPROVED gate
is not selectable.
**AC** — a phase-9 task with no gate never starts; the stop reason names the gate;
an APPROVED gate lets exactly that task through; phases 1–8 are unaffected.
**Verify** — new `tests/exploitation-gate.test.mjs`; full suite green.

### A3 — the digest binds the authorization ref · M · deps: A1
Include the auth ref and its expiry in the hashed proposal, so an approval granted
under `PENDING-FORMAL-REF` dies the moment the real reference lands.
**AC** — changing the ref invalidates an existing approval; the invalidation
reason says which field moved.
**Verify** — test asserts approval → change ref → gate is no longer APPROVED.

### A4 — dashboard renders and approves exploitation gates · M · deps: A1, A2
The gate projection already reaches the page. This is presentation: show the
findings it intends to exploit and the RoE clause, and require the digest.
**AC** — an open exploitation gate is visible on the project page with its
payload; approving it records the approver; the page never approves by GET.

---

## Epic B — the 17-phase methodology

### B1 — rewrite `packs/web-pentest.md` to 17 phases · L · deps: A2
Keep what works: coverage-is-the-contract, blocked ≠ tested-clean, WAF-in-scope,
PoC-or-it-did-not-happen, the chain library, the coverage CLI. Split recon into
passive / active / mapping / enumeration; make automated discovery, manual
assessment, validation, exploitation, privilege escalation, post-exploitation,
lateral movement, chaining, impact and cleanup first-class.
**AC** — 17 phases, each with its own AC/NG shape and `active` flag; every phase
the old 9 covered still has a home.

### B2 — `packs.json` phase slugs · M · deps: B1
Replace the 7 stale slugs. **Trace every consumer first** — `sch-spec`,
`sch-plan`, `sch-run`, the dashboard phase strip — so renaming does not orphan
the HDFC tasks that carry the old names.
**AC** — existing HDFC projects still render and still schedule; a migration note
covers any task whose phase name changed.

### B3 — consistency test: pack ↔ packs.json ↔ planner · S · deps: B2
The drift that produced 7 tasks against a 9-phase pack was invisible because
nothing compared them.
**AC** — the test fails if the pack body, the slug list and what the planner emits
disagree on phase count or names.

### B4 — cleanup ledger: `artifact-add` / `artifact-list` · M · deps: none
"Remove what you created" is unverifiable without a record. One array in project
state; every active phase logs accounts created, files uploaded, markers left.
**AC** — add/list/close round-trips; entries carry phase, target and how to undo.

### B5 — phase 16 fails while the ledger is non-empty · S · deps: B4
**AC** — the cleanup task cannot pass acceptance with open artefacts; the failure
names them.

### B6 — re-plan Patanjali onto 17 phases · M · deps: B1, B2, C1
Lateral movement planned as explicitly not-applicable with the scope reason
recorded, not silently dropped. Phases 9–13 gated closed pending the real auth ref.

---

## Epic C — CLI and state gaps

### C1 — `task-set` can edit `title`, `ac`, `ng`, `deps`, `active` · M · deps: none
Today it sets only phase, priority, category, target, notes, branch, phaseName —
which is why re-planning meant superseding five tasks and rewriting them, and why
one boolean needed a direct state write.
**AC** — each field settable and audited; `deps` validates that every id exists;
`active` is a real boolean, never the string `"true"`.
**Verify** — `tests/state.test.mjs` additions.

### C2 — `sync-skills.mjs` honours `SCH_HOME` · S · deps: none
It hardcodes `homedir()/.claude/skills`. On Windows `SCH` and `sch` are the same
directory, which is how a different project's skill was overwritten.
**AC** — destination derives from the engine home; `--check` still reports drift;
a collision with a non-SCH skill of the same name is refused, not overwritten.

---

## Epic D — the missing lifecycle phases

### D1 — `DOMAIN.md` + ADRs · M · deps: none
Decisions currently live only as event-log lines. A durable domain model is what
stops the fifth fresh subagent inventing a sixth name for the same concept.
**AC** — `sch-onboard` and `sch-spec` both write/extend it; ADRs are numbered and
immutable once recorded.

### D2 — VERIFY phase (`sch-verify`) · M · deps: none
A walkthrough of what was actually built, before declaring done. This is the gap
that let seven delivered tasks sit on branches nobody surfaced.
**AC** — runs against the landed branch, exercises the acceptance criteria as a
user would, reports pass/fail per AC with evidence.

### D3 — ticket-size contract in `sch-plan` · S · deps: none
**AC** — the planner refuses a task with no verification, no AC, or a scope
spanning more than one concern; the refusal names which rule it broke.

---

## Epic E — dashboard

### E1 — Settings: models per role per project · M · deps: none
Plumbing exists (`POST /models` → `modelPolicy.models`, applied at resolve time).
This is a real settings surface instead of a control buried in a disclosure.
**AC** — every role selectable per project; shows effective model and whether it
came from the override or the profile; picking the default clears the override.

### E2 — Settings: run limits · S · deps: E1
Lift `max_cost_usd_per_run` (hardcoded `$10`) and max-tasks into the registry.
**AC** — both editable per project; the scheduler reads them; an empty value means
the built-in default, not zero.

### E3 — Settings: authorized targets · M · deps: E1
Add / edit / delete against the `authorizations` registry.
**AC** — `client` and `ref` stay mandatory; `expiry` stays mandatory; delete does
NOT retroactively disarm an armed project — it surfaces that as a separate,
explicit action; every change is audited.

### E4 — run strip shows the stop reason · S · deps: none
`NO_READY_TASK / BLOCKED_DEPENDENCIES: #22` was in the log while the page said
STOPPED and nothing else. Twice.

### E5 — status badge reads canonical `state` · S · deps: none
A task terminal in `FAILED` displayed as QUEUED, and the progress bar counted it.

### E6 — dashboard actions go through the transition machine · M · deps: C1
`dashboard.mjs:632` assigns `t.status` directly — no state change, no version
bump, no audit record. That is how E5 happened.

### E7 — dashboard must not expose `deliver` as a write · S · deps: none
Pre-existing validator failure. Delivery authority is the operator's, on the CLI.

### E8 — authenticate before routing · S · deps: none
Pre-existing validator failure, and the README states it as fact about the
running server. **Look at this before the engagement runs.**

### E9 — `by_model` stale attribution · S · deps: none
Still reports haiku from records written before the routing fix.

---

## Epic F — housekeeping

### F1 — skills stop advertising `/loop 15m /sch-run` · S
Both `sch-spec` and `sch-plan` end by naming the legacy prompt-driven loop.
Should be the dashboard Start button or `supervisor.mjs start`.

### F2 — retire the test fixture · S
Delete `sch_loop_test` (engine work is pushed) and drop the stale `calc` project
from the registry, which points into it.

### F3 — confirm the SessionStart/SessionEnd hook fires · S
Only a NEW terminal proves it. `dashboard-ctl.mjs status` should report the
dashboard up on `10.10.10.10:4700` without anyone launching it.

---

## Epic G — trust in the report

### G1 — finding dedup + lineage across runs · M
Nothing stops the same IDOR being logged twice across passes. Duplicated findings
lose a client's trust faster than a missed one.
**AC** — a finding matching an existing one on target+class+location is linked,
not re-added; the link is visible in the report.

### G2 — PoC replay verifier · M · deps: G1
A finding ships with a raw request that nothing re-runs. A vulnerability fixed
between discovery and reporting goes out as live.
**AC** — every validated finding is replayed at report time; the report states
"reproduced at <time>" or "no longer reproduces", never silence.

### G3 — severity bound to evidence · S
Severity is the model's word today.
**AC** — each severity carries impact × likelihood with the evidence that
supports it; a severity with no justification is refused at report time.

---

## Epic H — cost and routing

### H1 — projected spend, not just spent · S
The page answers "what has this cost" but not "will this run finish under the
ceiling". Burn rate × remaining tasks.

### H2 — per-PHASE model policy · M · deps: E1
Model is chosen by role alone. Recon should be haiku whoever runs it;
exploitation should be opus whoever runs it.
**AC** — phase policy overrides role policy; the record says which one applied.

### H3 — live cache-hit telemetry · S
91.7% was measured once, in a test. Nothing shows whether a LIVE run is hitting
cache — the single metric that proves the architecture is working.
**AC** — cache-read ÷ total input, per task and per run, on the dashboard.

---

## Epic I — resilience

### I1 — worker killed mid-delivery · L
Orphan recovery requeues `building`/`review`. The dangerous case is a worker
killed mid-git-transaction.
**AC** — a half-finished delivery is detected and reported, never silently
retried on top of itself.

### I2 — provider overload backoff in the executor · S
`limits.mjs` backs off on the usage endpoint. The actual `claude -p` call has no
retry-with-backoff on a 529.

### I3 — infrastructure failure is visible · S
Disk full or SQLite locked fails closed correctly, but the dashboard never says
"the loop stopped because the disk is full".

---

## Epic J — many projects at once

### J1 — one scheduler, many projects · L
Today it is one supervisor process per project. At the 50–100 concurrent
projects this is built for, that is 100 detached node processes.
**AC** — a single scheduler with a fair per-project queue; per-project pause and
stop still work exactly as now.

### J2 — global spend ceiling · M · deps: H1
Per-run ceiling exists. Nothing caps "every project, this 5-hour window" against
the real provider limit.

---

## Epic K — prove it against a real target

### K1 — one gated recon pass · M · deps: A2, B6
**Everything verified so far is the build path.** The offensive path — scope
guard on a live fetch, the evidence gate rejecting a PoC-less finding, a WAF
block refusing to count as tested-clean — has never actually run. One passive
phase-1 pass against the authorized target will surface more than any further
reading of the code.

---

## Suggested order

```
A1 → A2 → A3 → A4          exploitation safety, before any active phase runs
E8, E7                     the two security-shaped validator failures
C1, C2                     unblocks B6 and stops the skill-overwrite class of bug
B1 → B2 → B3, B4 → B5      the methodology
B6                         re-plan Patanjali
E4, E5, E6, E9             dashboard honesty
D1, D2, D3                 the lifecycle phases
E1 → E2 → E3               settings
F1, F2, F3                 housekeeping
```

A1–A4 and E8 are the only items where "not yet" has a cost worse than annoyance.
