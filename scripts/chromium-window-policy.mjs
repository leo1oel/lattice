const LOOPBACK_HOST = "127.0.0.1";
const PRESENTER_PATH = "/__lattice/bootstrap";

/**
 * Browser-hosted CSS assumes an ordinary browser tab has no traffic
 * lights. Restore the native macOS inset and make empty titlebar chrome
 * draggable so this Chromium experiment behaves like an app window.
 */
export const CHROMIUM_WINDOW_CSS = `
  .app-shell.browser-hosted .traffic-space {
    width: 70px !important;
  }
  .app-shell.browser-hosted .titlebar-navigator {
    width: var(--titlebar-navigator-width) !important;
    padding: 0 !important;
  }
  .titlebar-drag-area {
    -webkit-app-region: drag;
  }
  .titlebar-main > .trellis-titlebar {
    -webkit-app-region: drag;
  }
  .titlebar-main > .trellis-titlebar button {
    -webkit-app-region: no-drag;
  }
  /* Native drag regions ignore DOM stacking, so a drawer covering the
     titlebar must explicitly subtract its interactive area. */
  .resizable-drawer {
    -webkit-app-region: no-drag;
  }
`;

export function isOpenSlidePresenterUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== LOOPBACK_HOST
    || !url.port
    || url.username
    || url.password
    || url.pathname !== PRESENTER_PATH
  ) return false;

  const tokens = url.searchParams.getAll("token");
  const targets = url.searchParams.getAll("next");
  if (tokens.length !== 1 || !tokens[0] || targets.length !== 1) return false;
  const match = /^\/s\/([a-z0-9]+(?:-[a-z0-9]+)*)\/presenter$/.exec(targets[0]);
  return Boolean(match?.[1]);
}

export function openSlidePresenterWindowOptions(rawUrl) {
  if (!isOpenSlidePresenterUrl(rawUrl)) return null;
  return {
    action: "allow",
    overrideBrowserWindowOptions: {
      title: "Open Slide Presenter",
      width: 1_280,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      backgroundColor: "#09090B",
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    },
  };
}
