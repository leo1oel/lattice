import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, lastSocket, sockets } from "./fake-websocket";
import {
  BrowserRelay,
  BrowserEventRegistry,
  decodeBridgeValue,
  encodeBridgeValue,
  type BrowserRuntimeConfig,
} from "./browser-runtime";

const NativeWebSocket = globalThis.WebSocket;
const runtimeError = () => document.getElementById("lattice-browser-runtime-error");

function dragEvent(type: string, types: string[], files: File[], init: MouseEventInit = {}) {
  const event = new MouseEvent(type, { cancelable: true, ...init });
  Object.defineProperty(event, "dataTransfer", { value: { types, files } });
  return event;
}

describe("Chromium file drops", () => {
  it("delivers Finder drops to every subscriber while blocking downstream DOM importers", () => {
    const callback = vi.fn();
    const registry = new BrowserEventRegistry(callback);
    Object.assign(window, { latticeDesktop: { getPathForFile: () => "/tmp/notes.md" } });
    // Paper lookup subscribes before App's importer, and ignores file paths.
    const paperId = registry.listen("tauri://drag-drop", 11)!;
    const projectId = registry.listen("tauri://drag-drop", 22)!;
    const target = document.createElement("div");
    document.body.append(target);
    const domImporter = vi.fn();
    target.addEventListener("drop", domImporter);
    const drop = dragEvent("drop", ["Files"], [new File(["notes"], "notes.md")], { bubbles: true });
    try {
      target.dispatchEvent(drop);
      expect(callback.mock.calls.map(([id]) => id)).toEqual([11, 22]);
      expect(callback).toHaveBeenLastCalledWith(22, {
        event: "tauri://drag-drop", id: projectId,
        payload: { paths: ["/tmp/notes.md"], position: { x: 0, y: 0 } },
      });
      expect(domImporter).not.toHaveBeenCalled();
      expect(drop.defaultPrevented).toBe(true);
      registry.unregister("tauri://drag-drop", paperId, vi.fn());
      callback.mockClear();
      target.dispatchEvent(drop);
      expect(callback.mock.calls.map(([id]) => id)).toEqual([22]);
    } finally {
      registry.unregister("tauri://drag-drop", paperId, vi.fn());
      registry.unregister("tauri://drag-drop", projectId, vi.fn());
      target.remove();
      Reflect.deleteProperty(window, "latticeDesktop");
    }
  });

  it("routes a dropped SVG locally with physical coordinates and cleans up", () => {
    const callback = vi.fn();
    const registry = new BrowserEventRegistry(callback);
    const file = new File(["<svg/>"], "plot.svg", { type: "image/svg+xml" });
    Object.assign(window, { latticeDesktop: { getPathForFile: () => "/tmp/plot.svg" } });
    vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
    const id = registry.listen("tauri://drag-drop", 73);
    expect(id).not.toBeNull();
    const drop = dragEvent("drop", ["Files"], [file], { clientX: 135, clientY: 247 });
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
  });

  it("tracks protected file drags without consuming internal tree moves or taking ordinary subscriptions", () => {
    const callback = vi.fn();
    const registry = new BrowserEventRegistry(callback);
    Object.assign(window, { latticeDesktop: { getPathForFile: vi.fn() } });
    for (const [name, domName] of [["enter", "dragenter"], ["over", "dragover"], ["leave", "dragleave"]]) {
      const event = `tauri://drag-${name}`;
      const id = registry.listen(event, 19)!;
      const drag = dragEvent(domName, ["Files"], [], { clientX: 40, clientY: 90 });
      window.dispatchEvent(drag);
      expect(drag.defaultPrevented).toBe(true);
      expect(callback).toHaveBeenLastCalledWith(19, {
        event, id, payload: { paths: [], position: { x: 40, y: 90 } },
      });
      callback.mockClear();
      const internal = dragEvent(domName, ["text/plain"], []);
      window.dispatchEvent(internal);
      expect(internal.defaultPrevented).toBe(false);
      expect(callback).not.toHaveBeenCalled();
      registry.unregister(event, id, vi.fn());
    }
    // Without the desktop file bridge, subscriptions stay on the existing relay.
    Reflect.deleteProperty(window, "latticeDesktop");
    expect(new BrowserEventRegistry(vi.fn()).listen("tauri://drag-drop", 1)).toBeNull();
  });
});

