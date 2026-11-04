# Overleaf sign-in through the default browser

Settings → Overleaf and the Overleaf project picker offer **Open in default
browser** beside the native sign-in flow. The default browser can use its usual
password manager and institution/SSO login. Opening that page does not connect
Lattice: this is an explicit browser-session import, not an OAuth callback.

After signing in, open the browser's developer tools, then Storage/Application
→ Cookies. Copy the `overleaf_session2` cookie (or `sharelatex.sid` on a
self-hosted instance) as `name=value`. Paste it into the masked session field
and choose **Import browser session**. A session cookie grants account access;
do not put it in an issue, command argument, URL or screenshot.

Lattice validates the cookie against that host's dashboard before saving its
private session file. A failed import preserves a previously stored session.
The field is cleared after success. Validation/opener errors shown in the UI
are fixed messages rather than raw HTTP diagnostics. Nothing reads browser
profiles, password stores or cookie databases automatically.

Native polling, import and disconnect serialize account writes. Import closes
an existing native sign-in window before validating, so a stale native poll
cannot replace the explicitly imported account. The ordinary native sign-in
option remains available for users who prefer automatic session capture.

The browser-hosted/headless frontend needs a local opener adapter and the
authenticated `overleaf_connect_session` endpoint. Native WebView sign-in is
unavailable on a headless server; the explicit session import uses the same
validation and storage core.
