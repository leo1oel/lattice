# Standalone headless server and CLI

`server/` builds a Linux/macOS binary with no Tauri, WebView, GTK, display server,
or desktop session. It compiles the existing project, history, bibliography,
Git, LaTeX, literature and Overleaf domain sources through `headless_core.rs`;
there is no second implementation of project persistence or sync.

This is an initial server API, **not full desktop parity**. Run `capabilities`
to inspect the supported commands. Native windows/dialogs, embedded sign-in,
system keychain, Synara/agent sidecar and Texlab are currently
unavailable. Unknown commands return `unsupported_command`. The existing App
frontend needs the separate headless browser adapter to use this API; an
unmodified desktop frontend expects its native bridge.

## Build and run

Requires Rust, a C/C++ compiler for bundled database/PDF dependencies, and
`latexmk` plus a TeX engine for compilation. No JavaScript runtime is needed by
the server itself. Fetch/import tools use the same managed Python tools as the
desktop app; configure provider credentials in the service environment.

```sh
cargo build --locked --release --manifest-path server/Cargo.toml
# Build the ordinary frontend separately when using its headless adapter.
pnpm build
server/target/release/lattice-server serve \
  --workspace-root /srv/lattice/projects \
  --project /srv/lattice/projects/paper \
  --state-dir /srv/lattice/state \
  --token-file /srv/lattice/state/access.token \
  --assets dist --listen 127.0.0.1:18482
```

The token file is created with mode 0600 and must remain a private regular file.
Its value is never printed by the service. Enter it into the browser's server
login form. Successful login sets an HttpOnly, SameSite=Strict cookie scoped to
`/api`, expiring after eight hours. Add `--secure-cookies` behind an HTTPS reverse
proxy. Every data/API endpoint requires the cookie or a Bearer token. The
unauthenticated session probe exposes only mode and authentication state.

The listener refuses non-loopback addresses. Publish it through an authenticated
HTTPS reverse proxy such as Tailscale Serve, rather than exposing the process
port. The reverse proxy must preserve the public `Host` header and support SSE.
The server rejects foreign browser origins. Run it as an ordinary account with
access only to the intended projects: compiling a trusted document or running
its toolchain has that account's filesystem permissions.

Keep `--state-dir` outside the project directory tree so private credentials
can never be served as project assets. `--workspace-root` is the permitted project directory tree. `--project` chooses
the initial project (defaults to the root). Each authenticated browser session
has its own active project. Browser adapters additionally send a fresh random
`X-Lattice-Client` per tab: `open_project` changes only that tab's project, even
when two tabs share a cookie. Asset URLs include the same non-secret `client`
query value; clients without that header keep the session-default behavior.
Multiple devices can open different papers. Explicit `projectRoot` arguments pin mutations
and reject stale requests from a previously selected project. All sessions
share one canonical core/build state per project. A Bearer API client is
stateless and should pass `projectRoot` on each request.

## CLI

```sh
server/target/release/lattice-server capabilities
printf '%s\n' '{"path":"main.tex"}' | \
  server/target/release/lattice-server invoke read_project_file \
    --project /srv/lattice/projects/paper --state-dir /srv/lattice/state
printf '%s\n' '{"force":true}' | \
  server/target/release/lattice-server invoke build_project \
    --project /srv/lattice/projects/paper --state-dir /srv/lattice/state
```

JSON arguments are read from stdin; successful output is `{"result":...}`.
Errors are JSON on stderr and return a nonzero exit status. The same command
names and argument casing are used by desktop IPC and HTTP. `literature_request`
also accepts the existing agent literature `{tool,params}` protocol.

Import an Overleaf session through `overleaf_connect_session` with
`{"host":"https://www.overleaf.com","cookie":"..."}` on **stdin**, never in
command-line arguments or shell history. Obtain the cookie from your own
signed-in browser. The existing domain implementation validates the dashboard
before replacing any session and writes the cookie atomically with mode 0600.
`overleaf_status`, `overleaf_list_projects`, `overleaf_clone_project`,
`overleaf_preview`, `overleaf_sync` and `overleaf_publish_project` reuse the
desktop sync implementation. The service cannot open a useful default browser
on a remote machine; embedded/native login commands report unavailable.

Environment credentials: `OPENALEX_API_KEY`, `SEMANTIC_SCHOLAR_API_KEY` (or
`S2_API_KEY`), `LATTICE_FIRECRAWL_KEY`, `CROSSREF_MAILTO`. Linux managed data and
cache directories respect `XDG_DATA_HOME` and `XDG_CACHE_HOME`.

