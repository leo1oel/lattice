import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { clearTimer, disposeWhenSettled, restartTimer, type TimerRef } from "./effect-helpers";
import { APP_WINDOW_MIN_HEIGHT, minimumWindowWidth } from "./window-layout";

function getCurrentWindowSafely() {
  try {
    return getCurrentWindow();
  } catch {
    // Browser previews and a briefly unavailable Tauri bridge must not white-screen the app.
    return null;
  }
}

type AppWindow = NonNullable<ReturnType<typeof getCurrentWindowSafely>>;

/** Run `callback` once native resize events have been quiet for `delayMs`. */
function onResizeSettled(appWindow: AppWindow, delayMs: number, callback: () => void): () => void {
  const timer: TimerRef = { current: null };
  const stop = disposeWhenSettled(appWindow.onResized(() => restartTimer(timer, delayMs, callback)));
  return () => {
    clearTimer(timer);
    stop();
  };
}

/** Keep the native minimum size in step with the interface zoom. */
export function useWindowMinimumSize(interfaceScale: number) {
  useLayoutEffect(() => {
    const appWindow = getCurrentWindowSafely();
    if (typeof appWindow?.setMinSize !== "function") return;
    void appWindow.setMinSize(new LogicalSize(minimumWindowWidth(interfaceScale), APP_WINDOW_MIN_HEIGHT)).catch(() => {
      // Browser previews and older desktop capabilities may not expose this.
    });
  }, [interfaceScale]);
}

export function useFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const appWindow = getCurrentWindowSafely();
    if (typeof appWindow?.isFullscreen !== "function" || typeof appWindow.onResized !== "function") return;
    let active = true;
    const refresh = () => void appWindow.isFullscreen().then((value) => active && setIsFullscreen(value));
    refresh();
    // A trailing check avoids an IPC round trip per native resize event.
    const stop = onResizeSettled(appWindow, 80, refresh);
    return () => {
      active = false;
      stop();
    };
  }, []);
  return isFullscreen;
}

/**
 * Center the macOS traffic lights on the rendered titlebar, and start the
 * project switcher right after them.
 */
export function useTrafficLightAlignment(
  shellRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  interfaceScale: number,
  projectName: string | undefined,
) {
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const align = () => {
      if (!active) return;
      const shell = shellRef.current;
      const titlebar = shell?.querySelector<HTMLElement>(".titlebar");
      if (!shell || !titlebar) return;
      const rect = titlebar.getBoundingClientRect();
      // WebKit reports unzoomed CSS pixels while AppKit consumes logical points,
      // so apply the live webview zoom; the project switcher starts right of
      // the green light.
      const place = (greenRight: number) => {
        if (active) shell.style.setProperty("--titlebar-traffic-space-width", `${greenRight}px`);
      };
      void invoke<number | null>("align_traffic_lights", {
        // The geometric center, as AppKit's own compact toolbar centers the
        // lights on its items; no optical lift.
        centerFromTop: (rect.top + rect.height / 2) * interfaceScale,
      }).then((clusterRightPoints) => {
        if (!active) return;
        place(clusterRightPoints != null && Number.isFinite(clusterRightPoints)
          ? clusterRightPoints / interfaceScale
          : 72);
      }).catch(() => {
        // Browser tests and non-macOS builds have no native traffic lights.
        place(72);
      });
    };
    const frame = window.requestAnimationFrame(align);
    const initialTimer = window.setTimeout(align, 120);
    const appWindow = getCurrentWindowSafely();
    // Measure once AppKit's live-resize layout settles; every event would make the buttons jitter.
    const stop = typeof appWindow?.onResized === "function" ? onResizeSettled(appWindow, 120, align) : undefined;
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(initialTimer);
      stop?.();
    };
  }, [enabled, interfaceScale, projectName, shellRef]);
}
