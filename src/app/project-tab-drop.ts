import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindowSafely } from "./use-native-window";
import { subscribeTauriEvent } from "./effect-helpers";
import { findProjectDropSlot, markProjectDrop, type Point } from "./project-tab-hit";
import type { ProjectTabDestination } from "./project-tab-transfer";
import { listenInThisWindow } from "./window-events";

const DRAG_EVENT = "project-tab-drag";
const DROP_REPLY = "project-tab-drop-reply";
const HOVER_INTERVAL_MS = 60;
const HOVER_EXPIRY_MS = 350;
const DROP_REPLY_TIMEOUT_MS = 500;

type NativeHit = Point & { windowLabel: string };
type DragMessage =
  | { kind: "hover"; id: string; point: Point | null }
  | { kind: "drop"; id: string; source: string; point: Point };
type DropReply = { id: string; destination: ProjectTabDestination | null };

export function nativeProjectTabWindow(): string | undefined {
  // Browser-host windows use browser-* labels, and the website has no bridge.
  if (import.meta.env.LATTICE_WEB_DEMO) return;
  const label = getCurrentWindowSafely()?.label;
  return label && (label === "main" || label.startsWith("project-")) ? label : undefined;
}

function slotInPeer(strip: HTMLElement, point: Point | null) {
  if (!point || !strip.hasAttribute("data-project-drop-enabled")) return;
  return findProjectDropSlot(strip, {
    x: point.x * window.innerWidth,
    y: point.y * window.innerHeight,
  });
}

/** A window measures its own strip, so interface zoom, title truncation and
 * overlays all take effect even when the drag started in another window. */
export function listenForProjectTabDrops(strip: HTMLElement, windowLabel: string) {
  let hoveredBy: string | undefined;
  let expiry: number | undefined;
  const clear = () => {
    window.clearTimeout(expiry);
    if (hoveredBy) markProjectDrop(strip, undefined);
    hoveredBy = undefined;
  };
  const stop = subscribeTauriEvent<DragMessage>((handler) => listenInThisWindow(DRAG_EVENT, handler), (message) => {
    const slot = slotInPeer(strip, message.point);
    if (message.kind === "drop") {
      const destination = slot ? { windowLabel, beforeRoot: slot.beforeRoot } : null;
      void emitTo(message.source, DROP_REPLY, { id: message.id, destination } satisfies DropReply).catch(() => {});
    } else if (slot) {
      clear();
      hoveredBy = message.id;
      markProjectDrop(strip, slot);
      expiry = window.setTimeout(clear, HOVER_EXPIRY_MS);
    } else if (hoveredBy === message.id) {
      clear();
    }
  });
  return () => { stop(); clear(); };
}

async function askForDropSlot(source: string, id: string, hit: NativeHit): Promise<ProjectTabDestination | undefined> {
  let reply!: (value: ProjectTabDestination | undefined) => void;
  const answer = new Promise<ProjectTabDestination | undefined>((resolve) => { reply = resolve; });
  const stop = await listenInThisWindow<DropReply>(DROP_REPLY, ({ payload }) => {
    if (payload.id === id) reply(payload.destination ?? undefined);
  });
  const timeout = window.setTimeout(() => reply(undefined), DROP_REPLY_TIMEOUT_MS);
  try {
    await emitTo(hit.windowLabel, DRAG_EVENT, { kind: "drop", id, source, point: hit } satisfies DragMessage);
    return await answer;
  } finally {
    window.clearTimeout(timeout);
    stop();
  }
}

/** The page's pointer stays captured in the source. Only the host can see
 * overlapping windows in their native order. Preview asks at a bounded rate,
 * and release makes a fresh hit test before it can move a project. */
export function createProjectTabFlight(source: string) {
  const id = crypto.randomUUID();
  let peer: string | undefined;
  let timer: number | undefined;
  let reading = false;
  const preview = (label: string, point: Point | null) =>
    void emitTo(label, DRAG_EVENT, { kind: "hover", id, point } satisfies DragMessage).catch(() => {});
  const pointAt = (target: NativeHit | null) => {
    const next = target?.windowLabel === source ? null : target;
    if (peer && peer !== next?.windowLabel) preview(peer, null);
    peer = next?.windowLabel;
    if (peer && next) preview(peer, next);
  };
  const poll = async () => {
    if (reading) return;
    reading = true;
    try {
      const target = await invoke<NativeHit | null>("project_tab_drag_target");
      if (timer !== undefined) pointAt(target);
    } catch {
      // The platform may not support desktop cursor coordinates, e.g. Wayland.
      pointAt(null);
    } finally {
      reading = false;
    }
  };
  const stop = () => {
    window.clearInterval(timer);
    timer = undefined;
    pointAt(null);
  };
  return {
    preview(needsHost: boolean) {
      if (!needsHost) stop();
      else if (timer === undefined) {
        timer = window.setInterval(() => void poll(), HOVER_INTERVAL_MS);
        void poll();
      }
    },
    stop,
    async drop() {
      stop();
      try {
        const target = await invoke<NativeHit | null>("project_tab_drag_target");
        if (!target) return null; // Desktop: detach.
        if (target.windowLabel !== source) return await askForDropSlot(source, id, target);
      } catch {
        // No trustworthy hit or a closing peer: leave the project in place.
      }
      return undefined;
    },
  };
}
