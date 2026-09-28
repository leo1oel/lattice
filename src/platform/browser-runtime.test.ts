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

  it("tracks protected file drags without consuming internal tree moves", () => {
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
  });

  it("leaves ordinary browser subscriptions on the existing relay", () => {
    const registry = new BrowserEventRegistry(vi.fn());
    expect(registry.listen("tauri://drag-drop", 1)).toBeNull();
  });
});

const config: BrowserRuntimeConfig = { token: "secret", bridgePort: 18_452, label: "browser-test" };

function connectedRelay(reload = vi.fn(), role: "browser" | "desktop" = "browser", closePage = vi.fn()) {
  const relay = new BrowserRelay(config, new Map(), reload, role, closePage);
  const socket = lastSocket();
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
  runtimeError()?.remove();
});

describe("browser bridge serialization", () => {
  const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 251);
  const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
  it.each([
    ["round-trips binary command bodies across more than one base64 chunk", bytes, bytes.buffer],
    [
      "preserves binary values nested in ordinary invoke arguments",
      { path: "figures/result.png", payload: payload.buffer },
      { path: "figures/result.png", payload: payload.buffer },
    ],
    [
      "uses Tauri's custom IPC serializer when a value supplies one",
      { __TAURI_TO_IPC_KEY__: () => ({ Logical: { width: 1200, height: 680 } }) },
      { Logical: { width: 1200, height: 680 } },
    ],
  ])("%s", (_, value, expected) => {
    expect(decodeBridgeValue(encodeBridgeValue(value))).toEqual(expected);
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
    ["stays closed after returning the workspace to the desktop app", [message("desktop-returned"), disconnect], {
      reloads: 0,
      closes: 1,
      error: "This workspace is now open in the Lattice desktop app. If this tab did not close automatically, you can close it.",
    }],
  ])("%s", (_, steps, expected: { reloads?: number; closes?: number; error?: string }) => {
    const { socket, reload, closePage } = connectedRelay();
    for (const step of steps) step(socket);
    if (expected.reloads !== undefined) expect(reload).toHaveBeenCalledTimes(expected.reloads);
    if (expected.closes !== undefined) expect(closePage).toHaveBeenCalledTimes(expected.closes);
    if (expected.error) expect(runtimeError()).toHaveTextContent(expected.error);
  });

  it("uses only the primary system language for recovery messages", () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "zh-CN"]);
    const { socket } = connectedRelay();
    disconnectedAfter(1_000)(socket);
    expect(runtimeError()).toHaveTextContent("The local Lattice app disconnected.");
  });

  it.each(["browser-replaced", "desktop-suspended"])(
    "tells embedded editors to stop accepting edits after %s",
    async (type) => {
      vi.useFakeTimers();
      vi.stubGlobal("WebSocket", FakeWebSocket);
      // Detachment is page-lifetime state, so each case needs a fresh module.
      vi.resetModules();
      const runtime = await import("./browser-runtime");
      const detached = vi.fn();
      runtime.subscribeBrowserRuntimeDetached(detached);
      new runtime.BrowserRelay(
        { token: "secret", bridgePort: 18_452, label: "browser-test" },
        new Map(),
        vi.fn(),
        type === "desktop-suspended" ? "desktop" : "browser",
      );
      const socket = sockets.at(-1)!;
      socket.message({ type: "ready", label: "browser-test" });
      socket.message({ type: "storage", entries: [] });
      expect(runtime.browserRuntimeDetached()).toBe(false);

      socket.message({ type });

      expect(runtime.browserRuntimeDetached()).toBe(true);
      expect(detached).toHaveBeenCalledOnce();
    },
  );

  it("parks bundled Chromium while a browser tab is active and reloads it on return", () => {
    const { socket, reload } = connectedRelay(vi.fn(), "desktop");

    expect(new URL(socket.url).searchParams.get("role")).toBe("desktop");
    socket.message({ type: "desktop-suspended" });

    expect(reload).toHaveBeenCalledOnce();
    expect(runtimeError()).toHaveTextContent(
      "This workspace is open in your browser. It will return here when that browser tab closes.",
    );

    reload.mockClear();
    socket.message({ type: "desktop-resumed" });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("shows the translated handoff status after the standby page reloads", () => {
    localStorage.setItem("lattice.appearance.v5", JSON.stringify({ interfaceLanguage: "zh-CN" }));
    sessionStorage.setItem("lattice.desktop-browser-standby", "1");
    const reload = vi.fn();
    new BrowserRelay(config, new Map(), reload, "desktop");

    lastSocket().message({ type: "desktop-suspended" });

    expect(reload).not.toHaveBeenCalled();
    expect(runtimeError()).toHaveTextContent(
      "此工作区已在浏览器中打开。关闭浏览器标签页后，它会自动返回这里。",
    );
  });

  it("reconnects a parked desktop if its standby socket is discarded", () => {
    sessionStorage.setItem("lattice.desktop-browser-standby", "1");
    const { socket, reload } = connectedRelay(vi.fn(), "desktop");
    socket.message({ type: "desktop-suspended" });

    socket.disconnect();

    expect(reload).toHaveBeenCalledOnce();
  });
});
