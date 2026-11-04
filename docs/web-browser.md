# In-app web browsing

Use the command palette's **Open web browser** action to open a separate Lattice
browser window. It starts at a public example page; enter any HTTP(S) address in
the bar. Back, Forward, Reload, Go, Open in default browser and Close operate on
that window. The page title and current address follow navigation, including
redirects. A pending edit in the address bar is not overwritten by polling.

The web page is a native child WebView beneath the navigation bar, not an
iframe. Sites may still reject embedded user agents or require the default
browser for SSO; Lattice does not bypass their policies. Popup links navigate
inside the same isolated window. Downloads and non-web schemes are blocked;
use **Open in default browser** for downloads or another application's links.

This is a separate window, not a dockable Trellis panel. It leaves the research
workspace and live editor hosts in place. Up to four browser windows may remain
open; closing one releases its page. These WebViews use an ephemeral browsing
store rather than the workspace's persistent sign-in cookie store, and never
inspect browser profiles.

In a browser-hosted/headless workspace, the command is labeled **Open a web
browser tab** and opens the browser's ordinary tab instead. A remote browser
cannot create a native child WebView, and framing a protected site would not
provide a working replacement.

## Security boundary

The trusted toolbar is an independent `browser.html` entry. It never mounts
App and is restricted to its app origin. The remote view uses the dedicated
`site-content-*` label, which matches none of the workspace's capability
patterns. No plugin capability is granted to it. Before app-command dispatch,
`filter_invoke` rejects every custom command from remote content and restricts
the toolbar to the browser command family. Browser commands identify the
calling toolbar, so a window cannot select another window by supplying an ID.
No sidecar token, project state, custom remote script bridge or filesystem
opener is installed in the remote page.

The native child API requires Tauri's `unstable` multi-webview feature; it does
not add another browser engine. The toolbar has its own build chunk, keeping
the research workspace out of this small entry.

## Native verification

Run the fixture without a real account:

```sh
python3 scripts/browser-fixture.py --port 18592
```

In a development/preview build, open the browser and navigate to
`http://127.0.0.1:18592/`. The fixture deliberately sends `X-Frame-Options:
DENY` and a `frame-ancestors 'none'` policy, proving the page is not relying on
framing. Follow its second-page link, use Back/Forward/Reload, resize the
window, and verify the title/address. Select **Check IPC boundary**: both the
harmless app-locale command and the window-size plugin request must be blocked.
Open the fixture's `_blank` link and verify that it remains in the same browser
window. Close the browser, then type in the original research editor to verify
the workspace stayed intact.
