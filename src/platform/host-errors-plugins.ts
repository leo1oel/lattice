/**
 * Plugin host errors (lattice-core's plugins module) a writer reads: an
 * install or a manifest that failed in Settings › Plugins, a secret that
 * could not be saved, and the detail of a run that could not start or
 * answered badly. See `host-error-text.ts` for how an entry is matched and
 * pinned.
 */
import { t } from "@lingui/core/macro";
import type { HostErrorEntry } from "./host-error-text";

/* eslint-disable lingui/no-unlocalized-strings -- the host's English is matched as data; each translation is the t`` beside it */

export const PLUGINS_HOST_ERRORS: readonly HostErrorEntry[] = [
  // Settings › Plugins: secrets (plugins.rs, plugins/broker.rs)
  ["plugins.rs", "This plugin does not declare that secret.", () => t`This plugin does not declare that secret.`],
  ["plugins/broker.rs", "Cannot read the plugin's secret: {e}", ([error]) => t`Cannot read the plugin's secret: ${error}`],
  ["plugins/broker.rs", "Cannot remove the secret: {e}", ([error]) => t`Cannot remove the secret: ${error}`],

  // A manifest that cannot load (plugins/manifest.rs): an install's error, or a card's
  ["plugins/manifest.rs", "This plugin's manifest format ({}) needs a newer Lattice.", ([format]) => t`This plugin's manifest format (${format}) needs a newer Lattice.`],
  ["plugins/manifest.rs", "This plugin needs plugin API level {}; this Lattice has {API_LEVEL}.", ([needed, level]) => t`This plugin needs plugin API level ${needed}; this Lattice has ${level}.`],
  ["plugins/manifest.rs", "The plugin id must be reverse-domain, like dev.example.my-plugin.", () => t`The plugin id must be reverse-domain, like dev.example.my-plugin.`],
  ["plugins/manifest.rs", "A node plugin needs `main`.", () => t`A node plugin needs \`main\`.`],
  ["plugins/manifest.rs", "An exec plugin needs `[targets]`.", () => t`An exec plugin needs \`[targets]\`.`],
  ["plugins/manifest.rs", "A plugin declares between 1 and 32 commands.", () => t`A plugin declares between 1 and 32 commands.`],
  ["plugins/manifest.rs", "Invalid or repeated command id `{}`.", ([id]) => t`Invalid or repeated command id \`${id}\`.`],
  ["plugins/manifest.rs", "Unknown `project-read` value `{other}`.", ([value]) => t`Unknown \`project-read\` value \`${value}\`.`],

  // Installing (plugins/store.rs)
  ["plugins/store.rs", "Cannot read the plugin registry: {e}", ([error]) => t`Cannot read the plugin registry: ${error}`],
  ["plugins/store.rs", "A plugin with the id {} is already installed. Remove it first.", ([id]) => t`A plugin with the id ${id} is already installed. Remove it first.`],
  ["plugins/store.rs", "The SHA-256 must be 64 hexadecimal characters.", () => t`The SHA-256 must be 64 hexadecimal characters.`],
  ["plugins/store.rs", "The download's SHA-256 is {actual}, not the one given. Nothing was installed.", ([actual]) => t`The download's SHA-256 is ${actual}, not the one given. Nothing was installed.`],
  ["plugins/store.rs", "The plugin's licence ({}) is not one Lattice accepts for installed plugins.", ([license]) => t`The plugin's licence (${license}) is not one Lattice accepts for installed plugins.`],
  ["plugins/store.rs", "The plugin's id changed. Remove it and install it again.", () => t`The plugin's id changed. Remove it and install it again.`],
  ["plugins/store.rs", "Plugins install only over https.", () => t`Plugins install only over https.`],
  ["plugins/store.rs", "The download failed: HTTP {}.", ([status]) => t`The download failed: HTTP ${status}.`],
  ["plugins/store.rs", "The plugin archive is larger than 50 MiB.", () => t`The plugin archive is larger than 50 MiB.`],
  ["plugins/store.rs", "The plugin archive has too many files.", () => t`The plugin archive has too many files.`],
  ["plugins/store.rs", "The archive holds a link ({name}); plugins may not.", ([name]) => t`The archive holds a link (${name}); plugins may not.`],
  ["plugins/store.rs", "The plugin archive unpacks to more than 200 MiB.", () => t`The plugin archive unpacks to more than 200 MiB.`],
  ["plugins/store.rs", "The archive has no {} at its root.", ([file]) => t`The archive has no ${file} at its root.`],

  // A run's detail (plugins/results.rs, plugins/sandbox.rs), inside the palette's error line
  ["plugins/results.rs", "The plugin's result has no kind.", () => t`The plugin's result has no kind.`],
  ["plugins/sandbox.rs", "Unsupported path {}", ([path]) => t`Unsupported path ${path}`],
];
