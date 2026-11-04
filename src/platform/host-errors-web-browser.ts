import { t } from "@lingui/core/macro";
import type { HostErrorEntry } from "./host-error-text";

/* eslint-disable lingui/no-unlocalized-strings -- Rust error literals matched as data beside their translations */
export const WEB_BROWSER_HOST_ERRORS: readonly HostErrorEntry[] = [
  ["web_browser.rs", "The web browser window is no longer available.", () => t`The web browser window is no longer available.`],
  ["web_browser.rs", "Enter an HTTP or HTTPS web address.", () => t`Enter an HTTP or HTTPS web address.`],
  ["web_browser.rs", "Close a web browser window before opening another.", () => t`Close a web browser window before opening another.`],
  ["web_browser.rs", "Could not open the web browser window.", () => t`Could not open the web browser window.`],
  ["web_browser.rs", "Could not open this page in the default browser.", () => t`Could not open this page in the default browser.`],
  ["web_browser.rs", "Unknown web browser action.", () => t`Unknown web browser action.`],
  ["web_browser.rs", "Workspace commands are unavailable in web content.", () => t`Workspace commands are unavailable in web content.`],
];
