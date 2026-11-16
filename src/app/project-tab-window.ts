import { getCurrentWindowSafely } from "./use-native-window";

/** This window's label when it is a desktop workspace window that can send or
 * take a dragged project tab. Mirrors `is_workspace_window` in
 * src-tauri/src/lib.rs, which the host checks again on every move. */
export function nativeProjectTabWindow(): string | undefined {
  // Browser-host windows use browser-* labels, and the website has no bridge.
  if (import.meta.env.LATTICE_WEB_DEMO) return;
  const label = getCurrentWindowSafely()?.label;
  return label === "main" || (label?.startsWith("project-") && label.length > "project-".length) ? label : undefined;
}
