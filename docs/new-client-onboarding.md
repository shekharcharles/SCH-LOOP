# Onboarding a new client engagement

SCH Loop auto-authorizes a client's assets only after that client's **standing
authorization is recorded once**. This is the one-time setup per client. After
it, every CR for that client is zero-friction (`/sch-spec` → give target → run).

Recorded clients live only in your local `projects.json` (git-ignored). No client
or engagement data is bundled in this repo — each is added locally when its
engagement starts.

---

## Step 1 — get a written authorization from the client

Before recording a client, obtain a **written standing authorization** (email is
fine) from an authorized signatory at the client. Ask them to send an email that
covers the points below. A good authorization protects you (Deloitte), the
client, and makes the whole year's testing frictionless.

### What the authorization email must cover

Send the client this checklist (or the template below). It should state:

1. **Who is authorized** — the assessment firm/team performing the testing.
2. **Client + engagement** — the client entity and the engagement purpose
   (security testing: web, API, mobile, internal, red team — as applicable).
3. **Authorization period** — start and **explicit expiry date** (e.g. one year).
4. **Scope model** — that assets (domains, subdomains, URLs, APIs, IPs, servers,
   apps, instances) **formally shared through any approved channel** (email,
   Teams, meeting, scope sheet, ticket) are in scope, and that a **separate
   authorization email is NOT required per asset**.
5. **Environments** — UAT / SIT / dev / pre-prod, plus **production when
   formally shared** for vulnerability verification / remediation validation /
   retesting.
6. **Internal testing** — if applicable: internal infra / apps / endpoints /
   network ranges / red team, with assets shared as needed.
7. **Rules of engagement** — testing restrictions, rate limits, no-destruction,
   data-handling, approved communication channels, and adherence to the client's
   policies + applicable compliance (for BFSI: RBI / SEBI / CERT-In).
8. **Signatory** — name and role of the person authorizing, and that it remains
   valid until renewed, modified, suspended, or revoked in writing.

### Ready-to-send template (ask the client to send this)

```text
Classification: Internal

Subject: Standing authorization — <Client> security testing engagement

Dear <Assessor name / Deloitte team>,

This email serves as the standing authorization for the <Client> security
testing engagement for a period of one year from the date of this email.

The authorization reference for this engagement will be maintained under the
applicable Scope of Work, Rules of Engagement, project reference, and other
approved engagement records.

As the scope may change during the engagement, all domains, subdomains, URLs,
applications, APIs, IP addresses, servers, and instances formally shared by the
<Client> team through email, meeting communication, scope sheets, tickets, or any
other approved channel will be considered in scope.

The scope will include UAT, SIT, development, pre-production, and other test
environments. Production environments may also be shared when required for
vulnerability verification, remediation validation, retesting, or confirmation of
reported issues, and such production assets will be considered in scope when
formally shared or approved by the <Client> team.

<Include this paragraph if internal / red team testing applies:>
The scope will also include internal security testing, internal infrastructure,
internal application, and internal red team testing. Any internal domains, IPs,
servers, applications, endpoints, or network ranges shared for such testing will
also be in scope.

A separate authorization email will not be required for each asset. Any asset
formally provided or approved by the <Client> team during the authorization
period will be added to the standing scope registry and remain covered under this
authorization.

All testing will be performed in accordance with the applicable Scope of Work,
Rules of Engagement, <Client> policies, compliance requirements (including RBI /
SEBI / CERT-In where applicable), agreed testing restrictions, and approved
communication channels.

This authorization remains valid for one year and will expire on <DD Month YYYY>,
unless renewed, modified, suspended, or revoked through written communication.

Regards,
<Signatory name and role, Client>
```

When you receive it, **paste it to me** — I store the original under
`authorizations/<client>-standing-auth.txt` and record the engagement.

---

## Step 2 — record the client (one command, once)

```bash
node scripts/state.mjs auth-add \
  --client "<Client Name>" \
  --ref "<SOW / engagement / authorization ref>" \
  --signatory "<who authorized>" \
  --client-domains "<broad pattern to route assets, e.g. yesbank.in|yesbank.com>" \
  --domains "<any specific assets already shared, | separated>" \
  --expiry "<YYYY-MM-DD>" \
  --roe "<key rules of engagement>" \
  --compliance "OWASP ASVS|OWASP Top-10|OWASP API Top-10|CERT-In|RBI Cyber Security Framework|SEBI CSCRF"
```

- `--client-domains` = the broad pattern that **routes** an asset to this client
  (e.g. `yesbank.in`). Used to identify the client; not the enforced allowlist.
- `--domains` = specific in-scope assets (the enforced allowlist). Grows as the
  client shares more — no new auth email needed:
  ```bash
  node scripts/state.mjs auth-add-domain --ref "<ref>" --domains "<new-host>" --via Teams --by "<who>"
  ```

## Step 3 — run CRs for that client (frictionless, forever)

```
/sch-spec   → "pentest <target>", answer the scoping questions → it spins the CR + plans
/loop 15m /sch-run --project <cr-slug>
```

## Notes

- The scope gate **fails closed after expiry** — renew the authorization before
  it lapses.
- Production is covered only per specific host **formally shared** for
  verification/retest — never blanket-covered.
- A target for a client with **no engagement on record** is refused until Step 2
  is done. This is deliberate: it is the line between authorized testing and
  attacking an unauthorized third party.
- Keep each `authorizations/*.txt` and the `logs/` audit trail — they are the
  paper record that testing was authorized.
