export const APP_WINDOW_MIN_WIDTH = 1302;
export const APP_WINDOW_MIN_HEIGHT = 680;

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
