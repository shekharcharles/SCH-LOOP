# ADR 0008 — CSRF is not authentication

**Status:** accepted · Precedes any remote or unattended operation
**Date:** 2026-08-06

## Context

`dashboard.mjs` bound `0.0.0.0` and required no authentication. Its only
protection was a per-process CSRF token embedded in the pages it served.

CSRF and authentication answer different questions. CSRF answers *did you mean
to do this* — it stops a third-party site driving the dashboard through the
operator's browser. Authentication answers *who are you*, and there was no
answer. Any client that could reach port 4600 could read every project, task,
finding and gate, and could POST: halt a project, arm or disarm scope, answer a
blocked question, requeue or close a task. The CSRF token was in the HTML it had
just been served.

The README already stated that unauthenticated dashboard writes are unsupported
and that an authenticated control plane must come before remote operation. The
code did not enforce it.

## Decision

**A shared secret on every request, and 401 with nothing attached otherwise.**

- Generated once, stored at `$SCH_HOME/dashboard-token`, mode 0600 where the
  platform honours it. It is not rotated per start: a secret that changes hourly
  is a secret an operator disables.
- Presented as `Authorization: Bearer`, as `?token=`, or as the `sch_token`
  cookie. A `?token=` request sets the cookie and redirects, so the phone link is
  used once and the secret stops living in history, bookmarks and proxy logs.
- Compared with `timingSafeEqual` over SHA-256 of both sides, because that
  function throws on a length mismatch and the throw is itself a signal.
- Enforced before routing, including the SSE stream.

**CSRF stays, in addition.** Two questions, two answers.

**The default bind is `127.0.0.1`.** Every-interface is now a decision
(`SCH_BIND=0.0.0.0`), not an accident. Authentication makes that decision
defensible; it does not make it automatic.

## Pack visibility

The run projection now carries the capability pack's manifest name, its skill
ids and its refusals. Names and counts only — a skill body is instructions, and
instructions stay off the wire for the same reason prompts do.

## Alternatives rejected

- **Binding loopback and calling it done.** The operator explicitly wants to
  steer from a phone over a tailnet. Loopback-only would be secure and useless.
- **Rotating the token per start.** Unbookmarkable, and the predictable outcome
  is an operator who turns the check off.
- **Users, roles and per-project permissions.** One operator, one secret. More
  identity than that is a product decision nobody has made.
- **TLS here.** The tunnel's job.

## Consequences

- Existing bookmarks stop working until re-opened with `?token=`. The startup
  line prints the exact URL.
- Anything scripted against the dashboard must send the header.
- The token file is a secret in `SCH_HOME`. It is excluded from the repository by
  construction — `SCH_HOME` is not the repository — and the secret scanner
  already refuses to commit credentials.

## What is still NOT true

- No TLS, no rate limiting, no lockout, no audit of who acted.
- One secret means one identity: the dashboard cannot tell two operators apart.
- Authentication does not make unattended operation safe. Every worker caveat in
  ADR 0004, 0006 and 0007 stands unchanged.
