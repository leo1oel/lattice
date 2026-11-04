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

The frontend and server capability lists define the supported functions. This
deployment path does not turn native-only windows or unavailable AI runtimes
into headless capabilities.
