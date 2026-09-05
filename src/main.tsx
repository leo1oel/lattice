import { browserRuntimeError, browserRuntimeReady } from "./platform/browser-runtime";
// OpenKnowledge imports the zoom package's structural stylesheet once at the
// app root. Without it, the native dialog expands as an unstyled white page,
// its close control becomes a stray black button, and the zoom transition
// cannot complete reliably.
import "react-medium-image-zoom/dist/styles.css";
import "./index.css";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "@lingui/react";
import "@fontsource-variable/inter";
import "./assets/fonts/ioskeley-mono/ioskeley-mono.css";
import "@fontsource/instrument-serif/400.css";
import App from "./App";
import { UpdaterProvider, UpdateBanner } from "./telemetry/app-updater";
import "./telemetry/app-updater.css";
import { RootErrorBoundary } from "./telemetry/root-error-boundary";
import { AppToastStack } from "./telemetry/app-log";
import { ConfirmActionProvider } from "./components/ui/confirm-action-dialog";
import { installGlobalErrorCapture } from "./telemetry/global-error-capture";
import { loadAppearance, resolveAppLocale } from "./settings/app-settings";
import { activateAppLocale, i18n } from "./i18n";

async function startApp() {
  await browserRuntimeReady();
  installGlobalErrorCapture();

  // Dev-only perf probe (docs/performance.md). The DEV guard makes the whole
  // branch dead code in production builds; the dynamic import keeps it out of
  // the startup chunk in dev.
  if (import.meta.env.DEV && localStorage.getItem("lattice-perf")) {
    void import("./platform/perf-probe").then((probe) => probe.installPerfProbe());
  }

  await activateAppLocale(resolveAppLocale(loadAppearance().interfaceLanguage));
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <I18nProvider i18n={i18n}>
      <RootErrorBoundary>
        <UpdaterProvider>
          <ConfirmActionProvider>
            <App />
            <UpdateBanner corner="top-right" />
            <AppToastStack />
          </ConfirmActionProvider>
        </UpdaterProvider>
      </RootErrorBoundary>
    </I18nProvider>,
  );
}

function showUnavailable(reason: unknown) {
  const root = document.getElementById("root");
  if (!root) return;
  root.style.cssText = "min-height:100vh;display:grid;place-items:center;padding:var(--space-16);font:var(--font-ui-body) system-ui;color:CanvasText;background:Canvas";
  root.textContent = reason instanceof Error ? reason.message : String(reason);
}

const hostConfig = window.__LATTICE_BROWSER_HOST_CONFIG__;
const unavailable = browserRuntimeError();
if (hostConfig) {
  void import("./platform/browser-host-bridge").then(({ startBrowserHostBridge }) => {
    startBrowserHostBridge(hostConfig);
  });
} else if (unavailable) {
  showUnavailable(unavailable);
} else {
  void startApp().catch(showUnavailable);
}
