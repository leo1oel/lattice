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

/**
 * Whose keys the shortcut hints name: the keyboard of the device showing the
 * page. In a desktop window that is the host; in a browser tab it may be
 * another device, such as a phone opening a Lattice hosted on Linux. Apple's
 * keyboards (Mac, iPhone, iPad) have ⌘, and CodeMirror and TipTap bind `Mod`
 * to it on all three; every other keyboard binds `Mod` to Ctrl. So this is
 * `hostPlatform` except for Android and ChromeOS, which that takes for a Mac
 * but which type with Ctrl.
 */
export function keyboardPlatform(): HostPlatform {
  const host = hostPlatform();
  return host === "mac" && /\b(?:Android|CrOS)\b/.test(navigator.userAgent) ? "linux" : host;
}

/** The Windows desktop host, including browser previews that emulate it. */
export function isWindowsHost(): boolean {
  return hostPlatform() === "windows";
}
