/** The narrowest window, as configured in tauri.conf.json and lib.rs. */
export const APP_WINDOW_MIN_WIDTH = 1222;
export const APP_WINDOW_MIN_HEIGHT = 680;

/**
 * Narrowest each track of a document panel's Split (source beside its
 * rendered preview). A panel is often much narrower than the window (about
 * 630 px in the default layout), so these stay small enough to fit it instead
 * of overflowing the panel.
 */
export const SPLIT_SOURCE_MIN_WIDTH = 240;
export const SPLIT_PREVIEW_MIN_WIDTH = 280;

/** The native minimum grows with the webview zoom, which changes how many points the same layout needs. */
export function minimumWindowWidth(interfaceScale: number) {
  const scale = Number.isFinite(interfaceScale) ? Math.max(0.1, interfaceScale) : 1;
  return Math.max(APP_WINDOW_MIN_WIDTH, Math.ceil(APP_WINDOW_MIN_WIDTH * scale));
}
