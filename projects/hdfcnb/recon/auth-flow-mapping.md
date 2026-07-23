# Recon — Auth-Flow Mapping (task 6)

Date 2026-07-23 · in-scope host nb-nextgen-sit2.hdfcbank.com · browser-driven, no creds.

## Identity provider = Keycloak (in-scope)
- IdP: **Keycloak** at `/auth/`, realm **`retail`**, client **`bb-web-client`** (public).
- Flow: **OAuth2 Authorization Code + PKCE (S256)** — `response_type=code`,
  `code_challenge_method=S256`. Good (PKCE on public client).
- redirect_uri: `https://nb-nextgen-sit2.hdfcbank.com/retail-app/select-context` (same-origin).
- Login page title "Sign in to HDFC Net Banking"; banner "Use this website for Testing
  Purposes only" (SIT confirmed).

## OIDC endpoints (from public well-known)
- authorize: `/auth/realms/retail/protocol/openid-connect/auth`
- token: `/auth/realms/retail/protocol/openid-connect/token`
- userinfo: `.../userinfo` · logout: `.../logout` · jwks: `.../certs`
- dynamic client registration: `.../clients-registrations/openid-connect`

## Login form (SPA)
Customer ID/User ID + Password + Login. Extras: **Login-without-Password (Kavach QR scan)**,
virtual keyboard (anti-keylog), Show Password, Set/Reset Password, Register Now, Get Cust ID.
Tabs: Personal Banking / Credit Cards-Loans.

## Findings / leads
1. **[LEAD med] Weak OAuth grant types advertised** — `grant_types_supported` includes
   **`password` (ROPC)** and **`implicit`**, both discouraged by OAuth 2.0 Security BCP.
   ROPC on a bank IdP = direct username/password→token, bypassing PKCE/redirect + enabling
   token-endpoint credential brute. NOTE: realm-level advertisement; must verify `bb-web-client`
   (or any client) actually permits Direct Access Grants. **Test in task 21** (active: POST
   password grant to token endpoint). Not yet confirmed exploitable.
2. **[LEAD low] Keycloak admin console reachable** — `/auth/admin/` → 302 (login redirect),
   `/auth/admin/master/console/` → 403. Admin console should be network-restricted, not
   internet-facing. Verify/report in config phase (task 11).
3. **[info] Realm public key exposed** at `/auth/realms/retail` — normal Keycloak behavior
   (token-verification key), documented not vuln. Recorded for completeness.
4. `/auth/realms/retail/account/` → 404 (Keycloak account console disabled/moved).

## Handoff
- Task 21 (pre-auth authn): test ROPC (`grant_type=password`) + implicit against token
  endpoint; user-enum via login/reset; OTP/MFA logic; login rate-limit/lockout.
- Wave B token acquisition: Authorization Code+PKCE via the Keycloak login (needs passwords),
  or ROPC if it proves enabled (faster token for API testing).
