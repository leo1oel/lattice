import { afterEach, describe, expect, it, vi } from "vitest";
import { startBrowserHostBridge } from "./browser-host-bridge";

const IPC_SERIALIZE_KEY = "__TAURI_TO_IPC_KEY__";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  send = vi.fn();

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    sockets.push(this);
  }

  message(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

const sockets: FakeWebSocket[] = [];
const NativeWebSocket = globalThis.WebSocket;
const nativeInternals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

afterEach(() => {
  sockets.length = 0;
  vi.stubGlobal("WebSocket", NativeWebSocket);
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = nativeInternals;
});

describe("browser host bridge channels", () => {
  it("forwards Tauri channel ordering envelopes without consuming them in the hidden host", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const callbacks = new Map<number, (payload: unknown) => void>();
    let nextCallbackId = 100;
    const unregisterCallback = vi.fn((id: number) => callbacks.delete(id));
    const invoke = vi.fn(async (command: string, args?: unknown) => {
      if (command !== "plugin:updater|download_and_install") return undefined;
      const channel = (args as { onEvent: Record<string, () => string> }).onEvent;
      const serialized = channel[IPC_SERIALIZE_KEY]();
      const hostCallbackId = Number(serialized.replace("__CHANNEL__:", ""));
      const callback = callbacks.get(hostCallbackId);
      callback?.({ index: 0, message: { event: "Started", data: { contentLength: 400 } } });
      callback?.({ index: 1, message: { event: "Progress", data: { chunkLength: 100 } } });
      callback?.({ index: 2, end: true });
      return undefined;
    });
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback(callback?: (payload: unknown) => void) {
        const id = nextCallbackId++;
        callbacks.set(id, callback ?? (() => {}));
        return id;
      },
      unregisterCallback,
    };

    startBrowserHostBridge({ token: "secret", port: 18_452 });
    const socket = sockets.at(-1);
    if (!socket) throw new Error("Browser host bridge did not open a socket");
    socket.message({ type: "ready" });
    socket.message({
      type: "invoke",
      id: 7,
      command: "plugin:updater|download_and_install",
      args: { onEvent: "__CHANNEL__:42" },
      options: null,
    });

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      const messages = socket.send.mock.calls
        .map(([value]) => JSON.parse(String(value)) as { type: string })
        .filter((message) => message.type === "callback");
      expect(messages).toEqual([
        {
          type: "callback",
          id: 42,
          payload: { index: 0, message: { event: "Started", data: { contentLength: 400 } } },
        },
        {
          type: "callback",
          id: 42,
          payload: { index: 1, message: { event: "Progress", data: { chunkLength: 100 } } },
        },
        { type: "callback", id: 42, payload: { index: 2, end: true } },
      ]);
    });
    expect(unregisterCallback).toHaveBeenCalledWith(100);
  });
});
