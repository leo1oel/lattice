import "./polyfills";
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
import { UpdaterProvider, UpdateBanner } from "./app-updater";
import "./app-updater.css";
import { RootErrorBoundary } from "./root-error-boundary";
import { AppToastStack } from "./app-log";
import { ConfirmActionProvider } from "./confirm-action-dialog";
import { installGlobalErrorCapture } from "./global-error-capture";
import { loadAppearance, resolveAppLocale } from "./app-settings";
import { activateAppLocale, i18n } from "./i18n";

installGlobalErrorCapture();

// Dev-only perf probe (docs/performance.md). The DEV guard makes the whole
// branch dead code in production builds; the dynamic import keeps it out of
// the startup chunk in dev.
if (import.meta.env.DEV && localStorage.getItem("lattice-perf")) {
  void import("./perf-probe").then((probe) => probe.installPerfProbe());
}

async function startApp() {
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

void startApp();
