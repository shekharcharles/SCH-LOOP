# Recon — JS Harvest + Analysis (task 4)

Date 2026-07-23 · bundles from nb-nextgen-sit2.hdfcbank.com/retail-app/.

## Bundles
- main.9e8f04248ee57b6d.js (3.06 MB), runtime (7 KB), polyfills (35 KB).
- Prod-minified Angular; no hardcoded API base, no secrets/keys found (grep: apikey/secret/
  bearer/password → none). API base composed at runtime.

## Cross-domain references (OUT OF SCOPE — flagged, untouched)
- `insurenow-uat.insurance.hbctxdom.com` (insurance UAT, 3rd-party domain)
- `dev1.mbv3.hdfcbank.com` (mobile-banking v3 dev host)
- `assets.adobedtm.com` (Adobe DTM tag manager), `www.hdfc.bank.in`
- `localhost` x3 (dev leftovers in bundle)
Do not test. Note in report as info-leak (internal hostnames in client JS).

## API gateway — IN SCOPE (major)
**`https://nb-nextgen-sit2.hdfcbank.com/api/{service}/client-api/v{n}/...`** — the Backbase
gateway mounts on the in-scope host. Auth = **OAuth2 Bearer** (`WWW-Authenticate: Bearer
error="invalid_token"`), i.e. JWT resource server. Gateway `Server: nginx` → Spring Boot.

### Enumeration oracle (false-positive filter)
- **401, empty body, `WWW-Authenticate: Bearer`** = real service, needs token.
- **404 + Spring JSON** (`{"timestamp","path","status"...}`) = routed prefix, path absent.
- **404 + styled HTML page** = single-segment / gateway-level miss.
- `/retail-app/api/...` = **SPA index.html catch-all (200)** — ignore, not the API.

### Confirmed-existing (401, auth-required)
| Endpoint | Service |
|----------|---------|
| /api/access-control/client-api/v3/accessgroups | access-control |
| /api/user-manager/client-api/v2/users/me | user-manager |
| /api/transaction-manager/client-api/v2/transactions | transaction-manager |
| /api/arrangement-manager/client-api/v2/product-summary | arrangement-manager |

### Absent as guessed (404) — need correct path/version
- /api/auth/login, /api/login, /api/oauth/token, /api/token, /api/identity/login,
  /api/payment-order/client-api/v2/payment-orders
- Login/token NOT under /api/* → **OAuth2 authorization flow via identity provider**;
  capture live in task 6 (auth-flow mapping).

### Backbase capability services seen in bundle (→ task 5 full sweep)
access-control, user-manager, arrangement-manager, transaction-manager, account-statement,
payment-order, contact-manager, approvals/approval, device, limits, actions, product-summary.

## Security posture notes
- API responses: HSTS, `X-Frame-Options: DENY`, nosniff, `X-Download-Options: noopen`,
  `X-Permitted-Cross-Domain-Policies: none`, `Cache-Control: no-store`. Good.
- Errors not verbose (no stack traces) → verbose-error class likely clean (confirm task 11).

## Handoff
- Task 5: sweep every Backbase service × version (v1/v2/v3) unauth using the 401/404 oracle →
  build full endpoint inventory; find any unauth-reachable (200) endpoint.
- Task 6: drive the browser login to capture OAuth token endpoint + flow.
- Wave B (auth): OAuth2 Bearer token needed → passwords.
