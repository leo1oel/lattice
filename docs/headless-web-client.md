# Standalone server frontend

Build the regular frontend with `pnpm build` and pass its `dist/` directory to
the standalone server's `--assets` option. The server injects an explicit
headless marker into the entry HTML. Desktop Tauri windows, native-host browser
handoffs and static previews keep their existing transport.

The browser first checks `/api/session`. If needed, a password field collects
the server access token and exchanges it for an HttpOnly session cookie. The
token is cleared after exchange and is never put in a URL, localStorage or
sessionStorage. Subsequent invokes, project choices, events and assets use only
same-origin authenticated requests. Use HTTPS and `--secure-cookies` remotely.

The adapter implements the existing Tauri invoke/listen consumers over HTTP
and SSE, handles browser-local window/clipboard/link actions, and uses a server
project picker rather than the client machine's native filesystem picker.
Server capability checks reject unavailable operations explicitly; native-only
features do not silently succeed. PDF byte ranges use the selected project's
versioned asset endpoint, while compiled PDF replies are decoded as binary.

Each browser session selects its own server project. The server confines those
projects to its configured workspace root. Run and install the standalone
server as described in its own documentation; this frontend does not provide
an AI sidecar, terminal or language server by itself.
