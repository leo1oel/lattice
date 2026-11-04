#!/usr/bin/env python3
"""Install an isolated Linux user service and optionally a private Tailscale Serve handler."""

import argparse
import getpass
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.parse

MARKER = "# Managed by Lattice headless installer"


def run(*args, check=True):
    result = subprocess.run(args, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(
            result.stderr.strip() or result.stdout.strip() or f"{args[0]} failed"
        )
    return result


def unit_arg(value):
    # ExecStart is systemd syntax, not a shell. Percent specifiers and quotes
    # must be escaped independently; never interpolate a path into shell code.
    return (
        '"'
        + str(value).replace("%", "%%").replace("\\", "\\\\").replace('"', '\\"')
        + '"'
    )


def serve_port_state(status, https_port, target):
    if str(https_port) not in status.get("TCP", {}):
        return "free"
    handlers = [
        value.get("Handlers", {})
        for name, value in status.get("Web", {}).items()
        if name.endswith(f":{https_port}")
    ]
    if len(handlers) == 1 and handlers[0] == {"/": {"Proxy": target}}:
        return "ours"
    raise RuntimeError(
        f"Tailscale Serve port {https_port} already has an unrelated handler; choose another port."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--workspace-root", type=Path, required=True)
    parser.add_argument("--project", type=Path)
    parser.add_argument(
        "--data-dir", type=Path, default=Path.home() / ".local/share/lattice-headless"
    )
    parser.add_argument("--port", type=int, default=18482)
    parser.add_argument("--https-port", type=int, default=8443)
    parser.add_argument(
        "--tailscale",
        action="store_true",
        help="Add a private HTTPS handler; never enable Funnel",
    )
    parser.add_argument(
        "--agent-runtime",
        type=Path,
        help="Prepared Linux agent runtime; provider login stays in the persistent state directory",
    )
    parser.add_argument("--agent-port", type=int, default=18583)
    parser.add_argument("--agent-https-port", type=int, default=8444)
    parser.add_argument(
        "--public-origin",
        help="Browser origin of the main workspace, including its HTTPS port",
    )
    parser.add_argument(
        "--agent-public-origin",
        help="Isolated agent origin: same hostname and scheme, different port",
    )
    parser.add_argument(
        "--disable-agent",
        action="store_true",
        help="Explicitly remove an existing agent configuration",
    )
    parser.add_argument(
        "--extra-path",
        default="",
        help="Absolute user tool directories, separated by ':' (for TeX)",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if platform.system() != "Linux" and not args.dry_run:
        parser.error("The user service installer runs on Linux.")
    if any(
        not 1024 <= port <= 65535
        for port in (args.port, args.https_port, args.agent_port, args.agent_https_port)
    ):
        parser.error("Use unprivileged ports in 1024..65535.")
    if args.disable_agent and args.agent_runtime:
        parser.error("Choose either --agent-runtime or --disable-agent.")
    binary, assets, workspace = (
        p.expanduser().resolve(strict=True)
        for p in (args.binary, args.assets, args.workspace_root)
    )
    if (
        not binary.is_file()
        or not os.access(binary, os.X_OK)
        or not (assets / "index.html").is_file()
        or not workspace.is_dir()
    ):
        parser.error(
            "Provide an executable server, built frontend assets, and a workspace directory."
        )
    data = args.data_dir.expanduser().resolve()
    project = (
        args.project.expanduser().resolve(strict=True) if args.project else workspace
    )
    if not project.is_relative_to(workspace):
        parser.error("The initial project must be inside the workspace root.")
    for path in [binary, assets, workspace, project, data]:
        if any(character in str(path) for character in "\n\r\x00"):
            parser.error("Paths cannot contain control characters.")
    extra_paths = args.extra_path.split(":") if args.extra_path else []
    if any(
        not Path(path).is_absolute() or any(c in path for c in '\n\r"%')
        for path in extra_paths
    ):
        parser.error(
            "Extra tool directories must be absolute paths without quotes, newlines or '%'."
        )
    tool_path = ":".join(
        extra_paths
        + [str(Path.home() / ".local/bin"), "/usr/local/bin", "/usr/bin", "/bin"]
    )
    command = [
        data / "current/lattice-server",
        "serve",
        "--workspace-root",
        workspace,
        "--project",
        project,
        "--state-dir",
        data / "state",
        "--token-file",
        data / "access-token",
        "--listen",
        f"127.0.0.1:{args.port}",
        "--assets",
        data / "current/assets",
    ]
    config = (
        Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
        / "systemd/user/lattice-headless.service"
    )
    previous = config.read_text() if config.exists() else ""
    secure = args.tailscale or "--secure-cookies" in previous
    if previous and MARKER not in previous:
        raise RuntimeError(f"Refusing to replace an unrelated service at {config}")
    if (
        '"--agent-runtime"' in previous
        and not args.agent_runtime
        and not args.disable_agent
    ):
        parser.error(
            "Preserve the existing agent runtime/origin arguments, or explicitly use --disable-agent."
        )
    for value in (args.public_origin, args.agent_public_origin):
        if value is None:
            continue
        origin = urllib.parse.urlsplit(value)
        if any(c in value for c in "\n\r\x00") or (
            origin.scheme not in ("http", "https")
            or not origin.hostname
            or origin.username
            or origin.password
            or origin.path not in ("", "/")
            or origin.query
            or origin.fragment
        ):
            parser.error(
                "Use plain HTTP(S) browser origins without credentials, paths, queries or fragments."
            )
    if args.agent_runtime:
        agent_runtime = args.agent_runtime.expanduser().resolve(strict=True)
        if not agent_runtime.is_dir() or any(
            c in str(agent_runtime) for c in "\n\r\x00"
        ):
            parser.error("Provide a prepared agent runtime directory.")
        if not args.public_origin or not args.agent_public_origin:
            parser.error(
                "Agent deployments require --public-origin and --agent-public-origin."
            )
        origins = [
            urllib.parse.urlsplit(value)
            for value in (args.public_origin, args.agent_public_origin)
        ]
        main_origin, agent_origin = origins
        if secure and main_origin.scheme != "https":
            parser.error("An HTTPS service needs HTTPS workspace and agent origins.")
        if (main_origin.scheme, main_origin.hostname) != (
            agent_origin.scheme,
            agent_origin.hostname,
        ) or main_origin.port == agent_origin.port:
            parser.error(
                "The agent origin must use the same hostname and scheme on a different port."
            )
        if args.port == args.agent_port:
            parser.error("The agent listener needs its own loopback port.")
        if args.tailscale and (
            main_origin.scheme != "https"
            or main_origin.port != args.https_port
            or agent_origin.port != args.agent_https_port
            or args.https_port == args.agent_https_port
        ):
            parser.error(
                "Tailscale agent origins must match the two distinct HTTPS handler ports."
            )
        command.extend(
            [
                "--agent-runtime",
                agent_runtime,
                "--agent-listen",
                f"127.0.0.1:{args.agent_port}",
                "--agent-public-origin",
                args.agent_public_origin.rstrip("/"),
            ]
        )
    elif args.agent_public_origin:
        parser.error("--agent-public-origin requires --agent-runtime.")
    if args.public_origin:
        command.extend(["--public-origin", args.public_origin.rstrip("/")])
    # An update without --tailscale must not downgrade an existing HTTPS session.
    if secure:
        command.append("--secure-cookies")
    unit = "\n".join(
        [
            MARKER,
            "[Unit]",
            "Description=Lattice private headless workspace",
            "After=network.target",
            "",
            "[Service]",
            "Type=simple",
            "UMask=0077",
            f'Environment="PATH={tool_path}"',
            "ExecStart=" + " ".join(unit_arg(part) for part in command),
            "Restart=on-failure",
            "RestartSec=3",
            "NoNewPrivileges=true",
            "PrivateTmp=true",
            "",
            "[Install]",
            "WantedBy=default.target",
            "",
        ]
    )
    if args.dry_run:
        print(unit)
        return
    handlers = [(args.https_port, f"http://127.0.0.1:{args.port}")]
    if args.agent_runtime:
        handlers.append((args.agent_https_port, f"http://127.0.0.1:{args.agent_port}"))
    # Validate every handler before switching the running release. An existing
    # workspace handler must not skip setup of the isolated agent origin.
    port_states = []
    if args.tailscale:
        current = run("tailscale", "serve", "status", "--json")
        status = json.loads(current.stdout or "{}")
        port_states = [
            (port, target, serve_port_state(status, port, target))
            for port, target in handlers
        ]
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    data.chmod(0o700)
    release = data / "releases" / str(time.time_ns())
    release.mkdir(parents=True, mode=0o700)
    shutil.copy2(binary, release / "lattice-server")
    shutil.copytree(assets, release / "assets")
    pending = data / "current.next"
    pending.unlink(missing_ok=True)
    pending.symlink_to(release, target_is_directory=True)
    pending.replace(data / "current")
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(unit)
    run("systemctl", "--user", "daemon-reload")
    run("systemctl", "--user", "enable", "--now", "lattice-headless.service")
    run("systemctl", "--user", "restart", "lattice-headless.service")
    for attempt in range(30):
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{args.port}/api/session", timeout=2
            ) as response:
                if json.load(response).get("headless") is True:
                    break
        except (OSError, ValueError):
            pass
        time.sleep(0.2)
    else:
        raise RuntimeError(
            "The service did not become healthy; inspect journalctl --user -u lattice-headless.service"
        )
    print(
        f"Service healthy on loopback port {args.port}. Access token file: {data / 'access-token'} (contents not displayed)."
    )
    linger = run(
        "loginctl",
        "show-user",
        getpass.getuser(),
        "-p",
        "Linger",
        "--value",
        check=False,
    ).stdout.strip()
    if linger != "yes":
        print(
            f"Persistent startup needs an administrator: sudo loginctl enable-linger {getpass.getuser()}",
            file=sys.stderr,
        )
    if args.tailscale:
        for port, target, port_state in port_states:
            if port_state == "ours":
                print(
                    f"Existing private Serve handler on {port} already points to this service."
                )
                continue
            served = run(
                "tailscale", "serve", "--bg", f"--https={port}", target, check=False
            )
            if served.returncode:
                print(served.stderr.strip() or served.stdout.strip(), file=sys.stderr)
                raise RuntimeError(
                    f"Service installed; Tailscale needs operator permission or Serve approval. An administrator can run: sudo tailscale set --operator={getpass.getuser()}"
                )
            print(served.stdout.strip())
    if linger != "yes":
        raise RuntimeError(
            "Service is running, but boot/logout persistence is not configured yet."
        )


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        print(f"lattice deployment: {error}", file=sys.stderr)
        sys.exit(1)
