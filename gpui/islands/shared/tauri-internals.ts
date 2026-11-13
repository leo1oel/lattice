/**
 * Tauri's injected internals, stood in for inside an island, so the Tauri
 * app's modules run unchanged: every `invoke` they make (`@tauri-apps/api`,
 * its plugins) becomes a `tauri:invoke` request over the island bridge, which
 * the island's owner in the GPUI app answers for the commands that island
 * needs and refuses for every other. The shape follows the stand-in the
 * performance bench installs (`tools/mock-backend/tauri-internals.ts`).
 *
 * A command whose payload is raw bytes (`save_xlsx` sends the workbook as the
 * request body, with its destination in a header) crosses the bridge as
 * base64 with the headers beside it, since the bridge speaks JSON.
 */
import { host } from "./host";

type Args = Record<string, unknown> | ArrayBuffer | Uint8Array | undefined;
type Callback = (payload: unknown) => void;
type InvokeOptions = { headers?: Record<string, string> | Headers };

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function plainHeaders(headers: InvokeOptions["headers"]): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return { ...headers };
}

let emitInPage: (event: string, payload: unknown) => void = () => {};

/** A Tauri event to the page's own listeners, as the Tauri app's backend would emit it. */
export function emitTauriEvent(event: string, payload: unknown): void {
  emitInPage(event, payload);
}

export function installTauriInternals(label: string): void {
  const callbacks = new Map<number, Callback>();
  const listeners = new Map<string, Set<number>>();
  const eventIds = new Map<number, { event: string; handler: number }>();
  let nextCallback = 1;
  let nextEvent = 1;
  const emit = (event: string, payload: unknown) => {
    for (const handler of listeners.get(event) ?? []) callbacks.get(handler)?.({ event, id: 0, payload });
  };
  emitInPage = emit;

  async function invoke(command: string, args?: Args, options?: InvokeOptions): Promise<unknown> {
    // Events stay in the page: nothing in the GPUI app emits Tauri events.
    if (command === "plugin:event|listen") {
      const { event, handler } = args as { event: string; handler: number };
      const id = nextEvent++;
      eventIds.set(id, { event, handler });
      listeners.set(event, (listeners.get(event) ?? new Set()).add(handler));
      return id;
    }
    if (command === "plugin:event|unlisten") {
      const eventId = (args as { eventId: number }).eventId;
      const entry = eventIds.get(eventId);
      if (entry) {
        listeners.get(entry.event)?.delete(entry.handler);
        eventIds.delete(eventId);
      }
      return null;
    }
    if (command === "plugin:event|emit" || command === "plugin:event|emit_to") {
      const { event, payload } = args as { event: string; payload: unknown };
      emit(event, payload);
      return null;
    }
    const binary = args instanceof ArrayBuffer ? new Uint8Array(args) : args instanceof Uint8Array ? args : null;
    return host().request("tauri:invoke", {
      command,
      args: binary ? null : (args ?? null),
      base64: binary ? base64(binary) : null,
      headers: plainHeaders(options?.headers),
    });
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
      convertFileSrc: (path: string) => path,
      metadata: {
        currentWindow: { label },
        currentWebview: { label, windowLabel: label },
      },
      plugins: {},
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener: (_event: string, eventId: number) => {
        const entry = eventIds.get(eventId);
        if (entry) {
          listeners.get(entry.event)?.delete(entry.handler);
          eventIds.delete(eventId);
        }
      },
    },
  });
}
