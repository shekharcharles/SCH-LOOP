# Recon — Content Discovery (task 3)

Date 2026-07-23 · target nb-nextgen-sit2.hdfcbank.com · throttled (F5 ASM present, no wordlist storm).

## App platform
- **Backbase Retail Apps** SPA (`<bb-app-root>`, `bb-retail-app`, community.backbase.com ref)
  on **Angular** (hashed bundles, CSP nonce `ngcspnonce`, `theme-default.<hash>.css`).
- Title: "Welcome to HDFC Bank NetBanking". `base href=/retail-app/`.
- Backend: **Spring Boot** (see `/actuator` below) behind Backbase gateway.

## JS bundles (→ task 4 targets)
- `/retail-app/main.9e8f04248ee57b6d.js`  ← primary; parse for endpoints/routes/config
- `/retail-app/polyfills.859a2b19539c20f1.js`
- `/retail-app/runtime.8ef31f7d1b2f342a.js`
- `/retail-app/assets/error-fallback.js`
- assets: hdfc-logo.svg, browser-settings-icon.svg, error-message.css

## Paths probed (root + curated)
| Path | Code | Note |
|------|------|------|
| /robots.txt | 200 | `User-agent: * / Disallow: /` (blanket, no leakage) |
| /sitemap.xml | 404 | — |
| /retail-app/ | 200 | SPA shell |
| /retail-app/api , /retail-app/api/ | 200 | **SPA catch-all = index.html, NOT a real API** (false positive) |
| /actuator | 403 | **Spring Boot actuator present, secured/WAF** → probe sub-paths in task 11 |
| /health | 200 | plaintext `healthcheck` (LB probe), octet-stream, low value |
| /api /api/edge /gateway | 404 | not at root — API is via Backbase gateway (parse JS) |
| /.well-known/security.txt /manifest.json /assets/ | 404 | — |

## Key filter (false positive)
**Under `/retail-app/`, any unknown path returns HTTP 200 with the Angular index.html**
(client-side routing fallback). Status code is useless for existence here — must inspect
content-type/body. Blind dir-brute on `/retail-app/*` is worthless; endpoint discovery =
JS-bundle parsing (task 4) + Backbase gateway path knowledge (task 5).

## Leads
- `/actuator` 403 → task 11: try `/actuator/{health,env,heapdump,mappings,configprops}`
  (may 403, but heapdump/env leak secrets when misconfigured).
- Real API likely on flagged host `api-nb-nextgen-sit2.hdfcuat.bank.in` (out of scope) OR a
  gateway path revealed in main.js — task 4 decides.
