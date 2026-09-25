import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserRelay,
  BrowserEventRegistry,
  decodeBridgeValue,
  encodeBridgeValue,
  type BrowserRuntimeConfig,
} from "./browser-runtime";

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

  disconnect(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

const sockets: FakeWebSocket[] = [];
const NativeWebSocket = globalThis.WebSocket;

describe("Chromium file drops", () => {
  it("routes a dropped SVG locally with physical coordinates and cleans up", () => {
    const callback = vi.fn();
    const registry = new BrowserEventRegistry(callback);
    const file = new File(["<svg/>"], "plot.svg", { type: "image/svg+xml" });
    Object.assign(window, { latticeDesktop: { getPathForFile: () => "/tmp/plot.svg" } });
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
    const id = registry.listen("tauri://drag-drop", 73);
    expect(id).not.toBeNull();
    const drop = new MouseEvent("drop", { clientX: 135, clientY: 247, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { types: ["Files"], files: [file] },
    });
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(callback).toHaveBeenCalledWith(73, {
      event: "tauri://drag-drop", id,
      payload: { paths: ["/tmp/plot.svg"], position: { x: 270, y: 494 } },
    });
    registry.unregister("tauri://drag-drop", id!, vi.fn());
    callback.mockClear();
    window.dispatchEvent(drop);
    expect(callback).not.toHaveBeenCalled();
    Reflect.deleteProperty(window, "latticeDesktop");
  });

  it("tracks protected file drags without consuming internal tree moves", () => {
    const callback = vi.fn();
    const registry = new BrowserEventRegistry(callback);
    Object.assign(window, { latticeDesktop: { getPathForFile: vi.fn() } });
    for (const [name, domName] of [["enter", "dragenter"], ["over", "dragover"], ["leave", "dragleave"]]) {
      const event = `tauri://drag-${name}`;
      const id = registry.listen(event, 19)!;
      const drag = new MouseEvent(domName, { clientX: 40, clientY: 90, cancelable: true });
      Object.defineProperty(drag, "dataTransfer", { value: { types: ["Files"], files: [] } });
      window.dispatchEvent(drag);
      expect(drag.defaultPrevented).toBe(true);
      expect(callback).toHaveBeenLastCalledWith(19, {
        event, id, payload: { paths: [], position: { x: 40, y: 90 } },
      });
      callback.mockClear();
      const internal = new MouseEvent(domName, { cancelable: true });
      Object.defineProperty(internal, "dataTransfer", { value: { types: ["text/plain"], files: [] } });
      window.dispatchEvent(internal);
      expect(internal.defaultPrevented).toBe(false);
      expect(callback).not.toHaveBeenCalled();
      registry.unregister(event, id, vi.fn());
    }
  });

  it("leaves ordinary browser subscriptions on the existing relay", () => {
    const registry = new BrowserEventRegistry(vi.fn());
    expect(registry.listen("tauri://drag-drop", 1)).toBeNull();
  });
});

function connectedRelay(
  reload = vi.fn(),
  role: "browser" | "desktop" = "browser",
  closePage = vi.fn(),
) {
  const config: BrowserRuntimeConfig = {
    token: "secret",
    bridgePort: 18_452,
    label: "browser-test",
  };
  const relay = new BrowserRelay(config, new Map(), reload, role, closePage);
  const socket = sockets.at(-1);
  if (!socket) throw new Error("Browser relay did not open a socket");
  socket.message({ type: "ready", label: config.label });
  socket.message({ type: "storage", entries: [] });
  return { relay, socket, reload, closePage };
}

afterEach(() => {
  sockets.length = 0;
  Reflect.deleteProperty(window, "latticeDesktop");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.stubGlobal("WebSocket", NativeWebSocket);
  localStorage.removeItem("lattice.appearance.v5");
  sessionStorage.removeItem("lattice.desktop-browser-standby");
  document.getElementById("lattice-browser-runtime-error")?.remove();
});

describe("browser bridge serialization", () => {
  it("round-trips binary command bodies across more than one base64 chunk", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);

    const decoded = decodeBridgeValue(encodeBridgeValue(bytes)) as ArrayBuffer;

    expect(new Uint8Array(decoded)).toEqual(bytes);
  });

  it("preserves binary values nested in ordinary invoke arguments", () => {
    const value = {
      path: "figures/result.png",
      payload: new Uint8Array([0, 1, 2, 253, 254, 255]).buffer,
    };

    const decoded = decodeBridgeValue(encodeBridgeValue(value)) as {
      path: string;
      payload: ArrayBuffer;
    };

    expect(decoded.path).toBe(value.path);
    expect([...new Uint8Array(decoded.payload)]).toEqual([0, 1, 2, 253, 254, 255]);
  });

  it("uses Tauri's custom IPC serializer when a value supplies one", () => {
    const value = {
      __TAURI_TO_IPC_KEY__: () => ({ Logical: { width: 1200, height: 680 } }),
    };

    expect(decodeBridgeValue(encodeBridgeValue(value))).toEqual({
      Logical: { width: 1200, height: 680 },
    });
  });
});

