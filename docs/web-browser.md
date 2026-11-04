# In-app web browsing

Use the command palette's **Open web browser** action to open a separate Lattice
browser window. It starts at a public example page. The native **Browser** menu
provides Back, Forward, Reload, Address and navigation, Open in default browser,
and Close. Command-L opens a small trusted address window; enter an HTTP(S)
address and choose Go. It hides after navigation, returning focus to the website.
That address window also has navigation buttons. The native website window's
title includes its actual origin and page title.

The page is a normal, single native WebView, not an iframe. Sites may still
reject embedded user agents or require the default browser for SSO; Lattice
does not bypass their policies. Popup links navigate inside the same isolated
window. Downloads and non-web schemes are blocked; use **Open in default
browser** for downloads or another application's links.

This is a separate window, not a dockable Trellis panel. It leaves the research
workspace and live editor hosts in place. Up to four browser windows may remain
open. These WebViews use an ephemeral browsing store rather than the workspace's
persistent sign-in cookie store, and never inspect browser profiles. Closing the
website also destroys its address window; closing only the address window hides
that control without losing the website.

In a browser-hosted/headless workspace, the command is labeled **Open a web
browser tab** and opens the browser's ordinary tab instead. A remote browser
cannot create a native WebView, and framing a protected site would not provide a
working replacement.

## Security and keyboard boundaries

The trusted address controls use an independent `browser.html` entry. It never
mounts App and is restricted to its app origin. The remote view uses the
`site-content-*` label, which matches none of the workspace capability patterns.
No plugin capability is granted to it. Before app-command dispatch,
`filter_invoke` rejects every custom command from remote content and restricts
the controls to their three status/navigation/action commands. Commands identify
the calling address window, so a caller cannot select another session by ID.
No sidecar token, project state, custom remote script bridge or filesystem
opener is installed in the remote page.

The native Browser menu is enabled only while one of these windows is focused;
its accelerators are disabled in research windows. Native Undo/Redo remains
WebKit's editing history in a website or address field, while research editors
keep their existing command handling. This uses stable single-WebView windows
and keeps the repository's existing command-key regression intact.

## Native verification

Run the fixture without a real account:

```sh
python3 scripts/browser-fixture.py --port 18594
```

In a development/preview build, open the browser, choose Browser → Address and
navigation (Command-L), and enter `http://127.0.0.1:18594/`. The fixture deliberately
sends `X-Frame-Options: DENY` and a `frame-ancestors 'none'` policy, proving the
page is not relying on framing. Follow its second-page link and use the native
Back/Forward/Reload controls. Verify the title and address. Edit the address
field and test native Undo/Redo; Command-W closes its window appropriately.
Select **Check IPC boundary**: both the harmless app-locale command and the
window-size plugin request must be blocked. Open the fixture's `_blank` link
and verify that it remains in the same browser window. Close the browser, then
type and undo in the original research editor to verify it stayed intact.
