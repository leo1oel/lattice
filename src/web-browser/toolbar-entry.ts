import { mountBrowserToolbar } from "./toolbar";
import "./toolbar.css";

const runtime = window as Window & { __TAURI_INTERNALS__?: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } };
const root = document.getElementById("browser-toolbar");
if (root && runtime.__TAURI_INTERNALS__) {
  const dispose = mountBrowserToolbar(root, runtime.__TAURI_INTERNALS__, new URLSearchParams(location.search).get("lang") ?? "en");
  window.addEventListener("pagehide", dispose, { once: true });
}
