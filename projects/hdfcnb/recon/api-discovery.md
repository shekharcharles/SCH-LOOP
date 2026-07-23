# Recon — API Discovery (task 5)

Date 2026-07-23 · target nb-nextgen-sit2.hdfcbank.com/api/ · unauth sweep, 401/404 oracle, throttled.

## Confirmed live services (401 Bearer — deployed, auth-enforced)
| Service | Endpoints confirmed |
|---------|---------------------|
| access-control | client-api/v2/accessgroups, v3/accessgroups, v3/accessgroups/user-context/permissions, v2/users/permissions |
| user-manager | client-api/v2/users, v2/users/me |
| arrangement-manager | client-api/v2/product-summary, v2/products, v2/arrangements |
| transaction-manager | client-api/v2/transactions |
| contact-manager | client-api/v2/contacts |
| limit | client-api/v2/limits |

## 404 at guessed paths (deployed under different route/version — NOT confirmed absent)
account-statement, payment-order, approval, device, product-summary, notification,
message-center, config, audit, card, payment(beneficiary), customer, identity, registration,
actions. These appear in the JS bundle → they exist client-side; the gateway route
(service name / version) differs. **Exact paths deferred to authenticated XHR capture**
(task 34) — no blind path-brute (WAF + rabbit-hole risk).

## Coverage result (black-box)
- **No unauthenticated-reachable (200) endpoint** among real services — every live path
  returns 401 with `WWW-Authenticate: Bearer`. Gateway auth enforcement holds black-box.
- Logged as finding: **unauth API access-control = tested-clean** (info). Authenticated
  BOLA/BFLA/IDOR re-test = tasks 25/26 once creds arrive.

## Notes
- All real endpoints need an **OAuth2 Bearer/JWT**. Wave B blocked on token (passwords).
- Login/token endpoint not on /api/* → OAuth authorization flow; task 6 captures it live.
