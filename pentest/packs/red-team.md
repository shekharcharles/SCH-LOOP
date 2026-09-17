<!-- SCH Loop method body for domains: red-team-external, red-team-internal. sch-run follows these phases as tasks; execution is SEQUENTIAL (a kill chain has order). Authorization comes from the project SCOPE.md + state.mjs scope gate — never run an active phase against a target the gate rejects. -->

# Autonomous Red Team Engagement — method body

## External vs internal (pick per the project domain)
- **`red-team-external`** — start outside: OSINT + external attack surface →
  initial access (phishing / exploit / cred) per RoE → C2 → then internal kill
  chain. Objective-driven, stealthy, blue-team usually unannounced.
- **`red-team-internal`** — **assumed breach**: start from a provided foothold/
  host inside the network, skip initial access, go straight to internal recon →
  AD enumeration → privesc → lateral → domain dominance → objectives. Faster path
  to impact; focuses on internal detection + containment.

Both are objective-driven and scope-gated. Internal is sequential and noisier-
aware (avoid tripping every detection at once unless the exercise is a test of
detection). Announced vs unannounced and allowed TTPs come from `SCOPE.md`.

You are running an **AUTHORIZED red team engagement** under a signed scope
(`SCOPE.md`). Operate as an **ORCHESTRATOR**: delegate execution to background
sub-agents, keep the main terminal free. Full-auto is permitted **only** for
targets the scope gate confirms IN-SCOPE and only while `halt` is false. Any
out-of-scope pivot, destructive action, or a target the gate rejects → pause and
surface precisely; never proceed on assumption.

## Phases (each is one task; deps enforce order)
1. **Recon / OSINT** — external footprint, people, tech, exposed services, entry
   candidates. Dispatch `executing-red-team-engagement-planning`,
   `conducting-external-reconnaissance-with-osint`.
2. **Initial access** — phishing/exploit/cred per RoE. Dispatch
   `performing-red-team-phishing-with-gophish`, `executing-red-team-exercise`.
3. **C2** — stand up infrastructure, establish beacon. Dispatch
   `building-c2-infrastructure-with-sliver-framework`, `operating-sliver-c2`,
   `building-c2-redirector-infrastructure`.
4. **Privilege escalation** — local/domain. Dispatch `test_privesc`,
   `performing-privilege-escalation-assessment`.
5. **Lateral movement** — reach the objective systems. Dispatch
   `detecting-lateral-movement-in-network` (for stealth awareness),
   `moving-laterally-with-netexec`.
6. **Objectives / exfil (simulated)** — prove access to the agreed crown-jewel
   objective; stage/exfil only what the RoE authorizes, and only as proof.
7. **Report** — the engagement deliverable (see below).

## Validation / complete
A phase task is complete when its **objective proof** exists (beacon callback,
screenshot, hash, access token, objective reached) and is logged as evidence.
`complete` = objective logged, not a git merge.

## Deliver
Engagement report in `<project>/reports/`: executive summary, attack narrative
(kill-chain timeline), per-objective proof, detections triggered vs missed,
MITRE ATT&CK technique mapping, remediation + detection recommendations. Keep
client-specific detail in the project only; never publish externally.

## Autonomy + self-learning
- One background agent per active phase; sequence them (later phases depend on
  earlier access). Relay results, don't redo.
- Record reusable TTPs / working paths / dead ends to memory or a red-team skill
  for the next engagement.
- Stop only for an out-of-scope pivot, a destructive/irreversible action needing
  human sign-off, or when the report is delivered.
