import { lazy, Suspense, useSyncExternalStore } from "react";
import { browserPanel, supportsBrowserPanel } from "./link-destination";

const BrowserPanel = lazy(() => import("./browser-panel"));

export function BrowserPanelMount() {
  const request = useSyncExternalStore(browserPanel.subscribe, () => browserPanel.getState().request);
  return request && supportsBrowserPanel()
    ? <Suspense fallback={null}><BrowserPanel request={request} /></Suspense>
    : null;
}
