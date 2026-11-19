# @lattice-app/plugin-api

Types and a one-file runtime for writing [Lattice](https://github.com/leo1oel/lattice)
plugins. MIT licensed. The contract is [`docs/plugins.md`](../docs/plugins.md).
It is not on npm yet; copy the files from here. For a step-by-step walkthrough, from
a hello-world plugin to the plugin market, read
[Developing plugins](../docs/guide/plugin-development.md) in the user guide.

- `lattice-plugin.mjs`: the JSON-RPC loop over stdio. No dependencies; copy it
  into your plugin folder (a sandboxed plugin can read only its own folder).
- `index.d.ts` + `api.d.ts`: TypeScript types. `api.d.ts` is generated from
  [`plugin-api/schema/level-1.json`](../plugin-api/schema/level-1.json) by
  `scripts/gen-types.mjs`.

## A plugin in two files

`lattice-plugin.toml`:

```toml
schema = 1
id = "dev.example.word-count"
name = "Word count"
version = "0.1.0"
api = 1
license = "MIT"
runtime = "node"
main = "main.mjs"

[permissions]
project-read = ["context"]

[[commands]]
id = "count"
title = "Count words in the selection"
```

`main.mjs`:

```js
import { definePlugin, PluginError } from "./lattice-plugin.mjs";

definePlugin({
  commands: {
    async count({ context }) {
      const text = context.selection?.text;
      if (!text) throw new PluginError("Select some text first.");
      const words = text.split(/\s+/).filter(Boolean).length;
      return { kind: "message", summary: `${words} words`, markdown: `**${words}** words selected.` };
    },
  },
});
```

Then Settings › Plugins › Install from folder…, turn it on, and run "Word count:
Count words in the selection" from the command palette (⌘K).

A handler gets `{ input, context, host, signal }`:

- `host.bibliographyEntries(file?)`, `host.fetch(urlOrRequest)`,
  `host.secret(name)`: host calls, each needing its permission; a refusal
  rejects with `HostError` (`code` -32001).
- `host.progress(message, fraction?)`, `host.log(level, message)`.
- `signal` aborts when the writer cancels or the run times out (120 s).

Return a `message`, `items` or `diagnostics` result; throw `PluginError` to
show the writer an error. `console.log` goes to stderr, because stdout carries
the protocol.

## Examples

- [`examples/plugins/zotero-search`](../examples/plugins/zotero-search): search
  the Zotero on this Mac (Better BibTeX's JSON-RPC, or Zotero 7's local API) and
  cite or add the result. Uses `network-local = [23119]` and
  `project-read = ["bibliography"]`.
- [`examples/plugins/bib-check`](../examples/plugins/bib-check): diagnostics for
  the project's `.bib` files (duplicate keys and DOIs, missing required fields,
  malformed years) with "Show" and a confirmed "Normalize DOI" fix. Uses only
  `project-read = ["bibliography"]`.

Both are templates: copy one, change the id, and keep its copy of
`lattice-plugin.mjs` current (`node plugin-sdk/scripts/sync-examples.mjs` does
it for the examples here).

## Publishing

Pack the folder and publish the zip and its hash, for Settings › Plugins ›
Install from URL:

```sh
node plugin-sdk/scripts/pack-plugin.mjs path/to/plugin dist/my-plugin-0.1.0.zip
# prints the zip's path and its sha256
```

The pack leaves out tests (`*.test.mjs`) and dot files, and is reproducible:
the same files give the same bytes on any machine. Attach the zip to a GitHub
release and put the SHA-256 beside its link.

To list a plugin in Settings › Plugins › Browse, add an entry to
[lattice-writer/lattice-plugins](https://github.com/lattice-writer/lattice-plugins) that
pins a tag of its source and this sha256. The registry packs the tagged folder
the same way and publishes the zip only when the hashes match. Name every
`network` origin and `network-local` port in the plugin's README, with the
reason; the review asks for it.
