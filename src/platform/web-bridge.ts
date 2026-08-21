/**
 * Lattice is a Tauri desktop app whose frontend can also be served as a plain
 * website (e.g. a Vercel preview deployment). In that browser-only context the
 * native (Rust) bridge does not exist, so `public/polyfills.js` installs a stub
 * whose `invoke` rejects with an error tagged `latticeWebBridgeUnavailable`.
 *
 * This is the single source of truth for recognising that tag. Callers use it
 * to treat "native unavailable" as an expected no-op in web mode instead of a
 * real failure, so a web deployment renders cleanly without desktop-only error
 * noise.
 */

const WEB_BRIDGE_MARKER = "latticeWebBridgeUnavailable";

/** True when `reason` is a rejection from the browser-mode Tauri stub. */
export function isWebBridgeUnavailable(reason: unknown): boolean {
  return Boolean(
    reason &&
      typeof reason === "object" &&
      (reason as Record<string, unknown>)[WEB_BRIDGE_MARKER] === true,
  );
}

/** True when the native desktop bridge is present (i.e. running under Tauri). */
export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && Boolean((window as { isTauri?: boolean }).isTauri);
}
