import "./polyfills";
import "./index.css";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource/instrument-serif/400.css";
import { InterfaceKit } from "interface-kit/react";
import App from "./App";
import { UpdaterProvider, UpdateBanner } from "./app-updater";
import "./app-updater.css";
import { RootErrorBoundary } from "./root-error-boundary";
import { AppToastStack } from "./app-log";
import { ConfirmActionProvider } from "./confirm-action-dialog";

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
