# Private Linux deployment

Build the standalone `server/` crate on Linux and the frontend with the pinned
Node/pnpm versions described in the contributor documentation. Transfer the
`lattice-server` executable, `dist/`, and `scripts/install-headless-service.py`
to the server. This installer uses a systemd **user** service and never needs
Docker or a graphical session. Install LaTeX tools in a user directory or use
the server's existing TeX installation.

For a server already enrolled in a tailnet:

```sh
python3 scripts/install-headless-service.py \
  --binary ./lattice-server --assets ./dist \
  --workspace-root "$HOME/lattice-workspaces" \
  --project "$HOME/lattice-workspaces/example" \
  --extra-path "$HOME/.TinyTeX/bin/x86_64-linux" \
  --port 18482 --https-port 8443 --tailscale
```

The workspace and initial project must already exist. Omit `--extra-path` when
the tools are in the standard system path. `--dry-run` validates inputs and
prints the exact systemd unit before changing anything. `--data-dir` selects an
isolated installation directory. Existing unrelated user services and occupied
Tailscale HTTPS ports are refused.

The server listens only on `127.0.0.1`. Tailscale Serve provides private HTTPS;
this does not enable Funnel or expose a public site. Connect a phone/computer
to the authorized tailnet, open the private address printed by Serve, and sign
in with the token in the private `access-token` file. Retrieve that file through
your own SSH terminal; do not put the token in URLs, issue reports or logs. The
API uses a separate HttpOnly SameSite session cookie after login. HTTPS mode
enforces Secure cookies, so use the private HTTPS URL in the browser.

## Optional supervised agent

With the Linux agent supervisor available, prepare its pinned runtime and
authenticate the dedicated provider home under `DATA_DIR/state/agent-provider`.
Keep the runtime outside the project workspace. Add these options to the install
command (using the node's actual Tailscale DNS name):

```sh
  --agent-runtime /srv/lattice/runtimes/agent-version \
  --public-origin https://node.tail.example:8443 \
  --agent-public-origin https://node.tail.example:8444 \
  --agent-port 18583 --agent-https-port 8444
```

The agent uses a second private HTTPS origin, with the same hostname and a
different port. Its loopback listener serves only the agent proxy; it cannot
invoke the workspace API. The installer validates both Serve handlers before
changing the running release, and creates the agent handler even when the
workspace handler already exists. It preserves unrelated handlers on both
ports. Runtime and origin flags remain in the user unit across logout/restart;
provider state remains outside versioned release directories.

When updating an agent-enabled installation, supply its runtime/origin options
again. The installer refuses an accidental downgrade; `--disable-agent` explicitly
removes that configuration. The agent uses isolated staging and checked Apply,
with its supported operations listed in capabilities. Enabling the runtime
does not grant Git, binary-file or live bidirectional writeback.

If the SSH user lacks operator permission, an administrator must run
`sudo tailscale set --operator=USERNAME`. Tailnet policy may also require the
owner to enable Serve/HTTPS. The installer reports that failure after installing
the local service, without changing policy or replacing existing handlers.

For operation after logout and reboot, an administrator must enable lingering:
`sudo loginctl enable-linger USERNAME`. The installer checks this and reports an
incomplete deployment if it is disabled. A healthy process during an SSH session
alone does not prove persistence.

Inspect and manage the service:

```sh
systemctl --user status lattice-headless.service
journalctl --user -u lattice-headless.service
systemctl --user restart lattice-headless.service
tailscale serve status
```

To remove it, disable the user unit and remove only its marked unit file. Remove
only the Serve handler on the port dedicated to this service; do not reset the
machine's entire Serve configuration. Project files and state remain in their
separate directories. Re-running an update with an already configured Serve
port is safe when that port already proxies exactly this service; other handlers
are refused. Updates preserve Secure cookies from the existing marked unit.

The frontend and server capability lists define the supported functions.
Native-only windows remain unavailable in the browser.
