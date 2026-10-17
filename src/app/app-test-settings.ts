/**
 * The real Settings dialog for an App suite's `appHarness`. Importing this puts Settings in the suite's
 * import graph, so only the suites that test Settings do. It is not warmed: the suites exercise its loading
 * shell, which a chunk already in would skip.
 */
export { SettingsDialogSurface as settingsDialog } from "../settings/settings-dialog-surface";
