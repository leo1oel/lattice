import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toMessage } from "../app-utils";
import type { CollabProjectControllerV2 } from "../collab/collab-project-v2";
import { disposeWhenSettled } from "./effect-helpers";
import { setError } from "./notify";
import { APP_WINDOW_MIN_HEIGHT, minimumWindowWidth } from "./window-layout";

const TRAFFIC_LIGHT_OPTICAL_Y_OFFSET_CSS_PX = 0.25;

export function getCurrentWindowSafely() {
  try {
    return getCurrentWindow();
  } catch {
    // Browser previews, recovery pages, and a briefly unavailable Tauri
    // bridge should not replace the entire application with a white screen.
    return null;
  }
}

type AppWindow = NonNullable<ReturnType<typeof getCurrentWindowSafely>>;

/** Run `callback` once native resize events have been quiet for `delayMs`. */
function onResizeSettled(appWindow: AppWindow, delayMs: number, callback: () => void): () => void {
  let timer: number | undefined;
  const stop = disposeWhenSettled(appWindow.onResized(() => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(callback, delayMs);
  }));
  return () => {
    if (timer !== undefined) window.clearTimeout(timer);
    stop();
  };
}

/**
 * Keep the native minimum size in step with what the workspace can lay out.
 * `canvasMode` and `projectRoot` only trigger a re-measure: they change which
 * canvas reports its minimum width.
 */
export function useWindowMinimumSize({ interfaceScale, minimumSidebarWidth, sidebarOpen, canvasMode, projectRoot }: {
  interfaceScale: number;
  minimumSidebarWidth: number;
  sidebarOpen: boolean;
  canvasMode: string;
  projectRoot: string | undefined;
}) {
  useLayoutEffect(() => {
    const appWindow = getCurrentWindowSafely();
    if (typeof appWindow?.setMinSize !== "function") return;
    const minimumWorkspaceWidth = Number(
      document.querySelector<HTMLElement>(".split-canvas[data-minimum-workspace-width]")
        ?.dataset.minimumWorkspaceWidth,
    ) || 0;
    const width = minimumWindowWidth({ interfaceScale, minimumSidebarWidth, minimumWorkspaceWidth, sidebarOpen });
    void appWindow.setMinSize(new LogicalSize(width, APP_WINDOW_MIN_HEIGHT)).catch(() => {
      // Browser previews and older desktop capabilities may not expose this.
    });
  }, [interfaceScale, minimumSidebarWidth, sidebarOpen, canvasMode, projectRoot]);
}

/** Leave collaboration presence (bounded) before the window closes. */
export function useLeavePresenceOnClose(controllerRef: RefObject<CollabProjectControllerV2 | null>) {
  useEffect(() => {
    const appWindow = getCurrentWindowSafely();
    if (typeof appWindow?.onCloseRequested !== "function" || typeof appWindow.destroy !== "function") return;
    let active = true;
    let closing = false;
    const stop = disposeWhenSettled(appWindow.onCloseRequested((event) => {
      if (closing) return;
      closing = true;
      event.preventDefault();
      const leave = controllerRef.current?.leavePresence() ?? Promise.resolve();
      const deadline = new Promise<void>((resolve) => window.setTimeout(resolve, 500));
      void Promise.race([leave.catch(() => undefined), deadline]).finally(() => {
        if (!active) return;
        // Preventing the close above means this call is the only thing that
        // still closes the window: swallowing its rejection (a missing
        // core:window:allow-destroy grant did exactly that) leaves the traffic
        // light dead with nothing on screen to explain it.
        void appWindow.destroy().catch((reason) => {
          closing = false;
          setError(`Lattice could not close its window: ${toMessage(reason)}`);
        });
      });
    }));
    return () => {
      active = false;
      stop();
    };
  }, [controllerRef]);
}

export function useFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const appWindow = getCurrentWindowSafely();
    if (typeof appWindow?.isFullscreen !== "function" || typeof appWindow.onResized !== "function") return;
    let active = true;
    const refresh = () => {
      void appWindow.isFullscreen().then((value) => active && setIsFullscreen(value));
    };
    refresh();
    // Native resize events can arrive much faster than WebKit presents
    // frames. A trailing check avoids queueing an IPC round trip per pixel.
    const stop = onResizeSettled(appWindow, 80, refresh);
    return () => {
      active = false;
      stop();
    };
  }, []);
  return isFullscreen;
}

/**
 * Center the macOS traffic lights on the rendered titlebar and place the
 * sidebar toggle midway between them and the project label.
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
      // WebKit reports unzoomed CSS pixels while AppKit consumes logical
      // points. Measuring the rendered titlebar and applying the live webview
      // zoom keeps the native center aligned for every interface scale.
      // Horizontally, Hide Sidebar sits at the midpoint between the green
      // traffic-light's right edge and the project *label* (not the padded
      // button box — padding made the control look biased left).
      const placeToggle = (greenRight: number) => {
        if (!active) return;
        shell.style.setProperty("--titlebar-traffic-space-width", `${greenRight}px`);
        const projectTitle = shell.querySelector<HTMLElement>(".project-title");
        if (!projectTitle) return;
        const label = projectTitle.querySelector<HTMLElement>(":scope > span") ?? projectTitle;
        const projectLeft = label.getBoundingClientRect().left - titlebar.getBoundingClientRect().left;
        if (!(projectLeft > greenRight)) return;
        shell.style.setProperty("--titlebar-toggle-center", `${(greenRight + projectLeft) / 2}px`);
      };
      const place = (greenRight: number) => {
        placeToggle(greenRight);
        requestAnimationFrame(() => placeToggle(greenRight));
      };
      void invoke<number | null>("align_traffic_lights", {
        centerFromTop: (rect.top + rect.height / 2 - TRAFFIC_LIGHT_OPTICAL_Y_OFFSET_CSS_PX) * interfaceScale,
      }).then((clusterRightPoints) => {
        if (!active) return;
        place(clusterRightPoints != null && Number.isFinite(clusterRightPoints)
          ? clusterRightPoints / interfaceScale
          : 70);
      }).catch(() => {
        // Browser tests and non-macOS builds have no native traffic lights.
        place(70);
      });
    };
    const frame = window.requestAnimationFrame(align);
    const initialTimer = window.setTimeout(align, 120);
    const appWindow = getCurrentWindowSafely();
    // Wait until AppKit's live-resize layout pass has settled, then measure
    // once. Updating on every resize event makes the native buttons jitter.
    const stop = typeof appWindow?.onResized === "function" ? onResizeSettled(appWindow, 120, align) : undefined;
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(initialTimer);
      stop?.();
    };
  }, [enabled, interfaceScale, projectName, shellRef]);
}
