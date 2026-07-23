# app-dev — accumulated knowledge

Generalizable techniques distilled from completed tasks. Never target-specific.

## Injecting behavior into a prebuilt/compiled player or third-party bundle
- A compiled player bundle (e.g. video.js/VHS) often does **not** expose its
  library global (`window.videojs` may be absent), so documented public hooks
  like `videojs.Vhs.xhr.beforeRequest` are unreachable from app code. Verify the
  global actually exists at runtime before building on it.
- When a hook is unreachable, attach at the **transport layer** instead: a small
  `XMLHttpRequest.prototype.open` (or `fetch`) shim, tightly scoped by URL regex,
  is bundle-agnostic and reliable. Only rewrite the exact URLs you own; pass
  everything else through untouched so default behavior never changes.
- Prefer a same-origin **query param** over a custom header when you can only
  wrap `open` (a header needs `setRequestHeader` after open) — but a token in the
  URL lands in access/proxy logs + history, so use a header when feasible.

## Auth-gated media keys (DRM/encrypted HLS)
- Encrypted-HLS `#EXT-X-KEY URI` fetches are issued by the player, not your app;
  the only place to attach a per-session token is that player's request path.
- Fetch the short-lived token **on mount** (before playback starts) and read it
  **live** at request time, so key fetches (which happen later, at play) carry it.
  A key request that races ahead fails closed (403) — never leaks plaintext.
- Gate the token fetch to authenticated + actually-encrypted media only, so you
  don't create playback sessions for every view.

## nginx auth_request / X-Accel gating — path canonicalization
- With `auth_request` protecting an `alias`/`location`, nginx normalizes the URI
  it uses for **location matching and file serving** (collapses `//`, resolves
  `/./`), but forwards the **raw** `$request_uri` to the auth subrequest. So an
  auth view that string-matches the raw path (`startswith`, prefix deny) is
  bypassable: `/media//protected/x` and `/media/./protected/x` serve the file yet
  slip past the check. **Canonicalize before deciding**:
  `posixpath.normpath("/" + relpath).lstrip("/")`. Pin the `//`, `/./`, `%2e`
  variants with regression tests — a green canonical-path test proves nothing about
  the bypass.
- A `location /media { alias ... }` with **no** `auth_request` (present in default
  MediaCMS nginx) is a defense-in-depth hole: only shadowed by a more-specific
  protected regex location, and reachable via case variants on case-insensitive
  volumes. Gate it too.

## Private/DRM media: originals are server-only
- In a DRM/private-media platform, the plaintext master upload (and often the
  plaintext transcoded renditions) must **never** be served to a client, even for
  "public" media — the app's own visibility states (public/unlisted → allow-anyone)
  are the wrong gate. Playback goes through auth-gated encrypted HLS only. Deny the
  `original/` (non-thumbnail) path outright; assess `encoded/` renditions the same way.
- On a security boundary, prefer a **fail-closed allowlist** over a denylist when
  the input space is admin-extensible: e.g. gating `encoded/` by "deny video
  extensions" fails open the moment an admin adds a new `EncodeProfile.extension`
  (av1, raw ts). Allow only the tiny known-safe set (preview images) and deny the
  rest — same line count, safe against future additions. Pin a fail-closed test
  (unknown extension / no extension → denied).
- Verify "downloaded video is blank": confirm on-disk HLS segments are actually
  AES-128 encrypted (MPEG-TS sync byte 0x47 should appear every 188 bytes in
  plaintext; near-zero + entropy ≈8.0 bits/byte means encrypted) AND that the key
  endpoint 403s without a valid token. Both together = undecryptable without auth.

## Validating a frontend change end-to-end (this stack)
- Frontend build: `node node_modules/pixelmantra-scripts/cli.js build --config=./config/mediacms.config.js --env=dist` (the `.bin` shims are POSIX sh, fail under `node`; call `cli.js` directly). jest: `node node_modules/jest/bin/jest.js <path>`.
- Deploy to the running stack: `cp -r frontend/dist/static/* static/` then `docker compose restart web`. The web container runs a recursive `chown` over the bind-mount on start — expect ~1–2 min before HTTP answers; poll `curl :7234/` for 200, don't assume crash.
- For an auth-gated portal (mandatory email verification + admin approval), a
  throwaway superuser needs BOTH `user.is_approved`/verified fields AND an
  allauth `EmailAddress(verified=True, primary=True)` row, or login redirects to
  confirm-email. Delete the throwaway user after validation.
- Verify server authz responses with curl (mint a token in `manage.py shell`) AND
  drive the real browser (Playwright) to confirm the client actually attaches it —
  a green server test alone doesn't prove the compiled client wired it.
