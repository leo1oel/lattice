# Headless Codex agent

The optional Linux agent runs the pinned Synara server without a display. The
ordinary headless server does not require an agent runtime. This feature stacks
on the authenticated headless server and tab-owned terminal transport; it does
not make desktop-only window, keychain or editor-language-server APIs available.

## Runtime and authentication

Prepare the repository's pinned Synara artifact first (see
`scripts/prepare-synara-sidecar.mjs`). On the target Linux machine, install it into
an **empty** immutable runtime directory:

```sh
node scripts/prepare-headless-agent.mjs PREPARED_RUNTIME NEW_LINUX_RUNTIME
```

This verifies the pinned Node distribution's SHA-256, installs Linux production
dependencies and Codex 0.166.0, and checks the pinned client router patch. It does
not copy desktop credentials, desktop native executables or desktop node_modules.
Node downloads and npm package installation require network access.

Use a persistent state directory outside release directories. Authenticate its
dedicated provider home directly with Codex; never copy another machine's auth
file or put a provider token in a browser URL:

```sh
mkdir -p STATE/agent-provider/.codex
chmod 700 STATE/agent-provider STATE/agent-provider/.codex
HOME=STATE/agent-provider CODEX_HOME=STATE/agent-provider/.codex \
  RUNTIME/provider-cli/bin/codex login --device-auth
```

Replace `STATE` and `RUNTIME` with absolute paths. Complete the device login in
your own browser. The server never starts provider login automatically. This
implementation has been validated with Codex; it does not require Claude login.
See [official Codex authentication documentation](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).

## Two origins

The agent document must have a different origin from the privileged editor. For
example, use separate private Tailscale HTTPS ports, with no public Funnel:

```sh
lattice-server serve --workspace-root /srv/papers --state-dir /srv/lattice-state \
  --token-file /srv/private/lattice.token --listen 127.0.0.1:18482 \
  --assets /srv/lattice/dist --public-origin https://machine.example.ts.net:8443 \
  --agent-runtime /srv/lattice-runtime \
  --agent-listen 127.0.0.1:18583 \
  --agent-public-origin https://machine.example.ts.net:8444
```

Without an agent or an explicit `--public-origin`, existing reverse-proxy
deployments retain Host-derived origin checks (`https` with `--secure-cookies`,
otherwise `http`). Explicit origins always take precedence; agent deployments
use the exact configured origin and never this fallback.

The reverse proxy maps 8443 to 18482 and 8444 to 18583. Both origins must use the
same scheme and hostname, with different ports. The main listener never serves
agent documents, and the agent listener has no general invoke/file/terminal API.
The session cookie is HttpOnly; cookies can cross ports, so the main listener
also checks the exact configured Origin. No CORS permission is granted to the
agent origin. Sidecar and literature capability secrets remain in Rust and are
removed from HTTP/WS/CLI output, including JSON keys and binary messages.

A browser must first authenticate to the main server, open a project and call
`synara_ensure_ready` with its `X-Lattice-Client` identity. Only that authenticated
session/tab/project can use the returned agent route. Logout, tab lease expiry,
project change and explicit Stop revoke access. A stopped shared project process
is retained only while another authorized owner uses it. Dead shared processes
are replaced; shutdown kills descendants even if they change process groups.

## Workspace and containment

Linux Landlock ABI **6 or newer**, seccomp user notifications, pidfds and
`close_range` are required. Startup fails closed when unavailable; no Xvfb,
privileged container, user-namespace workaround or host security policy change
is used. The provider may access its dedicated provider home and network. This
is a trusted authenticated user's agent, not a multi-tenant hostile-code service.

The original project and system/runtime files are read-only. The server token,
other project state and account sessions are absent from the agent environment
and filesystem grants. New pathname/abstract Unix sockets, io_uring, host process
inspection, host signals, inode flag mutations and privilege/namespace syscalls
are restricted. Connected anonymous stream pairs remain available for Node child
stdio. Permission changes are emulated on validated private descriptors, never
continued against tracee-controlled pathnames. Server policy/logs/baseline
journals are outside the agent-writable home.

Each project receives a real byte-copy workspace, not hardlinks. Descriptor-
relative reads reject symlink swaps, FIFOs, non-regular files, more than 4096
entries, nesting beyond 64 and snapshots above 64 MiB. Ordinary text edits and
new files return only through **Apply checked changes**. Apply takes the same
canonical project mutation lock as the editor and closed literature broker;
concurrent original edits are reported as conflicts. Hidden/control files,
bibliographies, deletions and binary changes remain staged for review. Closed
literature tools are the only agent bibliography mutation route.

Staging is a durable snapshot, **not live bidirectional synchronization**. Git
writeback is unavailable. Host canvas, spreadsheet/Yjs, project-document creation,
annotation editing, history and save-visual postMessage tools are explicitly
refused in staged mode; read-only context/navigation and closed literature tools
remain available. This prevents an iframe tool from bypassing checked Apply.
Stopped snapshot directories are retained (maximum 32); review/remove old stopped
snapshots yourself. At most eight distinct projects and 128 tab owners run.

## CLI and verification

