/**
 * False on Linux, where Lattice ships as an AppImage that updates by hand: its
 * release has no updater archive, latest.json has no Linux entry, and the
 * backend does not register the updater plugin there (lib.rs). The WebKitGTK
 * window names Linux in its user agent; jsdom's spells it in lower case, and
 * Android browsers opening the web demo name Linux too.
 */
import { isWindowsHost } from "../platform/host-platform";

export function updatesItself(): boolean {
  const userAgent = navigator.userAgent;
  if (isWindowsHost()) return false;
  return !/\bLinux\b/.test(userAgent) || /\bAndroid\b/.test(userAgent);
}
