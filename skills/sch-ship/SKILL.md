---
name: sch-ship
description: Deliver a SCH Loop project when its queue is drained and its contract is met — deploy (app), package/publish (tool), or produce the CERT-In / engagement report (offensive). Called by sch-run's deliver-check; gated so it never ships an incomplete contract. Operates on one --project.
---

# SCH Loop — deliver

> **Engine home (`SCH_HOME`):** `$HOME/.claude/SCH-loop`. Run
> `node scripts/state.mjs …` from there, or use the absolute path
> `node $HOME/.claude/SCH-loop/scripts/state.mjs …`.
> **`--project` is optional** — if omitted it is auto-detected from the current
> folder (the registered project whose `path` contains your cwd). Check with
> `state.mjs project-here`..

Runs only when the project has no ready or in-flight work **and** its contract is
satisfied. Verify that first. Deliverable shape comes from the pack
(`packs/packs.json` → `deliver`).

## 1. Confirm done

```bash
node scripts/state.mjs stats --project <id>
node scripts/state.mjs task-list --project <id>
```

- **Dev/tool:** every PRD `AC-N` maps to a merged task; nothing
  queued/building/review/blocked/stuck.
- **Offensive:** every pack phase, including `report`, is done.

Any gap → do not deliver; log it and end (or file a fix task).

## 2. Final validation

- **Dev:** full build + whole test suite on the default branch; launch and drive
  the PRD-level "How to verify" flow with the Playwright MCP; capture release
  screenshots. Any failure files a fix task (`task-add --source build`) and stops.
- **Tool:** build the distributable, run the full suite.
- **Offensive:** confirm every finding/objective has reproducible evidence before
  it goes in the report.

## 3. Produce the deliverable (per pack `deliver`)

- **`deploy` (app-dev):** production build; deploy via the project's own path
  (its script / CI / platform CLI); tag a release. No deploy path exists →
  produce the artifact and hand the user the one manual publish step. Deploying
  to a real external target is an outward action — never invent one.
- **`package-and-publish` (tool-dev):** build wheel/sdist/crate/binary; publish
  to the registry only via the project's established path, else hand off.
- **`cert-in-report` (web / mobile / api / network pentest):** generate the
  report from the recorded findings — the intelligence already happened in the
  loop (each finding's category, CVSS, description, evidence); this just pours it
  into the mandated CERT-In format:
  ```bash
  node scripts/report.mjs --project <id> --author "<name>" --classification Confidential
  ```
  It writes `<project>/reports/<REPORT-ID>.md` and `.html` (open the HTML → Print
  → Save as PDF). Before generating, confirm findings are complete + evidence
  paths are set (`finding-list`). The report includes severity summary, per-
  finding detail + CVSS + evidence, the **coverage matrix / controls-that-held**,
  and compliance mapping. Everything below is what that report must contain: Every
  finding named by its exact taxonomy (OWASP Web Top-10 2021 + WSTG id, or OWASP
  Mobile Top-10 2024 + MASVS + MASTG id); per-finding CVSS v3.1 by that finding's
  realistic attacker; master severity table (sorted); executive summary + overall
  risk; remediation; reproduction steps; evidence (request/response +
  screenshots); **coverage matrix appendix** built from every `finding-list`
  entry (`validated` + `tested-clean`); "controls that held" derived from the
  `tested-clean` cells; report id + author + date + classification.
  - **Compliance mapping:** read `scope.compliance` (from the project/standing
    authorization) and add a mapping section for each framework listed — e.g.
    **RBI Cyber Security Framework** (map findings to the baseline controls /
    SAR expectations), **SEBI CSCRF** (map to its cyber-resilience domains),
    **CERT-In** empanelled-auditor reporting format, **OWASP ASVS** (per-
    requirement L1-L3 pass/fail). For regulated financial clients this mapping
    is part of "done", not optional.
- **`engagement-report` (red team):** attack narrative + kill-chain timeline,
  per-objective proof, MITRE ATT&CK mapping, detections triggered vs missed,
  remediation + detection recommendations.

Keep client/target-specific detail in the project only. **Never** publish an
engagement report as a web Artifact or to any public repo.

## 4. Record

```bash
node scripts/state.mjs event-add --project <id> --text "delivered: <what + where>"
```

Report to the user and the dashboard exactly what shipped/was reported, where,
and the evidence.

## Hard limits

- Never deliver with an unmet contract (unmet AC, non-merged task, missing phase,
  or a finding without evidence).
- Never fabricate a deploy target; never publish an engagement report externally.
