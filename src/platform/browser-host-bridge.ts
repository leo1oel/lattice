import { getCurrentWindow } from "@tauri-apps/api/window";
import { decodeBridgeValue, encodeBridgeValue } from "./browser-runtime";

/* eslint-disable lingui/no-unlocalized-strings -- Tauri IPC protocol markers */
const CHANNEL_PREFIX = "__CHANNEL__:";
const IPC_SERIALIZE_KEY = "__TAURI_TO_IPC_KEY__";
const UNLISTEN_COMMAND = "plugin:event|unlisten";
/* eslint-enable lingui/no-unlocalized-strings */

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
      void internals.invoke(UNLISTEN_COMMAND, { event: listener.event, eventId }).catch(() => undefined);
    }
  };
  const reviveChannels = (value: unknown, callbackIds: Set<number>): unknown => {
    if (typeof value === "string" && value.startsWith(CHANNEL_PREFIX)) {
      const browserCallbackId = Number(value.slice(CHANNEL_PREFIX.length));
      if (!Number.isSafeInteger(browserCallbackId) || browserCallbackId < 0) return value;
      let hostCallbackId = 0;
      hostCallbackId = internals.transformCallback((payload) => {
        // A Tauri Channel callback carries its own { index, message } ordering
        // envelope. Passing it through another Channel consumes that envelope
        // in the hidden WebView, so the visible Channel receives the message as
        // an envelope, queues it under index `undefined`, and never calls its
        // onmessage handler. Proxy the serialized callback itself instead.
        forwardCallback(browserCallbackId, payload);
        if (payload && typeof payload === "object" && "end" in payload) {
          internals.unregisterCallback(hostCallbackId);
          callbackIds.delete(hostCallbackId);
        }
      });
      callbackIds.add(hostCallbackId);
      const serialize = () => `${CHANNEL_PREFIX}${hostCallbackId}`;
      return { [IPC_SERIALIZE_KEY]: serialize, toJSON: serialize };
    }
    if (Array.isArray(value)) return value.map((child) => reviveChannels(child, callbackIds));
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, reviveChannels(child, callbackIds)]),
      );
    }
    return value;
  };

  const handleInvoke = async (message: InvokeMessage) => {
    const channelCallbackIds = new Set<number>();
    const args = reviveChannels(decodeBridgeValue(message.args as never), channelCallbackIds) as Record<string, unknown>;
    const options = decodeBridgeValue(message.options as never);
    const generation = browserGeneration;
    let hostEventCallback: number | undefined;
    try {
      if (message.command === "plugin:event|listen" && typeof args.handler === "number") {
        const browserCallback = args.handler;
        hostEventCallback = internals.transformCallback((payload) => forwardCallback(browserCallback, payload));
        args.handler = hostEventCallback;
      }
      const value = await internals.invoke(message.command, args, options);
      if (message.command === "plugin:event|listen" && typeof value === "number" && hostEventCallback !== undefined) {
        if (generation === browserGeneration) {
          eventCallbacks.set(value, { callbackId: hostEventCallback, event: String(args.event) });
        } else {
          // The browser page reset while this listen was in flight.
          internals.unregisterCallback(hostEventCallback);
          hostEventCallback = undefined;
          await internals.invoke(UNLISTEN_COMMAND, { event: args.event, eventId: value });
        }
      }
      if (message.command === UNLISTEN_COMMAND && typeof args.eventId === "number") {
        const listener = eventCallbacks.get(args.eventId);
        if (listener) {
          internals.unregisterCallback(listener.callbackId);
          eventCallbacks.delete(args.eventId);
        }
      }
      send({ type: "response", id: message.id, ok: true, value: encodeBridgeValue(value) });
    } catch (error) {
      if (hostEventCallback !== undefined) internals.unregisterCallback(hostEventCallback);
      for (const callbackId of channelCallbackIds) internals.unregisterCallback(callbackId);
      const reason = error instanceof Error ? error.message : error;
      send({ type: "response", id: message.id, ok: false, error: encodeBridgeValue(reason) });
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
    switch (message.type) {
      case "ready":
        send({ type: "storage", entries: Object.entries(localStorage) });
        break;
      case "browser-reset":
        resetEventCallbacks();
        break;
      case "storage-update":
        localStorage.clear();
        for (const [key, value] of message.entries) localStorage.setItem(key, value);
        break;
      case "invoke":
        void handleInvoke(message);
        break;
      case "peer-disconnected":
        void getCurrentWindow().destroy();
        break;
      case "error":
        console.error(`[Lattice browser host] ${message.message}`);
    }
  });
  socket.addEventListener("error", () => {
    console.error("[Lattice browser host] The loopback bridge failed.");
  });
}