`lattice-server agent-bridge --runtime RUNTIME --project PROJECT --state-dir STATE
--path /ws` accepts newline-delimited Synara RPC JSON on stdin and emits
redacted RPC JSON on stdout. The default `--path /ws` supports normal feature RPCs: the bridge
negotiates the pinned protocol with its own child before connecting, including
the new child's instance identity. `/ws/bootstrap` remains available for raw
protocol inspection. EOF/Ctrl-C stops the owned process. Malformed
JSON, socket and stdio failures also clean up the owned child.

While the bridge remains open, user stdin can issue these reserved, closed host
records. They operate on that bridge's fixed project and owner; they are never
forwarded to the model:

```json
{"latticeHostCommand":"status","id":"check-1"}
{"latticeHostCommand":"apply","id":"apply-1"}
{"latticeHostCommand":"stop","id":"stop-1"}
```

Every host result is a single stdout record with `_tag: "LatticeHostResult"`, the
same `id`, an `ok` boolean and either `result` or `error: {code, message}`. IDs
must be 1–200 UTF-8 bytes. Only `id` and `latticeHostCommand` are accepted; unknown
operations and additional fields produce errors without changing the workspace.
`apply` uses the same checked text Apply and shared project mutation lock as the
web UI; no Git/binary/deletion synchronization or automatic Apply is added.
`stop` acknowledges, stops the child and exits. An identically shaped command received from the sidecar cannot execute a host
action. Sidecar records containing `latticeHostCommand` or the reserved
`_tag: "LatticeHostResult"` are wrapped as
`{"_tag":"LatticeAgentMessage","message":...}`; they cannot masquerade as a
trusted host acknowledgement. Ordinary Synara RPC frames keep their wire format.

A controller can hold the process open and explicitly approve writeback after its
normal Synara protocol/RPC flow completes, for example:

```python
process = subprocess.Popen(
    ["lattice-server", "agent-bridge", "--runtime", runtime,
     "--project", project, "--state-dir", state, "--path", "/ws"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
# Send normal Synara RPC records and collect the completed turn first.
def host_command(command, request_id):
    process.stdin.write(json.dumps({"latticeHostCommand": command, "id": request_id}) + "\n")
    process.stdin.flush()
    for line in process.stdout:
        record = json.loads(line)
        if record.get("_tag") == "LatticeHostResult" and record.get("id") == request_id:
            assert record["ok"], record["error"]
            return record["result"]
    raise RuntimeError("Bridge stopped before acknowledging the host command")
print(host_command("apply", "review-1"))  # applied and blocked/conflicting paths
host_command("stop", "done-1")
process.wait()
```

EOF never applies staged edits. A separate process's ordinary `invoke` command
cannot apply a live bridge's private owner session. Domain
commands use the ordinary `invoke` interface documented in `headless-server.md`;
capabilities enumerate available commands and remaining platform limitations.

```sh
cargo build --locked --manifest-path server/Cargo.toml
LATTICE_SERVER_BINARY=$PWD/server/target/debug/lattice-server \
  env -u DISPLAY -u WAYLAND_DISPLAY python3 server/tests/agent_smoke.py
```

The deterministic provider fixture exercises the production supervisor, sandbox,
authentication, broker, two listeners, HTTP and WebSocket relays, checked Apply,
symlink/FIFO/oversize/race refusal and descendant teardown. It does not assert a
real model call. A separate genuine pinned-runtime validation on Ubuntu without
DISPLAY verified readiness, proxy document/health and Codex model discovery using
the dedicated device-authenticated provider home. A complete synthetic turn using the
discovered `gpt-6.1-sol` model with `high` reasoning returned the assistant reply
`LATTICE_REMOTE_AI_READY` and a completed turn. The frontend hook test uses
real MessageEvents and real canvas/Yjs consumers to verify host-write refusal.
The real-runtime CLI validation also exercised automatic feature negotiation,
`provider.listModels` from the genuine Codex app-server, a correlated status
result, and an acknowledged stop/clean exit. The deterministic CLI consumer
checks explicit text Apply, blocked model-forged commands/acknowledgements,
unsupported controls, malformed input and EOF cleanup.

To verify browser resource routing against the prepared pinned runtime's actual
Vite preloader, install the repository's development dependencies and run:

```sh
node --experimental-vm-modules server/tests/browser_assets.mjs
# Optionally compare against a freshly prepared runtime:
node --experimental-vm-modules server/tests/browser_assets.mjs PREPARED_RUNTIME
```

CI uses the existing Node 22 / pnpm 10 frozen-install action and the test-only,
SHA-verified preloader fixture (source/version/license in
`server/tests/fixtures/vite-preload`). No private machine artifact is required.
The optional runtime argument must match the same pinned helper hash.

This executes the real preloader with the proxy bootstrap and DOM property
setters. It verifies that stylesheet loading allows the main import to run,
direct script/worker URLs stay within the authenticated route, and worker
options plus blob/external/already-scoped URLs are preserved. The HTTP check
must also confirm that root `/assets/...` requests return 404 and authenticated
`/api/agent/CLIENT/assets/...` requests return 200. Do not add an unauthenticated
root asset fallback to conceal a browser routing failure.
