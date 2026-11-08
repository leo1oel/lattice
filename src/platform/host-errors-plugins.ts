/** Local plugin manager failures returned by the Rust host. */
import { t } from "@lingui/core/macro";
import type { HostErrorEntry } from "./host-error-text";

/* eslint-disable lingui/no-unlocalized-strings -- Rust literals are match keys */
export const PLUGIN_HOST_ERRORS: readonly HostErrorEntry[] = [
  ["plugins/registry.rs", "Cannot read plugin manifest: {e}", ([detail]) => t`Cannot read plugin manifest: ${detail}`],
  ["plugins/registry.rs", "Plugin manifest exceeds 64 KiB", () => t`Plugin manifest exceeds 64 KiB`],
  ["plugins/registry.rs", "Invalid plugin manifest: {e}", ([detail]) => t`Invalid plugin manifest: ${detail}`],
  ["plugins/registry.rs", "Invalid plugin identity or unsupported API version (expected 1)", () => t`Invalid plugin identity or unsupported API version (expected 1)`],
  ["plugins/registry.rs", "A plugin must declare 1–32 commands", () => t`A plugin must declare 1–32 commands`],
  ["plugins/registry.rs", "Invalid plugin command", () => t`Invalid plugin command`],
  ["plugins/registry.rs", "Cannot find plugin executable: {e}", ([detail]) => t`Cannot find plugin executable: ${detail}`],
  ["plugins/registry.rs", "Plugin executable must be a file inside its directory", () => t`Plugin executable must be a file inside its directory`],
  ["plugins/registry.rs", "Cannot read plugin registry: {e}", ([detail]) => t`Cannot read plugin registry: ${detail}`],
  ["plugins/registry.rs", "Cannot open plugin folder: {e}", ([detail]) => t`Cannot open plugin folder: ${detail}`],
  ["plugins/registry.rs", "Choose a plugin directory", () => t`Choose a plugin directory`],
  ["plugins/registry.rs", "A plugin with this ID is already installed", () => t`A plugin with this ID is already installed`],
  ["plugins/registry.rs", "Plugin ID changed; remove and reinstall it", () => t`Plugin ID changed; remove and reinstall it`],
  ["plugins/registry.rs", "Plugin not found", () => t`Plugin not found`],
  ["plugins/registry.rs", "Plugin executable moved outside its directory", () => t`Plugin executable moved outside its directory`],
  ["plugins/runner.rs", "Plugin command not found", () => t`Plugin command not found`],
  ["plugins/runner.rs", "Enable the plugin before running a command", () => t`Enable the plugin before running a command`],
  ["plugins/runner.rs", "Plugin manifest changed; disable and enable it again", () => t`Plugin manifest changed; disable and enable it again`],
  ["plugins/runner.rs", "Cannot start plugin: {e}", ([detail]) => t`Cannot start plugin: ${detail}`],
  ["plugins/runner.rs", "Plugin command timed out after 20 seconds", () => t`Plugin command timed out after 20 seconds`],
];
