import { Channel } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { decodeBridgeValue, encodeBridgeValue } from "./browser-runtime";

const CHANNEL_PREFIX = "__CHANNEL__:";

interface HostConfig {
  token: string;
  port: number;
}

type InvokeMessage = {
  type: "invoke";
  id: number;
  command: string;
  args: unknown;
  options: unknown;
};

type ServerMessage =
  | { type: "ready" }
  | { type: "browser-reset" }
  | { type: "storage-update"; entries: [string, string][] }
  | { type: "peer-disconnected" }
  | { type: "error"; message: string }
  | InvokeMessage;

interface NativeInternals {
  invoke: (command: string, args?: unknown, options?: unknown) => Promise<unknown>;
  transformCallback: (callback?: (payload: unknown) => void, once?: boolean) => number;
  unregisterCallback: (id: number) => void;
}

export function startBrowserHostBridge(config: HostConfig): void {
  const internals = (window as unknown as { __TAURI_INTERNALS__: NativeInternals })
    .__TAURI_INTERNALS__;
  const socketUrl = new URL(`ws://127.0.0.1:${config.port}/__lattice_bridge`);
  socketUrl.searchParams.set("token", config.token);
  socketUrl.searchParams.set("role", "host");
  const socket = new WebSocket(socketUrl);
  const eventCallbacks = new Map<number, { callbackId: number; event: string }>();
  let browserGeneration = 0;

  const send = (message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const forwardCallback = (id: number, payload: unknown) => {
    send({ type: "callback", id, payload: encodeBridgeValue(payload) });
  };
  const resetEventCallbacks = () => {
    browserGeneration += 1;
    const listeners = [...eventCallbacks];
    eventCallbacks.clear();
    for (const [eventId, listener] of listeners) {
      internals.unregisterCallback(listener.callbackId);
      void internals.invoke("plugin:event|unlisten", {
        event: listener.event,
        eventId,
      }).catch(() => undefined);
    }
  };
  const reviveChannels = (value: unknown): unknown => {
    if (typeof value === "string" && value.startsWith(CHANNEL_PREFIX)) {
      const callbackId = Number(value.slice(CHANNEL_PREFIX.length));
      return new Channel((payload) => forwardCallback(callbackId, payload));
    }
    if (Array.isArray(value)) return value.map(reviveChannels);
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, reviveChannels(child)]),
      );
    }
    return value;
  };

  const handleInvoke = async (message: InvokeMessage) => {
    const args = reviveChannels(decodeBridgeValue(message.args as never)) as Record<string, unknown>;
    const options = decodeBridgeValue(message.options as never);
    const generation = browserGeneration;
    let hostEventCallback: number | undefined;
    try {
      if (
        message.command === "plugin:event|listen"
        && typeof args.handler === "number"
      ) {
        const browserCallback = args.handler;
        hostEventCallback = internals.transformCallback((payload) => {
          forwardCallback(browserCallback, payload);
        });
        args.handler = hostEventCallback;
      }
      const value = await internals.invoke(message.command, args, options);
      if (
        message.command === "plugin:event|listen"
        && typeof value === "number"
        && hostEventCallback !== undefined
      ) {
        if (generation === browserGeneration) {
          eventCallbacks.set(value, {
            callbackId: hostEventCallback,
            event: String(args.event),
          });
        } else {
          internals.unregisterCallback(hostEventCallback);
          hostEventCallback = undefined;
          await internals.invoke("plugin:event|unlisten", {
            event: args.event,
            eventId: value,
          });
        }
      }
      if (message.command === "plugin:event|unlisten" && typeof args.eventId === "number") {
        const listener = eventCallbacks.get(args.eventId);
        if (listener) {
          internals.unregisterCallback(listener.callbackId);
          eventCallbacks.delete(args.eventId);
        }
      }
      send({ type: "response", id: message.id, ok: true, value: encodeBridgeValue(value) });
      if (message.command === "return_to_desktop") {
        // The server retires the browser session only after this marker. Both
        // messages use the same socket, so the command response is guaranteed
        // to be queued first rather than racing an arbitrary teardown timer.
        send({ type: "desktop-return-complete" });
      }
    } catch (error) {
      if (hostEventCallback !== undefined) internals.unregisterCallback(hostEventCallback);
      send({
        type: "response",
        id: message.id,
        ok: false,
        error: encodeBridgeValue(error instanceof Error ? error.message : error),
      });
    }
  };

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: ServerMessage;
    try {
      message = JSON.parse(event.data) as ServerMessage;
    } catch {
      return;
    }
    if (message.type === "ready") {
      send({ type: "storage", entries: Object.entries(localStorage) });
    }
    if (message.type === "browser-reset") resetEventCallbacks();
    if (message.type === "storage-update") {
      localStorage.clear();
      for (const [key, value] of message.entries) localStorage.setItem(key, value);
    }
    if (message.type === "invoke") void handleInvoke(message);
    if (message.type === "peer-disconnected") void getCurrentWindow().destroy();
    if (message.type === "error") {
      console.error(`[Lattice browser host] ${message.message}`);
    }
  });
  socket.addEventListener("error", () => {
    console.error("[Lattice browser host] The loopback bridge failed.");
  });
}
