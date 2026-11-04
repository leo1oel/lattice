/**
 * Tauri's injected internals, stood in for in a plain browser, so a page can
 * run the real app against an in-memory backend: the performance bench
 * (tools/perf-bench) and the website's demo (tools/web-demo).
 *
 * Installing `__TAURI_INTERNALS__` before the app loads makes
 * src/platform/browser-runtime.ts stand aside, exactly as it does inside the
 * Tauri webview, so every `invoke` lands in the page's answer. Events go
 * through an in-page emitter: the app's `listen` and `emit` reach each other,
 * and the page's backend emits as the Rust side would.
 */

export type Args = Record<string, unknown> | undefined;
type Callback = (payload: unknown) => void;

/** What an area's answer returns for a command it does not model, so the page asks the next one. */
export const NOT_HANDLED = Symbol("not handled");

export type MockTauri = {
  /** An event to the app's listeners, as the backend's `emit` sends one. */
  emit(event: string, payload: unknown): void;
  /** What Tauri does for `channel.send`: the channel's callback, with the message's place in order. */
  sendOnChannel(channel: unknown, message: unknown): void;
};

/** Installs the internals on `window`; every command but the event plugin's goes to `answer`. */
export function installTauriInternals(answer: (command: string, args: Args) => unknown): MockTauri {
  const callbacks = new Map<number, Callback>();
  const listeners = new Map<string, Set<number>>();
  const eventIds = new Map<number, { event: string; handler: number }>();
  let nextCallback = 1;
  let nextEvent = 1;

  const emit = (event: string, payload: unknown) => {
    for (const handler of listeners.get(event) ?? []) {
      callbacks.get(handler)?.({ event, id: 0, payload });
    }
  };
  const sendOnChannel = (channel: unknown, message: unknown) => {
    const id = (channel as { id?: number } | undefined)?.id;
    if (id !== undefined) callbacks.get(id)?.({ index: 0, message });
  };

  async function invoke(command: string, args?: Args): Promise<unknown> {
    if (command === "plugin:event|listen") {
      const { event, handler } = args as { event: string; handler: number };
      const id = nextEvent++;
      eventIds.set(id, { event, handler });
      listeners.set(event, (listeners.get(event) ?? new Set()).add(handler));
      return id;
    }
    if (command === "plugin:event|unlisten") {
      const entry = eventIds.get((args as { eventId: number }).eventId);
      if (entry) {
        listeners.get(entry.event)?.delete(entry.handler);
        eventIds.delete((args as { eventId: number }).eventId);
      }
      return null;
    }
    if (command === "plugin:event|emit" || command === "plugin:event|emit_to") {
      const { event, payload } = args as { event: string; payload: unknown };
      emit(event, payload);
      return null;
    }
    return answer(command, args);
  }

  Object.assign(window, {
    __TAURI_INTERNALS__: {
      invoke,
      transformCallback: (callback?: Callback, once = false) => {
        const id = nextCallback++;
        callbacks.set(id, (payload) => {
          if (once) callbacks.delete(id);
          callback?.(payload);
        });
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      runCallback: (id: number, payload: unknown) => callbacks.get(id)?.(payload),
      callbacks,
      convertFileSrc: (path: string) => path,
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main", windowLabel: "main" },
      },
      plugins: { path: { sep: "/", delimiter: ":" } },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener: (_event: string, id: number) => callbacks.delete(id),
    },
  });
  return { emit, sendOnChannel };
}

/** The window plugin's questions, answered as a focused, windowed browser tab would. */
export function windowAnswer(command: string): unknown {
  switch (command) {
    case "plugin:window|scale_factor":
      return window.devicePixelRatio;
    case "plugin:window|inner_size":
    case "plugin:window|outer_size":
      return {
        width: Math.round(window.innerWidth * window.devicePixelRatio),
        height: Math.round(window.innerHeight * window.devicePixelRatio),
      };
    case "plugin:window|is_focused":
      return document.hasFocus();
    case "plugin:window|is_fullscreen":
    case "plugin:window|is_maximized":
      return false;
    default:
      return NOT_HANDLED;
  }
}
