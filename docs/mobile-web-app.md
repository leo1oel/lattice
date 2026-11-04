# Installable mobile workspace

The standalone headless server can serve the regular Lattice frontend over a
private HTTPS origin. Open that address while connected to the server's tailnet,
sign in with the server access token, then use the browser's **Install app** or
**Add to Home Screen** action. Safari on iPhone exposes this under Share; desktop
browsers expose installation in their address bar or menu when available.

On browser windows at most 700px wide, the workspace frames one existing panel
at a time. The bottom controls reach Project, the active Editor, PDF, additional
panels, Save and Build. Opening a project file brings its editor forward. The
same editor buffers and panels stay mounted while navigating. Returning to a
wider window restores the previous framing; phone navigation does not overwrite
the stored desktop arrangement. The PDF toolbar scrolls when it cannot fit.

The service worker is registered only on the standalone server, in a secure
context. It is network-only: it does not cache HTML, project data, API responses,
or authentication. When the server cannot be reached, opening the app displays a
reconnection page. Editing requires the live server. Installing the app does not
make the server public or bypass its authentication. Native Tauri windows and
single-use desktop browser handoffs do not register this worker.

Supported operations still depend on the connected server's capabilities.
Installation and a mobile layout do not add a terminal, an AI backend, or a LaTeX
distribution to the server.
