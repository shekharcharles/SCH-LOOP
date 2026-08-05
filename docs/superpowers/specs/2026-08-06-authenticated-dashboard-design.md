# Authenticated dashboard — design

**Status:** approved, not yet implemented
**Date:** 2026-08-06
**Baseline:** `main` at `d364899`

## The problem

`dashboard.mjs` binds `0.0.0.0` and requires no authentication. The only
protection is a CSRF token, and CSRF is not authentication: it stops a *third-party
site* from driving the dashboard through a victim's browser. It does nothing
against a client that simply connects.

Anyone who can reach port 4600 can read every project, every task, every finding
and every gate, and can POST: halt a project, arm or disarm scope, answer a
blocked question, requeue or close tasks. The CSRF token is served inside the
HTML they just fetched.

The README already says unauthenticated dashboard writes are not supported and
that the control plane must be authenticated before anything is exposed. The code
does not enforce it.

## Decision

**A shared secret, required on every request.**

- A token is generated on first start and stored at `$SCH_HOME/dashboard-token`
  with owner-only permissions where the platform supports it. It survives
  restarts, because a token that rotates on every restart cannot be bookmarked on
  a phone.
- Every request must present it: `Authorization: Bearer <token>`, a `token` query
  parameter, or the `sch_token` cookie. A `?token=` request sets the cookie and
  redirects, so the phone link is used once and the token stops appearing in
  browser history and server logs thereafter.
- Anything unauthenticated gets **401 and nothing else** — no project list, no
  task counts, no hint about what exists.
- CSRF stays exactly as it is, for POSTs, in addition. Authentication answers
  "who are you"; CSRF answers "did you mean to". Both.

**The default bind becomes `127.0.0.1`.** Listening on every interface is now an
explicit choice (`SCH_BIND=0.0.0.0`), not the default. Authentication makes that
choice defensible; it does not make it automatic.

**Token comparison is length-safe.** `timingSafeEqual` over hashes of both sides,
so a wrong-length token cannot throw and the comparison does not leak position.

## Pack visibility

The run record has carried a `pack` section since the capability-pack milestone
and nothing shows it. `/api/runs` gains the pack's manifest name, its skill
count and its refusals, so an operator can see what a worker was actually given
without reading JSON on disk. Skill *bodies* are never exposed — the same rule
that keeps prompts off the wire.

## Testing

Hermetic: the server is started as a child process on an ephemeral port with a
temporary `SCH_HOME`, and torn down after.

- A request with no token gets 401, and its body contains no project id.
- A request with the wrong token gets 401.
- A request with the right token gets 200.
- A POST with a valid token but no CSRF is still refused.
- `?token=` sets a cookie and the cookie alone then works.
- The token file is created once and reused across restarts.

## Out of scope

- Multiple users, roles, or per-project permissions. One operator, one secret.
- TLS. That is the tunnel's job, not this server's.
- Rate limiting or lockout.
