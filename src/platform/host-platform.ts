/** The Windows desktop host, including browser previews that emulate it. */
export function isWindowsHost(): boolean {
  return /\bWindows NT\b/.test(navigator.userAgent);
}
