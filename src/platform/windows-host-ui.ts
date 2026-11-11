/**
 * Interface only the experimental Windows host uses: its F11 / Esc
 * fullscreen keys. Loaded on demand behind `isWindowsHost()`,
 * so the macOS startup bundle carries none of it (the eager-JS budget in
 * scripts/app-size-report.mjs had about 100 bytes to spare).
 */
import { getCurrentWindowSafely } from "../app/use-native-window";


/**
 * F11 toggles native fullscreen and Esc leaves it, as Windows apps do.
 * Esc is only claimed while the window is `fullscreen`. Returns the cleanup.
 */
export function watchFullscreenKeys(fullscreen: boolean): () => void {
  const appWindow = getCurrentWindowSafely();
  if (typeof appWindow?.setFullscreen !== "function") return () => {};
  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (event.key === "F11") {
      event.preventDefault();
      void appWindow.isFullscreen().then((value) => appWindow.setFullscreen(!value)).catch(() => {});
    } else if (event.key === "Escape" && fullscreen) {
      event.preventDefault();
      void appWindow.setFullscreen(false).catch(() => {});
    }
  };
  window.addEventListener("keydown", keydown);
  return () => window.removeEventListener("keydown", keydown);
}
