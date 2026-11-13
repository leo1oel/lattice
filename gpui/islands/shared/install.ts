/**
 * Imported first by every island page, so Tauri's internals stand in before
 * any of the Tauri app's modules is evaluated (some read them at import, as
 * `src/platform/browser-runtime.ts` does).
 */
import { installTauriInternals } from "./tauri-internals";

const label = document.documentElement.dataset.island ?? "island";
installTauriInternals(label);
