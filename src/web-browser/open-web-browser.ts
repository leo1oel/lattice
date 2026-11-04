import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isBrowserHosted } from "../platform/browser-runtime";

export async function openWebBrowser(locale: string): Promise<void> {
  // A regular browser cannot host a native child WebView. Its own tab supports
  // sites that reject frames, without bypassing their content security policy.
  if (isBrowserHosted()) return openUrl("https://example.com");
  await invoke("web_browser_open", { url: "https://example.com", locale });
}