const config: BrowserRuntimeConfig = { token: "secret", bridgePort: 18_452, label: "browser-test" };

function connectedRelay(reload = vi.fn(), role: "browser" | "desktop" = "browser") {
  const relay = new BrowserRelay(config, new Map(), reload, role);
  const socket = lastSocket();
  socket.message({ type: "ready", label: config.label });
  socket.message({ type: "storage", entries: [] });
  return { relay, socket, reload };
}

afterEach(() => {
  sockets.length = 0;
  Reflect.deleteProperty(window, "latticeDesktop");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.stubGlobal("WebSocket", NativeWebSocket);
  localStorage.removeItem("lattice.appearance.v5");
  sessionStorage.removeItem("lattice.desktop-browser-standby");
  runtimeError()?.remove();
});

describe("browser bridge serialization", () => {
  const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);
  const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
  it.each([
    [
      "round-trips binary command bodies across more than one base64 chunk",
      bytes,
      (decoded: ArrayBuffer) => new Uint8Array(decoded),
      bytes,
    ],
    [
      "preserves binary values nested in ordinary invoke arguments",
      { path: "figures/result.png", payload: payload.buffer },
      (decoded: { path: string; payload: ArrayBuffer }) => ({ ...decoded, payload: new Uint8Array(decoded.payload) }),
      { path: "figures/result.png", payload },
    ],
    [
      "uses Tauri's custom IPC serializer when a value supplies one",
      { __TAURI_TO_IPC_KEY__: () => ({ Logical: { width: 1200, height: 680 } }) },
      (decoded: unknown) => decoded,
      { Logical: { width: 1200, height: 680 } },
    ],
  ] as [string, unknown, (decoded: never) => unknown, unknown][])("%s", (_, value, view, expected) => {
    expect(view(decodeBridgeValue(encodeBridgeValue(value)) as never)).toStrictEqual(expected);
  });
});

describe("browser bridge recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  const message = (type: string) => (socket: FakeWebSocket) => socket.message({ type });
  const disconnect = (socket: FakeWebSocket) => socket.disconnect();
  const disconnectedAfter = (ms: number) => (socket: FakeWebSocket) => {
    socket.disconnect();
    vi.advanceTimersByTime(ms);
  };
  it.each([
    ["reloads a live page when its idle WebSocket is disconnected", [disconnect, (socket: FakeWebSocket) => {
      socket.dispatchEvent(new Event("error"));
    }], { reloads: 1 }],
    ["reloads when the native half of the browser bridge restarts", [message("host-disconnected")], { reloads: 1 }],
    ["shows the failure if an unsaved edit prevents the recovery reload", [disconnectedAfter(1_000)], {
      error: "The local Lattice app disconnected.",
    }],
    ["does not reopen a tab that is intentionally closing", [() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
    }, disconnect], { reloads: 0 }],
    ["does not fight a second tab that took over the workspace", [message("browser-replaced"), disconnect], {
      reloads: 0,
      error: "This Lattice workspace is open in another browser tab.",
    }],
  ])("%s", (_, steps, expected: { reloads?: number; error?: string }) => {
    const { socket, reload } = connectedRelay();
    for (const step of steps) step(socket);
    if (expected.reloads !== undefined) expect(reload).toHaveBeenCalledTimes(expected.reloads);
    if (expected.error) expect(runtimeError()).toHaveTextContent(expected.error);
  });

  it("uses only the primary system language for recovery messages", () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "zh-CN"]);
    const { socket } = connectedRelay();
    disconnectedAfter(1_000)(socket);
    expect(runtimeError()).toHaveTextContent("The local Lattice app disconnected.");
  });

  it("tells embedded editors to stop accepting edits after another tab takes over", async () => {
    // Detachment is page-lifetime state, so each case needs a fresh module.
    vi.resetModules();
    const runtime = await import("./browser-runtime");
    const detached = vi.fn();
    runtime.subscribeBrowserRuntimeDetached(detached);
    new runtime.BrowserRelay(config, new Map(), vi.fn(), "browser");
    const socket = sockets.at(-1)!;
    socket.message({ type: "ready", label: "browser-test" });
    socket.message({ type: "storage", entries: [] });
    expect(runtime.browserRuntimeDetached()).toBe(false);
    socket.message({ type: "browser-replaced" });
    expect(runtime.browserRuntimeDetached()).toBe(true);
    expect(detached).toHaveBeenCalledOnce();
  });
});

