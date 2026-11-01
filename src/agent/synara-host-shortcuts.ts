import { useEffect } from "react";
import { isRecord } from "../app-utils";
import { liveShortcuts, pressMatches, type KeyPress } from "../app/use-app-commands";

/** The frame asks for the keys Lattice keeps (it sends this as it starts). */
const LATTICE_HOST_SHORTCUTS_REQUEST = "lattice:request-host-shortcuts";
/** `{ version: 1, shortcuts: [{ key, mod, ctrl, shift, alt }] }`: the keys a Synara frame leaves to Lattice. */
const LATTICE_HOST_SHORTCUTS = "lattice:host-shortcuts";
/** `{ version: 1, key, code, metaKey, ctrlKey, shiftKey, altKey }`: one of those keys, pressed in the frame. */
const SYNARA_HOST_SHORTCUT = "synara:host-shortcut";

/** Longer than any KeyboardEvent key or code ("ArrowRight", "NumpadDecimal"). */
const MAX_KEY_LENGTH = 32;

function forwardedPress(data: Record<string, unknown>): KeyPress | null {
  const { key, code, metaKey, ctrlKey, shiftKey, altKey } = data;
  if (data.version !== 1 || typeof key !== "string" || typeof code !== "string") return null;
  if (!key || key.length > MAX_KEY_LENGTH || code.length > MAX_KEY_LENGTH) return null;
  if (typeof metaKey !== "boolean" || typeof ctrlKey !== "boolean" || typeof shiftKey !== "boolean" || typeof altKey !== "boolean") return null;
  return { key, code, metaKey, ctrlKey, shiftKey, altKey };
}

/** Every Synara frame in this window: the Agent panel, the Git drawer's views, Settings' pages. */
function synaraFrames(origin: string): HTMLIFrameElement[] {
  return [...document.querySelectorAll("iframe")].filter((frame) => {
    try {
      return new URL(frame.src, window.location.href).origin === origin;
    } catch {
      return false;
    }
  });
}

const shortcutsMessage = () => ({ type: LATTICE_HOST_SHORTCUTS, version: 1, shortcuts: liveShortcuts.get() });

/**
 * A key pressed in a Synara frame stays in that cross-origin document, so with
 * the Agent panel or the Git drawer focused, ⌘K, ⌘S and ⌘, did nothing, and
 * Synara ran its own meaning of ⌘P (search files), ⌘N (new chat) and ⌘1 (a
 * thread) instead of Lattice's. Each frame is told which keys the window's
 * command table can run now (`lattice:host-shortcuts`), stops those before its
 * own listeners see them, and posts them back (`synara:host-shortcut`); here
 * the press is dispatched again on that frame's iframe element, so it reaches
 * the window's shortcuts as if pressed beside the frame. A key not in the list
 * at that moment is dropped, whatever a frame sends.
 */
export function useSynaraHostShortcuts(origin: string | null) {
  useEffect(() => {
    if (!origin) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || !isRecord(event.data)) return;
      const frame = synaraFrames(origin).find((item) => item.contentWindow === event.source);
      if (!frame?.contentWindow) return;
      if (event.data.type === LATTICE_HOST_SHORTCUTS_REQUEST) {
        frame.contentWindow.postMessage(shortcutsMessage(), origin);
        return;
      }
      if (event.data.type !== SYNARA_HOST_SHORTCUT) return;
      const press = forwardedPress(event.data);
      if (!press || !liveShortcuts.get().some((combo) => pressMatches(combo, press))) return;
      frame.dispatchEvent(new KeyboardEvent("keydown", { ...press, bubbles: true, cancelable: true, composed: true }));
    };
    // A frame that has not started yet asks when it does.
    const broadcast = () => {
      for (const frame of synaraFrames(origin)) frame.contentWindow?.postMessage(shortcutsMessage(), origin);
    };
    window.addEventListener("message", onMessage);
    const unsubscribe = liveShortcuts.subscribe(broadcast);
    broadcast();
    return () => {
      window.removeEventListener("message", onMessage);
      unsubscribe();
    };
  }, [origin]);
}
