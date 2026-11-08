# Local command plugins (API 1)

Lattice can link a local folder containing `lattice-plugin.json` from Settings → Integrations → Plugins. Linking does not copy its files. A plugin starts disabled and runs only when the user explicitly chooses a command. Disabling or removing a plugin does not delete the source folder. This first API is desktop-only; the browser-hosted workspace, plugin UI contributions, automatic hooks, marketplace, sandbox and project-edit API are not implemented.

**Trust:** a plugin is an ordinary program running with the user's OS account and inherited environment, including any environment credentials. It can read or modify files and use the network independently of Lattice; a separate process is not a sandbox. The UI asks for confirmation before installation and enabling, but users should inspect and install only trusted code. A linked directory can change after installation. Lattice refuses a changed manifest until the plugin is disabled and explicitly re-enabled; this does not detect changes to code or dependencies.

## Example

Try the checked-in [`examples/plugins/hello`](../examples/plugins/hello) folder. It has an executable script and the manifest:

```json
{
  "id": "example.hello",
  "name": "Hello from a plugin",
  "version": "1.0.0",
  "api_version": 1,
  "commands": [{ "id": "hello", "title": "Show plugin context", "executable": "hello.sh", "args": [] }]
}
```

IDs use lowercase ASCII letters, digits, `.`, `_` and `-`, starting with a letter or digit. Command IDs are unique within a plugin. Executables must be relative files inside the linked folder; symlinks resolving outside it are rejected. Arguments are literal strings, not shell fragments. Scripts need a valid shebang and executable permission.

When a command runs, Lattice starts its executable in the plugin folder and writes a JSON line on stdin: `{"apiVersion":1,"command":"hello","projectRoot":null}`. `projectRoot` names the invoking window's project if one is open. `LATTICE_PLUGIN_ID`, `LATTICE_COMMAND_ID`, `LATTICE_PLUGIN_API_VERSION`, and (when present) `LATTICE_PROJECT_ROOT` are also provided. Stdout and stderr appear in Settings, each truncated to 64 KiB. A command that has not exited after 20 seconds is terminated; this is a convenience timeout, not a resource or process-tree sandbox. Commands are not automatically restarted. Plugin output and project paths may be sensitive; the user controls the source and invocation.

## Repository and compatibility

Keep each plugin in its own Git repository (or a monorepo with a manifest per folder), version its releases and document dependencies, supported OSes, configuration, permissions and support contact. This API uses `api_version: 1`; a future incompatible host API needs a new version and the host must reject unknown versions rather than silently changing behavior. Plugin `version` is informational in API 1; the user updates a linked checkout themselves and reviews changes. The host neither verifies publishers nor fetches, pins, updates, signs or audits repositories. A future registry can index repository URLs and immutable versions; discovery is not endorsement. Keep plugin state and secrets outside the plugin checkout, and never put credentials in the manifest.
