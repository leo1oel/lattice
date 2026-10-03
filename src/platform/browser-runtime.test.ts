import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket, lastSocket, sockets } from "./fake-websocket";
import {
  BrowserRelay,
  BrowserEventRegistry,
  decodeBridgeValue,
  encodeBridgeValue,
  setWorkspaceYieldHandler,
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
    // The paper drop bridge subscribes before App's importer, and ignores file paths.
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

function connectedRelay(
  reload = vi.fn(), role: "browser" | "desktop" = "browser", { closePage = vi.fn(), appRunning = true } = {},
) {
  const relay = new BrowserRelay(config, new Map(), reload, role, closePage, async () => appRunning);
  const socket = lastSocket();
  socket.message({ type: "ready", label: config.label });
  socket.message({ type: "storage", entries: [] });
  return { relay, socket, reload, closePage };
}

/** The control messages a page sent the server (not relayed invokes). */
const controls = (socket: FakeWebSocket) => socket.send.mock.calls
  .map(([data]) => JSON.parse(data as string) as { type: string })
  .filter((message) => ["yielded", "yield-failed", "reclaim"].includes(message.type))
  .map((message) => message.type);

afterEach(() => {
  sockets.length = 0;
  Reflect.deleteProperty(window, "latticeDesktop");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.stubGlobal("WebSocket", NativeWebSocket);
  localStorage.removeItem("lattice.appearance.v5");
  sessionStorage.removeItem("lattice.desktop-browser-standby");
  setWorkspaceYieldHandler(null);
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
  const disconnectedAfter = (ms: number) => async (socket: FakeWebSocket) => {
    socket.disconnect();
    await vi.advanceTimersByTimeAsync(ms);
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
  ])("%s", async (_, steps, expected: { reloads?: number; error?: string }) => {
    const { socket, reload } = connectedRelay();
    for (const step of steps) await step(socket);
    await vi.advanceTimersByTimeAsync(0);
    if (expected.reloads !== undefined) expect(reload).toHaveBeenCalledTimes(expected.reloads);
    if (expected.error) expect(runtimeError()).toHaveTextContent(expected.error);
  });

  it("uses only the primary system language for recovery messages", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "zh-CN"]);
    const { socket } = connectedRelay();
    await disconnectedAfter(1_000)(socket);
    expect(runtimeError()).toHaveTextContent("The local Lattice app disconnected.");
  });

  it("offers a reload instead of reloading into a connection error once Lattice has quit", async () => {
    const { socket, reload } = connectedRelay(vi.fn(), "browser", { appRunning: false });
    socket.message({ type: "host-disconnected" });
    socket.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).not.toHaveBeenCalled();
    expect(runtimeError()).toHaveTextContent("Lattice quit. Open it again, then reload this tab.");
    fireEvent.click(within(runtimeError()!).getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledOnce();
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

describe("moving a workspace between the Lattice window and the browser", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  it("saves before yielding the workspace to the other surface", async () => {
    const save = deferred();
    const handler = vi.fn(() => save.promise);
    setWorkspaceYieldHandler(handler);
    const { socket } = connectedRelay(vi.fn(), "desktop");

    socket.message({ type: "yield" });
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledOnce();
    expect(controls(socket)).toEqual([]);
    save.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(controls(socket)).toEqual(["yielded"]);
  });

  // The handler is false for a failed save, an unfinished IME composition and
  // an edit typed while the save ran (see saveEveryEdit); none may hand over.
  describe.each(["desktop", "browser"] as const)("a %s page asked to yield", (role) => {
    it.each([
      ["could not save", () => Promise.resolve(false)],
      ["failed with an error", () => Promise.reject(new Error("disk full"))],
    ])("keeps the workspace when its save %s", async (_, handler) => {
      setWorkspaceYieldHandler(handler);
      const { socket, reload, closePage } = connectedRelay(vi.fn(), role);
      socket.message({ type: "yield" });
      await vi.advanceTimersByTimeAsync(0);
      expect(controls(socket)).toEqual(["yield-failed"]);
      expect(reload).not.toHaveBeenCalled();
      expect(closePage).not.toHaveBeenCalled();
      expect(runtimeError()).toBeNull();
    });

    it("answers only once a slow save has finished", async () => {
      const save = deferred();
      setWorkspaceYieldHandler(() => save.promise);
      const { socket } = connectedRelay(vi.fn(), role);
      socket.message({ type: "yield" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(controls(socket)).toEqual([]);
      save.resolve(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(controls(socket)).toEqual(["yield-failed"]);
    });
  });

  it("offers a waiting tab to try again when the Lattice window kept the workspace", async () => {
    const reload = vi.fn();
    new BrowserRelay(config, new Map(), reload, "browser");
    const socket = lastSocket();
    socket.message({ type: "handoff-refused" });
    expect(runtimeError()).toHaveTextContent("The Lattice window kept this workspace");
    expect(runtimeError()).toHaveTextContent("It could not save every edit. Save there, then try again.");
    expect(socket.close).toHaveBeenCalled();
    // The tab's own handoff deadline must not replace that choice.
    await vi.advanceTimersByTimeAsync(20_000);
    fireEvent.click(within(runtimeError()!).getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("lets a waiting Lattice window ask again when the tab kept the workspace", () => {
    sessionStorage.setItem("lattice.desktop-browser-standby", "1");
    const { socket } = connectedRelay(vi.fn(), "desktop");
    socket.message({ type: "desktop-suspended" });
    fireEvent.click(within(runtimeError()!).getByRole("button", { name: "Use here" }));

    socket.message({ type: "handoff-refused" });
    expect(runtimeError()).toHaveTextContent("The browser tab could not save every edit, so it kept the workspace.");
    fireEvent.click(within(runtimeError()!).getByRole("button", { name: "Use here" }));
    expect(controls(socket)).toEqual(["reclaim", "reclaim"]);
  });

  it("parks the Lattice window on a standby screen that can take the workspace back", () => {
    const { socket, reload } = connectedRelay(vi.fn(), "desktop");
    expect(new URL(socket.url).searchParams.get("role")).toBe("desktop");

    socket.message({ type: "desktop-suspended" });
    // One reload, so nothing of the workspace keeps running behind the screen.
    expect(reload).toHaveBeenCalledOnce();
    expect(runtimeError()).toHaveTextContent("This workspace is open in your browser");
    expect(runtimeError()).toHaveTextContent("Close the tab to bring it back here.");
    fireEvent.click(within(runtimeError()!).getByRole("button", { name: "Use here" }));
    expect(controls(socket)).toEqual(["reclaim"]);
    expect(within(runtimeError()!).getByRole("button", { name: "Switching…" })).toBeDisabled();

    reload.mockClear();
    socket.message({ type: "desktop-resumed" });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("shows the translated standby screen after its reload, without reloading again", () => {
    localStorage.setItem("lattice.appearance.v5", JSON.stringify({ interfaceLanguage: "zh-CN" }));
    sessionStorage.setItem("lattice.desktop-browser-standby", "1");
    const reload = vi.fn();
    new BrowserRelay(config, new Map(), reload, "desktop");

    lastSocket().message({ type: "desktop-suspended" });

    expect(reload).not.toHaveBeenCalled();
    expect(runtimeError()).toHaveTextContent("此工作区正在浏览器中使用");
    expect(within(runtimeError()!).getByRole("button", { name: "在这里使用" })).toBeEnabled();
  });

  it("reconnects a parked window if its standby socket is dropped", () => {
    sessionStorage.setItem("lattice.desktop-browser-standby", "1");
    const { socket, reload } = connectedRelay(vi.fn(), "desktop");
    socket.message({ type: "desktop-suspended" });
    socket.disconnect();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("closes the tab, or says it can be closed, once the Lattice app has the workspace back", async () => {
    const { socket, reload, closePage } = connectedRelay();
    socket.message({ type: "desktop-returned" });
    socket.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(closePage).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(runtimeError()).toHaveTextContent("Back in the Lattice app. You can close this tab.");
  });
});

function deferred() {
  let resolve!: (saved: boolean) => void;
  const promise = new Promise<boolean>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("opening a workspace from an entry address", () => {
  const entryUrl = "/?entry=nonce-b";
  let requests: URL[];

  beforeEach(() => {
    requests = [];
    // A tab that already holds project A.
    sessionStorage.setItem("lattice.browser-token", "token-a");
    sessionStorage.setItem("lattice.browser-port", "18452");
    sessionStorage.setItem("lattice.browser-label", "browser-a");
    window.history.replaceState(null, "", entryUrl);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      requests.push(new URL(String(input)));
      return new Response("", { status: 410 });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  async function loadPage() {
    vi.resetModules();
    const runtime = await import("./browser-runtime");
    return runtime.browserRuntimeReady();
  }

  it("asks for the entry's workspace rather than the one the tab stored", async () => {
    await loadPage().catch(() => undefined);
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get("entry")).toBe("nonce-b");
    expect(requests[0].searchParams.has("token")).toBe(false);
  });

  it("explains a used or expired entry and keeps the tab's own session and address", async () => {
    await expect(loadPage()).rejects.toThrow("This Lattice link has expired or was already used.");
    expect(sessionStorage.getItem("lattice.browser-token")).toBe("token-a");
    expect(window.location.search).toBe("?entry=nonce-b");
  });
});
