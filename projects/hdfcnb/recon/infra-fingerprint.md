# Recon — Infra Fingerprint (task 2)

Date 2026-07-23 · passive fingerprint, in-scope hosts only.

## TLS certificates
| Host | CN | Issuer | Validity |
|------|----|--------|----------|
| sit2 | nb-nextgen-sit2.hdfcuat.bank.in | DigiCert / GeoTrust TLS RSA CA G1 | 2025-11-07 → 2026-11-07 |
| sit | nb-nextgen-sit.hdfcuat.bank.in | DigiCert | (same class) |

**Transport TLS is enabled and valid** (DigiCert). So "encryption disabled" in the
provisioning email = **app-layer payload encryption** (request/response body crypto) turned
off for SIT, not transport. Confirm in tasks 3–4 (expect plaintext JSON bodies).

### SANs → additional hosts discovered (SCOPE DECISION — see below)
- sit2 cert SANs: `nb-nextgen-sit2.hdfcuat.bank.in`, **`api-nb-nextgen-sit2.hdfcuat.bank.in`**,
  `www.api-nb-nextgen-sit2.hdfcuat.bank.in`, `nb-nextgen-sit2.hdfcbank.com`
- sit cert SANs: `nb-nextgen-sit.hdfcuat.bank.in`, `www.nb-nextgen-sit.hdfcuat.bank.in`,
  `nb-nextgen-sit.hdfcbank.com`
- Reveals a dedicated **API host** and an alternate domain `*.hdfcuat.bank.in`.
- **NOT in the authorized target list** (`*.hdfcbank.com` SIT hosts only). Flagged for user
  confirmation / formal sharing before any active testing. Recon-noted, untouched.

## HTTP / edge
- Both `GET /` → `302` → `/retail-app` (retail net-banking SPA entry).
- **WAF = F5 BIG-IP ASM** — `TS01xxxx` session cookies; `OPTIONS /` → `403 Forbidden`
  (method/anomaly blocking). Edge = F5 in front of AWS ALB (ap-south-1).
- `Server` header stripped.

## Security headers (both hosts)
- `Strict-Transport-Security: max-age=31536000; includeSubdomains; preload` ✅
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  font-src 'self'; img-src 'self'; frame-src 'self'; upgrade-insecure-requests`
  — tight; **no `object-src 'none'` / `base-uri 'self'`** (note for client-side phase).
- `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`,
  `X-XSS-Protection: 1; mode=block`, `Referrer-Policy: no-referrer` ✅

## Config anomalies (feed to task 9/10)
- `Permissions-Policy: geolocation=(self "https://example.com")` — **example.com placeholder
  allowlisted** — leftover/misconfig. Low sev, report-worthy.
- `Timing-Allow-Origin: nb-nextgen-sit2.hdfcbank.com` — malformed (bare host, no scheme).
- Session cookie `TS01...`: `Secure; HttpOnly; Domain=.<host>` but **no `SameSite`** — flag
  for CSRF phase (10).
- Env diff: sit2 emits `Access-Control-Allow-Origin` on redirect, sit does not.

## Ledger updates
Add `/retail-app` (both hosts, GET, app entry).
