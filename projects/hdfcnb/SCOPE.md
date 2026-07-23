# HDFC Net Banking UAT — SCOPE

- **Project id:** hdfcnb1
- **Domain / pack:** web-pentest (offensive)
- **Environment:** SIT / UAT (non-production, disposable data). Encryption **disabled** on
  SIT1 & SIT2 for testing. **SIT2 (`nb-nextgen-sit2`) preferred**; fall back to SIT1 if SIT2
  down.
- **Status:** **SCOPE ARMED 2026-07-23** (black-box / unauthenticated phases). Weekly review.
  Authenticated phases blocked pending passwords.

## In-scope targets
Approach: **black-box / unauthenticated** for now (no creds needed to begin).

Primary hosts:

1. `https://nb-nextgen-sit.hdfcbank.com/`
2. `https://nb-nextgen-sit2.hdfcbank.com/`

In scope = the net-banking SIT application family reachable from these two hosts:
- Web + API surface of these hosts (same-origin API bases, JS-referenced endpoints,
  GraphQL/REST under these domains).
- Sub-applications and features that are part of this app and served under / linked from
  these hosts — **including the chatbot** and any embedded modules on these origins.
- Endpoints these hosts **redirect to on the same host / same app**.

**Guardrail — redirects to a DIFFERENT domain** (e.g. an SSO IdP, a third-party chatbot
vendor, a payment host): treated as **out of scope until you explicitly confirm** that
specific host belongs to the engagement. Recon surfaces it; no active testing until named.
Add confirmed extra hosts to the list above.

## Out of scope — DO NOT TOUCH
- Everything not served by / linked to the two in-scope hosts above.
- All production HDFC hosts and any other `*.hdfcbank.com` subdomain not listed.
- Third-party / vendor domains, payment networks, upstream/downstream integrations.
- Any host reached only by pivoting off an in-scope finding — surface it, do not follow it.

## Rules of engagement
- **Approach:** Black-box / unauthenticated to start. Authenticated phases begin only when
  ID+password logins arrive.
- **Test depth:** Full exploitation — full vulnerability chains including limited
  data-extraction PoC and cross-account proof. **No DoS.**
- **Destructive actions:** Permitted — SIT data is disposable/restorable. Still **no DoS**,
  no attacks on availability of the environment for others.
- **Rate:** Throttle to avoid environment instability (default ~5–10 req/s unless raised).
- **Testing window:** Open-ended, **reviewed weekly**. First review due 1 week from arming
  (armed 2026-07-23 → review by 2026-07-30). Continue only if the weekly review confirms.
- **Data handling:** SIT/test data only. No real customer PII expected; if any real PII is
  encountered, stop, do not exfiltrate, report immediately. Evidence stored only in the
  engagement project, never published as a web Artifact.
- **Halt:** Engagement can be paused any time via `--halt true` (dashboard shows HALT).

## Credentials / roles
- Test accounts: **Customer IDs provided; passwords PENDING** (user to supply later).
  Authenticated phases (authz / IDOR / BOLA / BFLA / business-logic) BLOCKED until at least
  2 usable logins (ID + password) exist. Recon + unauthenticated surface can start once armed.
- Customer IDs (SIT test):
  `77707711, 192598045, 176293487, 50000425, 192598038, 166280248, 176293478,`
  `50156017, 901049073, 50156018, 50156019, 192598032, 901553337, 900478676,`
  `901049054, 192598181, 192598024, 37895436, 444580444, 901049036, 192598026,`
  `901049072, 77708102, 900478543`
- Roles/privilege of each ID: unspecified — flag any admin/elevated account when known.

## Authorization
- **Reference:** Internal email, classification **Internal**, from **Sachin Chidrewar**
  (HDFC internal — SIT environment owner / credential issuer; exact role/title unspecified)
  to the tester (Hussain / Shekhar). Email names both in-scope SIT hosts, provisions SIT
  test customer IDs (passwords to follow separately), and states encryption was disabled on
  SIT1 & SIT2 for testing (SIT2 preferred).
- Email **date: PENDING** (not shown in forwarded text) — record when supplied.
- **Scope of permitted actions in email:** grants **test access** to these hosts. It does
  **not** explicitly authorize destructive actions or full exploitation. The full-exploitation
  / destructive-OK RoE below is recorded on the **tester's attestation**, not spelled out in
  this email. Written confirmation of destructive-action scope recommended.
- Gate armed on: this email as the authorization basis + tester attestation. Recorded as
  provided; HDFC's issuance is not independently verified.

## Objectives
Identify and prove exploitable vulnerabilities across the OWASP WSTG / Web Top-10 (2021) /
API Top-10 methodology on the two in-scope net-banking SIT hosts. Deliver a CERT-In-format
report with per-finding CVSS v3.1, reproduction, and PoC evidence.
