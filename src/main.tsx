import "./polyfills";
// OpenKnowledge imports the zoom package's structural stylesheet once at the
// app root. Without it, the native dialog expands as an unstyled white page,
// its close control becomes a stray black button, and the zoom transition
// cannot complete reliably.
import "react-medium-image-zoom/dist/styles.css";
import "./index.css";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "./assets/fonts/ioskeley-mono/ioskeley-mono.css";
import "@fontsource/instrument-serif/400.css";
import { InterfaceKit } from "interface-kit/react";
import App from "./App";
import { UpdaterProvider, UpdateBanner } from "./app-updater";
import "./app-updater.css";
import { RootErrorBoundary } from "./root-error-boundary";
import { AppToastStack } from "./app-log";
import { ConfirmActionProvider } from "./confirm-action-dialog";
import { installGlobalErrorCapture } from "./global-error-capture";

installGlobalErrorCapture();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <>
    <RootErrorBoundary>
      <UpdaterProvider>
        <ConfirmActionProvider>
          <App />
          <UpdateBanner corner="top-right" />
          <AppToastStack />
        </ConfirmActionProvider>
      </UpdaterProvider>
    </RootErrorBoundary>
    {import.meta.env.DEV && <InterfaceKit />}
  </>,
);
