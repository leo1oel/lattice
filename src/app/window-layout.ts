/** 400 + 500 + 1 divider + a 320 sidebar and its divider. */
export const APP_WINDOW_MIN_WIDTH = 1222;
export const APP_WINDOW_MIN_HEIGHT = 680;

/**
 * Narrowest each track of the source/preview split may become. The window
 * baseline above is these two plus the dividers and a full sidebar, so pane
 * chrome that cannot fit inside them has nowhere left to shrink at run time.
 *
 * The source floor is 40 columns of the default 14px editor font (8.43px per
 * character) plus ~60px of gutters and line padding — enough that a wrapped
 * LaTeX line still reads as one thought. It used to be 480, which was the same
 * rule at 50 columns.
 */
export const SPLIT_SOURCE_MIN_WIDTH = 400;
export const SPLIT_PDF_MIN_WIDTH = 500;

const SIDEBAR_RESIZER_WIDTH = 1;

export function minimumWindowWidth(options: {
  interfaceScale: number;
  minimumSidebarWidth: number;
  minimumWorkspaceWidth: number;
  sidebarOpen: boolean;
}) {
  const scale = Number.isFinite(options.interfaceScale)
    ? Math.max(0.1, options.interfaceScale)
    : 1;
  const contentWidth = options.minimumWorkspaceWidth
    + (options.sidebarOpen ? options.minimumSidebarWidth + SIDEBAR_RESIZER_WIDTH : 0);

  // Webview zoom changes how many native window points the same CSS layout
  // needs. Keep the configured baseline, then grow it when the live sidebar
  // and workspace contract require more room.
  return Math.max(APP_WINDOW_MIN_WIDTH, Math.ceil(contentWidth * scale));
}
