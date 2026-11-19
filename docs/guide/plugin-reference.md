# Plugin manifest and API

This page lists what a plugin can declare, ask for, call and return, with the rules the plugin market adds. The complete protocol, with every field and error code, is [docs/plugins.md](https://github.com/leo1oel/lattice/blob/main/docs/plugins.md); the schema it is generated from is [plugin-api/schema/level-1.json](https://github.com/leo1oel/lattice/blob/main/plugin-api/schema/level-1.json).

## The manifest

`lattice-plugin.toml` sits at the root of the plugin folder.

| Key | Required | What it is |
|---|---|---|
| `schema` | yes | The manifest format: `1`. |
| `id` | yes | Reverse-domain, lower case, unique, never changed. `app.lattice.*` is reserved. |
| `name` | yes | Shown in Settings and before each command in the palette. At most 80 characters. |
| `version` | yes | The plugin's own version, semver (`1.2.3`). |
| `api` | yes | The lowest plugin API level it needs: `1`. |
| `license` | yes | An SPDX id. The market and URL installs accept 0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause, BSL-1.0, GPL-3.0(-only/-or-later), ISC, LGPL-3.0(-only/-or-later), MIT, MPL-2.0, Unlicense and Zlib. |
| `description` | for the market | One or two sentences, at most 500 characters. |
| `repository` | no | An https link to the source. |
| `runtime` | yes | `"node"`, run with the Node Lattice ships (Node 24). `"exec"` runs a native executable per target triple (`[targets]`), but the market lists `node` plugins only. |
| `main` | for `node` | The entry script, relative to the folder. |
| `[permissions]` | no | What the plugin may reach; see below. |
| `[[commands]]` | yes | One to 32 commands. |

Each command has an `id` (lower-case letters, digits and dashes), a `title` (at most 80 characters), an optional `description`, and an optional `input`: `{ kind = "none" }` (the default) runs at once, `{ kind = "text", placeholder = "…" }` asks the writer to type first.

Unknown top-level keys are ignored, so a manifest written for a newer Lattice still loads. An unknown key under `[permissions]` is an error: it asks for something this Lattice can't enforce.

## Permissions

A plugin reaches only what its manifest declares and the writer allowed when turning it on. Lattice enforces this with a macOS sandbox and by checking every host call; it isn't a promise the plugin makes.

| Permission | What it allows | What the writer is asked to allow |
|---|---|---|
| `project-read = ["context"]` | Main document, active file, bibliography paths, selection (at most 12,000 characters) and cursor, in every run's `context` | Read the open file, selection and cursor |
| `project-read = ["bibliography"]` | Parsed `.bib` entries through `host.bibliographyEntries()` | Read the project’s bibliography |
| `network-local = [23119]` | Direct connections to those ports on this Mac only (at most 8) | Connect to localhost:23119 |
| `network = ["https://api.crossref.org"]` | Requests to those https origins through `host.fetch()` (at most 16, no paths) | Send requests to https://api.crossref.org |
| `secrets = ["api-key"]` | Values the writer saves in the plugin's card, kept in the Keychain, read with `host.secret()` (at most 8 names) | Use the saved secret “api-key” |

A plugin with none of these shows “No access beyond the project’s name”. It can still read its own folder, read and write its data folder (`LATTICE_PLUGIN_DATA_DIR`), and learn the project's name. It never gets the writer's environment, API keys or other files, and it can't read project files beyond the above.

Ask for the least that does the job. A plugin that asks for more in an update stops until the writer allows it again (see [Publishing a plugin](plugin-publishing.md#updates-and-permission-changes)), and the market review asks why each permission is needed.

## A run

Each command runs in a new process:

1. Lattice sends `initialize`; the SDK answers with the API level.
2. Lattice sends `command/run` with the command id, the `input` and the `context`.
3. The handler may call the host and send logs and progress.
4. The handler returns; Lattice closes stdin and stops the process.

So nothing survives between runs except what the plugin writes to its data folder. A run that passes 120 seconds is stopped. When the writer cancels, or time runs out, the handler's `signal` aborts: pass it to anything long-running.

The process gets `PATH=/usr/bin:/bin`, `HOME` and `TMPDIR` inside the data folder, `LANG`, `LATTICE_PLUGIN_ID`, `LATTICE_PLUGIN_API_LEVEL` and `LATTICE_PLUGIN_DATA_DIR`.

## Calling Lattice

A handler's `host` has these methods:

| Method | Needs | Returns |
|---|---|---|
| `host.bibliographyEntries(file?)` | `project-read = ["bibliography"]` | `{ files: [{ path, entries: [{ key, type, fields, line }], error? }] }`, field names in lower case |
| `host.fetch(url or { url, method?, headers?, body? })` | the URL's origin in `network` | `{ status, headers, body }`; bodies up to 4 MiB, 30 seconds |
| `host.secret(name)` | the name in `secrets` | the saved value, or `null` |
| `host.log(level, message)` | nothing | writes to Lattice's log; `level` is `error`, `warn`, `info` or `debug` |
| `host.progress(message, fraction?)` | nothing | shows `message` in the palette while the command runs |

A call without its permission rejects with `HostError`, `code` -32001. For example, with `network = ["https://api.crossref.org"]`:

```js
const response = await host.fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
if (response.status !== 200) throw new PluginError(`Crossref answered ${response.status}.`);
const work = JSON.parse(response.body).message;
```

## Results

Return one of three kinds. Each may carry a `summary`, plain text that stands for the whole result in logs and notifications.

- **A message:** `{ kind: "message", markdown }`. CommonMark without raw HTML.
- **A list:** `{ kind: "items", items: [{ id, title, subtitle?, detail?, badges?, actions? }] }`. The writer picks an item; its first action runs on Return.
- **Problems:** `{ kind: "diagnostics", items: [{ id, file, line?, severity, code?, message, fixes? }] }`. `severity` is `error`, `warning` or `info`; `code` is a stable rule name such as `duplicate-key`; `fixes` are actions.

To show an error instead, throw `new PluginError("What went wrong and what to do.")`.

## Actions

A plugin never edits anything itself. It attaches actions, and Lattice performs them, asking the writer first for every change to a file:

| `type` | Arguments | What Lattice does |
|---|---|---|
| `insertCitation` | `key` | Inserts `\cite{key}` at the cursor |
| `addBibEntry` | `bibtex`, `file?` | Shows the entry and adds it to the bibliography after the writer confirms |
| `replaceBibEntry` | `key`, `bibtex`, `file?` | Shows the change and replaces the entry after the writer confirms |
| `reveal` | `file`, `line?` | Opens the project file at the line |
| `openUrl` | `url` (http or https) | Opens it in the browser |
| `copy` | `text` | Copies it |

Each action also takes an optional `title`. Lattice checks every action before showing it: paths must stay inside the project, URLs must be http or https, and BibTeX must be exactly one valid entry. Anything else is dropped.

## Compatibility

Plugin API levels only add things: new methods, optional fields, result kinds and action types. A plugin that declares `api = 1` keeps working on every later Lattice until level 1 is retired, which is announced at least two minor releases ahead in [docs/plugins.md](https://github.com/leo1oel/lattice/blob/main/docs/plugins.md#deprecation-register). Read only the fields you know, since results and contexts may gain fields.
