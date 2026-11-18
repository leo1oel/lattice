/**
 * The writer-facing words for plugins: why a run failed (by the host's
 * `PluginError.code`), what a plugin may access, and an action's default
 * button. Settings and the palette share them, as the GPUI app does.
 */
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { hostErrorText } from "../platform/host-error-text";
import type { PluginAction, PluginError, PluginPermissions } from "./plugin-ipc";

/** The error's text in the interface language; the plugin's own words where only it knows what happened. */
export function pluginErrorText(error: PluginError): string {
  const detail = hostErrorText(error.message?.trim() ?? "");
  switch (error.code) {
    case "unavailable": return i18n._(msg`Plugins run only on macOS for now.`);
    case "notInstalled": return i18n._(msg`This plugin is no longer installed.`);
    case "disabled": return i18n._(msg`This plugin is turned off. Turn it on in Settings › Plugins.`);
    case "needsReview": return i18n._(msg`This plugin asks for new permissions. Review them in Settings › Plugins.`);
    case "unknownCommand": return i18n._(msg`This plugin no longer has this command.`);
    case "broken": return i18n._(msg`The plugin is broken: ${detail}`);
    case "launch": return i18n._(msg`Couldn’t start the plugin: ${detail}`);
    case "timeout": return i18n._(msg`The plugin didn’t finish within 2 minutes.`);
    case "cancelled": return i18n._(msg`Cancelled.`);
    case "crashed": return i18n._(msg`The plugin stopped without an answer.`);
    case "protocol": return i18n._(msg`The plugin sent something Lattice couldn’t read: ${detail}`);
    case "unsupportedApi": {
      const level = error.level ?? 0;
      return i18n._(msg`This plugin needs plugin API level ${level}, which this Lattice doesn’t support.`);
    }
    default: return detail || i18n._(msg`The plugin failed.`);
  }
}

/** Errors only Settings › Plugins can fix, which offer to open it. */
export const pluginErrorOpensSettings = (error: PluginError) => error.code === "disabled" || error.code === "needsReview";

/** What a plugin may do, one plain line per grant, in the order docs/plugins.md lists them. */
export function permissionLines(permissions: PluginPermissions): string[] {
  const lines = [
    ...(permissions.projectRead.includes("context") ? [i18n._(msg`Read the open file, selection and cursor`)] : []),
    ...(permissions.projectRead.includes("bibliography") ? [i18n._(msg`Read the project’s bibliography`)] : []),
    ...permissions.networkLocal.map((port) => i18n._(msg`Connect to localhost:${port}`)),
    ...permissions.network.map((origin) => i18n._(msg`Send requests to ${origin}`)),
    ...permissions.secrets.map((name) => i18n._(msg`Use the saved secret “${name}”`)),
  ];
  return lines.length ? lines : [i18n._(msg`No access beyond the project’s name`)];
}

/** An action's button: the plugin's own title, else Lattice's name for the verb. */
export function actionLabel(action: PluginAction): string {
  if (action.title?.trim()) return action.title.trim();
  switch (action.type) {
    case "insertCitation": return i18n._(msg`Insert citation`);
    case "addBibEntry": return i18n._(msg`Add to bibliography`);
    case "replaceBibEntry": return i18n._(msg`Update entry`);
    case "reveal": return i18n._(msg`Open`);
    case "openUrl": return i18n._(msg`Open in browser`);
    case "copy": return i18n._(msg`Copy`);
  }
}
