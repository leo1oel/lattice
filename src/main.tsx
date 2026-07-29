import "./polyfills";
import "./index.css";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import App from "./App";
import { UpdaterProvider, UpdateBanner } from "./app-updater";
import "./app-updater.css";
import { RootErrorBoundary } from "./root-error-boundary";
import { AppToastStack } from "./app-log";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RootErrorBoundary>
    <UpdaterProvider>
      <App />
      <UpdateBanner corner="top-right" />
      <AppToastStack />
    </UpdaterProvider>
  </RootErrorBoundary>,
);
