/** The desktops Lattice runs on. */
export type HostPlatform = "mac" | "windows" | "linux";

/**
 * The desktop host, including browser previews that emulate it. A WebKitGTK
 * window (and a Linux desktop browser) names Linux in its user agent; jsdom
 * spells it in lower case and Android browsers opening the web demo name
 * Linux too, and neither is the Linux desktop. Whatever is left is a Mac.
 *
 * What differs by host is written as a `Record<HostPlatform, …>`, one row
 * each, so that a new host does not compile until every table has its row.
 * `isWindowsHost() ? … : …` left "the rest" to mean a Mac in one file and
 * Linux in another, and a Linux window drew ⌘ for its Ctrl.
 */
export function hostPlatform(): HostPlatform {
  const userAgent = navigator.userAgent;
  if (/\bWindows NT\b/.test(userAgent)) return "windows";
  if (/\bLinux\b/.test(userAgent) && !/\bAndroid\b/.test(userAgent)) return "linux";
  return "mac";
}

/** The Windows desktop host, including browser previews that emulate it. */
export function isWindowsHost(): boolean {
  return hostPlatform() === "windows";
}
