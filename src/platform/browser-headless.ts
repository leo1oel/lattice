/**
 * What a tab of a headless browser host does itself. `--browser-host
 * --headless` runs Lattice on a Linux machine with no desktop session, so the
 * host never calls the system opener (browser_host.rs): nobody would see the
 * browser, file manager or window it started. This tab opens links in its own
 * browser instead, and refuses to show the host's files and folders. Projects
 * open in this tab (`open_project_window`'s `openHere`). Only a host started
 * that way says `headless` in its session reply, and a tab of any other host
 * never loads this module.
 */
import { runtimeText } from "./browser-runtime";

// Bootstrap text like browser-runtime.ts's, kept here so only a headless
// host's tab loads it. The first is the host's own NO_DESKTOP_APPS
// (browser_host.rs).
/* eslint-disable lingui/no-unlocalized-strings -- self-translated bootstrap text, Tauri command names */
const MESSAGES = {
  "no-desktop": [
    "This Lattice runs without a desktop, so it cannot open apps or folders on its computer.",
    "此 Lattice 在没有桌面的电脑上运行，无法在那台电脑上打开应用或文件夹。",
  ],
  "link-refused": [
    "Lattice opens only web, email and phone links.",
    "Lattice 只打开网页、电子邮件和电话链接。",
  ],
} as const satisfies Record<string, readonly [english: string, chinese: string]>;

const message = (key: keyof typeof MESSAGES) => runtimeText(MESSAGES[key]);

/** The opener plugin's URL scope (capabilities/default.json). */
const LINK_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

const noDesktop = () => {
  throw new Error(message("no-desktop"));
};

/** Commands this tab answers itself rather than relay to the host. */
export const HEADLESS_COMMANDS = new Map<string, (args: Record<string, unknown>) => unknown>([
  // Runs inside the click that asked, so the browser lets it open a tab.
  ["plugin:opener|open_url", ({ url }) => {
    const link = typeof url === "string" ? parseUrl(url) : null;
    if (!link || !LINK_SCHEMES.has(link.protocol)) throw new Error(message("link-refused"));
    // The linked page gets no handle on this one.
    window.open(link.href, "_blank", "noopener,noreferrer");
  }],
  ["plugin:opener|open_path", noDesktop],
  ["plugin:opener|reveal_item_in_dir", noDesktop],
]);
/* eslint-enable lingui/no-unlocalized-strings */

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
