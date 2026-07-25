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

## Reading the codebase before building (seen:1)
- **"Feature missing" is often "feature broken".** Before implementing a UI
  affordance an AC asks for, check whether it already exists and silently fails.
  A client reading the wrong key off a JSON response (`data.count` when the API
  returns `data.unread`) renders nothing and is indistinguishable from
  unimplemented — but the fix is one line, not a feature. Grep the component
  first, then the endpoint's actual response shape.
- **Verify "no backend exists" by field name, not feature noun.** Searching a
  models file for the product word ("follow") missed a `subscribers`
  ManyToMany whose reverse accessor was the actual feature. Grep for M2M/FK
  declarations in the model file and read their `related_name`s before claiming
  a relation is absent — an omission justified by a wrong claim is worse than
  the omission.
- **Prove a conditional element renders by creating its condition.** A badge
  gated on `count > 0`, checked while the count is 0, proves nothing. Insert a
  row / trigger the state, then assert.

## CSS override layers (seen:1)
- **An override sheet that loads after the base at equal specificity REPLACES,
  it does not add.** Setting `padding-bottom` in the theme layer silently drops
  a base `padding-bottom` from the compiled component CSS. Where the base value
  is meaningful, write `calc(<base> + <new>)` or scope the selector tighter.
- **This is invisible in dev when the new value resolves to 0.**
  `env(safe-area-inset-*)` is 0 on every non-notched device and all desktops, so
  a clobbering rule looks fine locally and strips spacing for nearly all users.
  Check the computed value before and after, not just the rendered screenshot.
- `env(safe-area-inset-*)` only resolves once the viewport meta carries
  `viewport-fit=cover`; without it the rules are inert no matter how correct.

## Container start on bind-mounted repos (supersedes the earlier ~1-2 min note)
- An entrypoint that recursively `chown`s a bind-mounted project stalls on
  `node_modules` (tens of thousands of files); over a Windows/macOS bind mount
  every chown is a host round trip and the web server never starts. `-prune` the
  dependency and VCS trees and add `! -user <target>` so later boots skip
  already-correct files. Measured: indefinite stall → ~30s.

## Windows editing hygiene (seen:1)
- Editors on Windows can rewrite a whole file as CRLF, turning a one-line change
  into a several-hundred-line diff that hides the real change from review.
  Check `git diff -w` — if it is empty, the diff is pure line-ending churn.
  Normalise back to LF before committing.

## One card type, several components (seen:1)
- A media list can render each media type through a **different** component with
  its own thumbnail branch. Adding an overlay to the shared thumbnail helper
  covered images but silently missed video, which had its own copy. When adding
  a card affordance, grep every component the list's type switch can dispatch to
  and check each one's thumbnail render, rather than assuming one shared path.

## Config that reaches the SPA is derived, not raw (seen:1)
- A settings object handed to the frontend is often re-shaped by an init step
  before the store exposes it (raw `hideViews` → derived `displayViews`). Adding
  a key to the template config is not enough: unless the init function copies it
  through, the store returns undefined and the feature silently no-ops. Trace
  template → init → store getter before assuming a new flag is readable.
- Gate any "this content is protected" badge on a real server-side flag with a
  **false default**, never on media type alone. A protection claim that the
  deployment is not honouring is worse than no badge.

## Grid-ifying a base theme's list (seen:1)
- Converting a vendor block/float list to CSS grid will also catch that theme's
  horizontal carousels if they share the list class. Look for a distinguishing
  modifier on the outer element (e.g. an inline/slider class) and scope with
  `:not(...)`, then assert in the browser that the carousel is still not a grid.
- The base usually sizes each card with a fixed width/float; inside a grid track
  reset `width:auto; float:none; margin:0` on the item or the track width is
  ignored.

## Scoping an override against a vendor theme's own stylesheets (seen:1)
- **Check which sheet loads last before assuming your override wins.** A theme
  overlay linked in the base template can still lose to a *page-specific*
  stylesheet linked afterwards. At equal specificity the later sheet wins, and
  the rule looks correct in source while doing nothing in the browser. Confirm
  by walking `document.styleSheets` for rules that `element.matches()` and
  comparing their `href`, rather than reading the CSS and assuming.
- **Opt-in beats opt-out when scoping a layout change.** `:not(.someVariant)`
  assumes you know every variant the vendor ships; the one you did not know
  about breaks. Name the class that *wants* the behaviour.
- **But verify the two classes actually co-occur.** A wrapper class and an inner
  list class are often on different elements, so a compound selector
  (`.a.b`) silently matches nothing while a descendant selector (`.a .b`) is
  correct. A rule that matches nothing fails silently in exactly the same way as
  a rule that is absent — assert the computed style, not the source.

## Uppercase UI labels may be i18n keys (seen:1)
- Before sentence-casing a SHOUTED label in source, grep the locale files for the
  literal string. Lookup helpers of the form `TRANSLATION[str] ?? str` treat the
  English text AS the key, so renaming it in JSX silently drops the translation
  in every locale and falls back to English. Change the presentation
  (`text-transform` + `::first-letter`), never the key.

## Django template comments (seen:2)
- `{# ... #}` is **single-line only**. A multi-line one renders its text as
  visible page copy. When it sits in an included head/meta partial it leaks on
  every page in the site and is easy to miss, because it appears above the
  layout rather than inside the component being reviewed. Use
  `{% comment %}...{% endcomment %}` for anything over one line, and grep the
  tree (`\{#` with a newline before `#}`) after adding template comments.

## Reskinning a vendor auth flow (seen:1)
- Count the templates before estimating. An auth flow is not the 3 screens you
  think of (login/signup/reset) — allauth alone ships confirm-email,
  verification-sent, verified-email-required, account-inactive, reset-done,
  reset-from-key(-done), password-change, password-set, logout, signup-closed.
  Grep which ones still extend the old base rather than assuming.
- A screen carrying its own inline `<style>` block is the one that will stay
  light in dark mode. Search templates for `<style>` before declaring a theme
  migration complete.
- For forms rendered through the form object (`form.as_p`, crispy), style the
  generated markup with one rule set (label / input / helptext / errorlist)
  instead of hand-rendering each form. Field names differ per form, so
  hand-rendering trades a styling problem for a naming-bug problem.
- Moving an inline `<script>` into a head block breaks any
  `addEventListener` registered at parse time, because the element does not
  exist yet. Function declarations referenced by `onchange=` attributes still
  work (hoisting); listener registration needs `DOMContentLoaded`.
