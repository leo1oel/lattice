# Standalone headless server and CLI

`server/` builds a Linux/macOS binary with no Tauri, WebView, GTK, display server,
or desktop session. It compiles the existing project, history, bibliography,
Git, LaTeX, literature and Overleaf domain sources through `headless_core.rs`;
there is no second implementation of project persistence or sync.

This is an initial server API, **not full desktop parity**. Run `capabilities`
to inspect the supported commands. Native windows/dialogs, embedded sign-in,
system keychain, Synara/agent sidecar, terminal and Texlab are currently
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
has its own active project. `open_project` changes only that session; multiple
devices can open different papers. Explicit `projectRoot` arguments pin mutations
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
- `GET /api/asset?path=...`: authenticated workspace-confined bytes; hidden
  control directories are rejected. Relative paths use the session's project.
  For PDF ranges, add `version`, `start`, `end` from `read_project_asset`;
  response contains bytes `[start,end)`. Version mismatches return HTTP 409.
  Range reads reuse the domain's symlink/version checks and 16 MiB bound.

`read_compiled_pdf` and `read_project_asset_range` return JSON byte arrays through
invoke. Browser adapters convert them to ArrayBuffers, or use the binary asset
endpoint. Static `index.html` receives the `__LATTICE_HEADLESS__` bootstrap flag;
all assets remain same-origin.

## Verification

```sh
cargo build --locked --manifest-path server/Cargo.toml
env -u DISPLAY -u WAYLAND_DISPLAY \
  LATTICE_SERVER_BINARY="$PWD/server/target/debug/lattice-server" \
  LATTICE_TEST_LATEX=1 python3 server/tests/smoke.py
```

These production-binary tests exercise authentication, cross-origin rejection,
cookie revocation, independent session projects, pinned writes, path/symlink
escapes, shared history and CLI persistence, static bootstrap, a real LaTeX
build, PDF bytes and stale-version range rejection. Without
`LATTICE_TEST_LATEX=1`, only the toolchain-dependent test is skipped. No desktop
process or mock backend is launched.

## Authenticated media streaming

Ordinary `GET /api/asset?path=...` responses stream from one confined regular-file
descriptor in bounded chunks. MP4/M4V, WebM and QuickTime receive video MIME
types; MP3, M4A, WAV and Ogg receive audio MIME types. A browser still needs a
decoder for the actual codec: this route does not transcode or add a project
video editor. The native slide runtime and headless slide editing remain
separate capabilities.

The route retains session/Bearer authentication, origin checks, `nosniff`, a
sandbox policy and private `no-store` responses. Directory traversal, hidden
paths, symlinks at any path component and non-regular files are refused.
An authenticated `HEAD` returns metadata without reading the file body and
ignores Range. A single `Range: bytes=start-end`, open-ended or suffix request
returns 206 with Content-Range; invalid or unsatisfiable byte ranges return
416. Unknown range units and multipart requests are ignored (a normal 200),
following [RFC 9110 section 14.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.2). `If-Range` restarts from the whole current file when its ETag is stale;
`If-None-Match` can return 304. An open descriptor pins a replaced file, while
ETags distinguish revisions between requests; in-place writes during a transfer
can still change that transfer's bytes, so do not rewrite media being presented.

The existing `version`/`start`/`end` PDF query protocol stays unchanged. Those
version-pinned reads are distinct from ordinary HTTP Range. The former 256 MiB
whole-file limit does not apply to streaming responses; memory remains bounded
by chunk size and backpressure instead of the media file's length.

```sh
LATTICE_SERVER_BINARY=server/target/debug/lattice-server \
  python3 server/tests/media_streaming.py
```

The consumer suite uses a real binary, including a 1 GiB sparse media asset,
GET/HEAD/range validators, disconnects, authentication/origin checks and a
parent-directory symlink swap. It needs neither a graphical display nor TeX.
