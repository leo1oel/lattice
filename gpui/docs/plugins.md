# Plugins

One of the features [the GPUI app](../README.md) has so far.

Runs the plugins lattice-core's plugin host installs (`src-tauri/lattice-core/src/plugins.rs`, the contract in [docs/plugins.md](../../docs/plugins.md)), as the Tauri app does over IPC (`src/plugins/`).
The host owns installing, permissions, the sandbox and the protocol; this app lists the commands, runs one off the main thread, shows what it returns and performs its actions through the app's own paths (`plugins.rs`, `plugins/`, `shell/palette/plugin.rs`, `shell/plugin_actions.rs`, `settings/plugins_pane.rs`).

## The palette

An enabled plugin's commands are palette rows titled `<Plugin>: <Command>` with a puzzle icon and the command's description, listed under Plugins after every built-in section when the palette opens empty, and found by a query like any other row.
A command that asks for text turns the search row into its field, the plugin's name in a chip before it and the manifest's placeholder inside (↩ runs, ⎋ goes back).
While it runs the palette shows one row, a spinner and the plugin's latest progress (or Running <Command>…); ⎋ cancels the run and closes the palette, and so does closing it any other way.
Its result replaces the list under a header line (`<Plugin> · <summary>`):

- items in the plugin's order, each with its subtitle and detail; ↩ runs the first action and the row in front or under the pointer shows its other actions as small buttons;
- diagnostics grouped by file, the files in the order they first appear, each with its severity, line and code; ↩ opens the file at the line; ↑↓ skip the file headers;
- a message's Markdown (CommonMark: headings, lists, quotes, code, emphasis and links) in a scrolling block, raw HTML shown as text and only http(s) links opened;
- an error, in the interface language by its code (the plugin's own words for its own error), with Open Settings when Settings › Plugins can fix it.

## Actions

Each action's button is the plugin's title, else Lattice's word for the verb (Insert citation, Add to bibliography, Update entry, Open, Open in browser, Copy), the same words as the Tauri app's (`src/plugins/plugin-text.ts`).
Insert citation puts the key in at the caret of the LaTeX source in front, joining the `\cite` the caret is in or adding `\cite{key}`.
Add to bibliography and Update entry ask first, showing the entry or the lines that change, and write only once the writer confirms, through the project's history like every citation edit; the write is checked against the text the question was worked out from.
Open opens the file at its line, Open in browser opens an http(s) link, and Copy puts the text on the clipboard and closes the palette.

## Settings › Plugins

Under Integrations after Literature services (the tab id `plugins`, with the package icon, as in the Tauri app), and found by Settings search.
Install from URL… takes a release `.zip` link and its SHA-256; Install from folder… runs a plugin from its folder, for developing one.
Each plugin has a card: its name, version, id, description, licence and source, a switch, what it may access in plain words, a field per secret it declares (kept in the Keychain), and Remove, which asks first.
Turning a plugin on asks first, listing its permissions; so does a plugin that asks for more since it was turned on.
Off macOS plugins are listed but cannot be turned on.

Plugins run on the Node the app bundles (`synara-runtime/bin/node`); a development build without it uses `LATTICE_PLUGIN_NODE`, else `node` on `PATH`, else Homebrew's.

## Differences from the Tauri app

The Tauri app asks about a bibliography change inside the palette, with Now and After columns; this app asks in its confirmation dialog, which draws above the palette and Settings.

## In the e2e scenario

The `plugins` module (`scenario/e2e/plugins.rs`), with a fixture plugin written into the scratch home and secrets held in memory, never the Keychain: installed from its folder and listed off; turning it on asks with its permissions; its commands in the palette, last under Plugins, and found by a query; a command that asks for text, its progress and its items; an item's Copy button closing the palette; diagnostics grouped by file and ↩ opening one at its line; a message's Markdown; the plugin's own error inline; and Add to bibliography asking with the entry and writing it only once confirmed.
`LATTICE_E2E_SHOTS` saves each state as a screenshot.