describe("browser bridge recovery", () => {
  it("reloads a live page when its idle WebSocket is disconnected", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { socket, reload } = connectedRelay();

    socket.disconnect();
    socket.dispatchEvent(new Event("error"));

    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads when the native half of the browser bridge restarts", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { socket, reload } = connectedRelay();

    socket.message({ type: "host-disconnected" });

    expect(reload).toHaveBeenCalledOnce();
  });

  it("shows the failure if an unsaved edit prevents the recovery reload", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { socket } = connectedRelay();

    socket.disconnect();
    vi.advanceTimersByTime(1_000);

    expect(document.getElementById("lattice-browser-runtime-error")).toHaveTextContent(
      "The local Lattice app disconnected.",
    );
  });

  it("uses only the primary system language for recovery messages", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const languages = vi.spyOn(window.navigator, "languages", "get")
      .mockReturnValue(["en-US", "zh-CN"]);
    const { socket } = connectedRelay();

    socket.disconnect();
    vi.advanceTimersByTime(1_000);

    expect(document.getElementById("lattice-browser-runtime-error")).toHaveTextContent(
      "The local Lattice app disconnected.",
    );
    languages.mockRestore();
  });

  it("does not reopen a tab that is intentionally closing", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { socket, reload } = connectedRelay();

    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    socket.disconnect();

    expect(reload).not.toHaveBeenCalled();
  });

  it("does not fight a second tab that took over the workspace", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { socket, reload } = connectedRelay();

    socket.message({ type: "browser-replaced" });
    socket.disconnect();

    expect(reload).not.toHaveBeenCalled();
    expect(document.getElementById("lattice-browser-runtime-error")).toHaveTextContent(
      "This Lattice workspace is open in another browser tab.",
    );
  });

  it("parks bundled Chromium while a browser tab is active and reloads it on return", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { socket, reload } = connectedRelay(vi.fn(), "desktop");

    expect(new URL(socket.url).searchParams.get("role")).toBe("desktop");
    socket.message({ type: "desktop-suspended" });

    expect(reload).toHaveBeenCalledOnce();
    expect(document.getElementById("lattice-browser-runtime-error")).toHaveTextContent(
      "This workspace is open in your browser. It will return here when that browser tab closes.",
    );

    reload.mockClear();
    socket.message({ type: "desktop-resumed" });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("shows the translated handoff status after the standby page reloads", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    localStorage.setItem("lattice.appearance.v5", JSON.stringify({ interfaceLanguage: "zh-CN" }));
    sessionStorage.setItem("lattice.desktop-browser-standby", "1");
    const reload = vi.fn();
    new BrowserRelay({
      token: "secret",
      bridgePort: 18_452,
      label: "browser-test",
    }, new Map(), reload, "desktop");
    const socket = sockets.at(-1);
    if (!socket) throw new Error("Browser relay did not open a socket");

    socket.message({ type: "desktop-suspended" });

    expect(reload).not.toHaveBeenCalled();
    expect(document.getElementById("lattice-browser-runtime-error")).toHaveTextContent(
      "此工作区已在浏览器中打开。关闭浏览器标签页后，它会自动返回这里。",
    );
  });

  it("reconnects a parked desktop if its standby socket is discarded", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    sessionStorage.setItem("lattice.desktop-browser-standby", "1");
    const reload = vi.fn();
    const { socket } = connectedRelay(reload, "desktop");
    socket.message({ type: "desktop-suspended" });

    socket.disconnect();

    expect(reload).toHaveBeenCalledOnce();
  });

  it("stays closed after returning the workspace to the desktop app", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { socket, reload, closePage } = connectedRelay();

    socket.message({ type: "desktop-returned" });
    socket.disconnect();

    expect(closePage).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(document.getElementById("lattice-browser-runtime-error")).toHaveTextContent(
      "This workspace is now open in the Lattice desktop app. If this tab did not close automatically, you can close it.",
    );
  });
});
