import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Product } from "./workspace-types";

// Fixed entry points deliberately contain no OAuth parameters or account data.
const WEBSITES: Record<Product, string> = {
  docs: "https://docs.google.com/document/",
  sheets: "https://docs.google.com/spreadsheets/",
  slides: "https://docs.google.com/presentation/",
  forms: "https://docs.google.com/forms/",
  calendar: "https://calendar.google.com/",
};

/** The native browser is optional; ordinary websites never depend on Google IPC. */
export async function openWorkspaceWebsite(product: Product, inLattice: boolean) {
  const url = WEBSITES[product];
  if (inLattice) {
    try {
      await invoke("web_browser_open", { url });
      return;
    } catch {
      // Older desktop builds and headless hosts need no browser command.
    }
  }
  await openUrl(url);
}