## HTTP protocol, version 1

- `GET /api/session`: `{headless:true,authenticated,capabilities}`. Capabilities
  are null before authentication.
- `POST /api/session`: JSON `{token}`; creates a cookie session and returns the
  authenticated session description. `DELETE /api/session` revokes it.
- `GET /api/capabilities`: supported commands, events and unavailable desktop
  features. `GET /api/projects`: workspace root and immediate child directories
  as `[{path,name}]`; paths are checked before opening.
- `POST /api/invoke`: `{command,args}` → `{result}` or
  `{error:{code,message}}`. Unsupported commands return HTTP 400.
- `GET /api/events`: SSE default messages containing `{event,payload}`. Uses
  native `project-fs-changed` and `build-progress` payloads. Filesystem changes
  outside the UI are watched too. `resync-required` means the client must refresh
  because events were dropped. Events carry project roots; clients filter them.
- `GET /api/events?client=UUID` also carries that authenticated tab's terminal
  callbacks: `{callback:N,payload:{index:0,message:{__latticeBridgeBinary:"BASE64"}}}`,
  followed by an
  exit message `{exit:codeOrNull}` and the next `{index:N,end:true}`. These are
  the actual Tauri Channel envelopes; the adapter decodes the existing bridge
  binary marker to an ArrayBuffer. SSE IDs support `Last-Event-ID` replay
  during a short disconnection, without exposing output to another tab.
- `GET /api/asset?path=...`: authenticated workspace-confined bytes; hidden
  control directories are rejected. Relative paths use the tab's project when
  `client` is present, or the session's project otherwise.
  For PDF ranges, add `version`, `start`, `end` from `read_project_asset`;
  response contains bytes `[start,end)`. Version mismatches return HTTP 409.
  Range reads reuse the domain's symlink/version checks and 16 MiB bound.

`read_compiled_pdf` and `read_project_asset_range` return JSON byte arrays through
invoke. Browser adapters convert them to ArrayBuffers, or use the binary asset
endpoint. Static `index.html` receives the `__LATTICE_HEADLESS__` bootstrap flag;
all assets remain same-origin.

## Integrated terminal

The web capability list includes `terminal_open`, `terminal_write`,
`terminal_resize`, `terminal_ack`, `terminal_running_command`, and
`terminal_close`. These reuse the desktop PTY/session implementation, including
output flow control and process-group hangup. They require a valid cookie
session, `X-Lattice-Client`, and an already-connected SSE stream for that client;
a Bearer-only invocation cannot create a persistent terminal. The frontend
adapter must wait for SSE readiness and set its terminal capability flag.

Terminal startup is pinned to the selected project. It starts the account's
login shell in that folder, with that account's ordinary terminal permissions;
this is not a sandbox restricting a user's shell commands to the project.
Input is bounded to 256 KiB per request and a 16-message writer queue. Output
pauses above the same 2 MiB unread watermark as the desktop terminal. At most
four terminals per tab and 32 across the service may exist.

Opening another project ends that tab's terminals; signing out ends all tabs of
that session. An SSE connection may reconnect for 10 seconds after the server
observes its loss. Unacknowledged output is replayed with its original channel
indices. An abandoned tab, expired/revoked session, or server SIGTERM/SIGINT
ends its shells and foreground process groups. Hiding the terminal panel does
not end it. As with the desktop terminal, intentionally detached daemons are
outside the foreground job lifetime contract.

## Verification

```sh
cargo build --locked --manifest-path server/Cargo.toml
env -u DISPLAY -u WAYLAND_DISPLAY \
  LATTICE_SERVER_BINARY="$PWD/server/target/debug/lattice-server" \
  LATTICE_TEST_LATEX=1 python3 server/tests/terminal_smoke.py
```

These production-binary tests exercise authentication, cross-origin rejection,
cookie revocation, independent session projects, pinned writes, path/symlink
escapes, shared history and CLI persistence, static bootstrap, a real LaTeX
build, PDF bytes and stale-version range rejection. Without
`LATTICE_TEST_LATEX=1`, only the toolchain-dependent test is skipped. No desktop
process or mock backend is launched.
The terminal suite also executes real Python in a PTY, resizes and interrupts
it, checks ordered callback envelopes and replay, isolates same-cookie tabs and
assets, enforces terminal limits, and verifies logout, disconnect and SIGTERM
cleanup. Native terminal regressions continue to cover the same shared session
implementation.
