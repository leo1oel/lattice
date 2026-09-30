/**
 * The narrowest window, as configured in tauri.conf.json and lib.rs: room for
 * the titlebar's controls. The live minimum is the Trellis layout's own.
 */
export const APP_WINDOW_MIN_WIDTH = 640;
export const APP_WINDOW_MIN_HEIGHT = 680;

/**
 * Narrowest each track of a document panel's Split (source beside its
 * rendered preview). A panel is often much narrower than the window (about
 * 630 px in the default layout), so these stay small enough to fit it instead
 * of overflowing the panel.
 */
export const SPLIT_SOURCE_MIN_WIDTH = 240;
export const SPLIT_PREVIEW_MIN_WIDTH = 280;

/**
 * The native minimum width, in points: the layout's minimum (CSS px, never
 * below the titlebar floor) grown by the webview zoom, which changes how many
 * points the same layout needs, and never wider than the screen can show.
 */
export function minimumWindowWidth({ layoutMinWidth, interfaceScale, screenWidth }: {
  layoutMinWidth: number;
  interfaceScale: number;
  screenWidth: number;
}) {
  const scale = Number.isFinite(interfaceScale) ? Math.max(0.1, interfaceScale) : 1;
  const content = Number.isFinite(layoutMinWidth) ? Math.max(APP_WINDOW_MIN_WIDTH, layoutMinWidth) : APP_WINDOW_MIN_WIDTH;
  const width = Math.ceil(content * scale);
  return Number.isFinite(screenWidth) && screenWidth > 0 ? Math.min(width, Math.floor(screenWidth)) : width;
}
