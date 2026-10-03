import { fireEvent, within } from "@testing-library/react";
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

it("leaves file drags to the native host's own subscriptions", () => {
  // Tab-local events are the window's own; a browser tab cannot see the
  // dropped files' paths, so the bridge relays drag subscriptions instead.
  const registry = new BrowserEventRegistry(vi.fn());
  expect(registry.listen("tauri://drag-drop", 1)).toBeNull();
  expect(registry.listen("tauri://resize", 2)).not.toBeNull();
});

const config: BrowserRuntimeConfig = { token: "secret", bridgePort: 18_452, label: "browser-test" };

function connectedRelay(reload = vi.fn(), { closePage = vi.fn(), appRunning = true } = {}) {
  const relay = new BrowserRelay(config, new Map(), reload, closePage, async () => appRunning);
  const socket = lastSocket();
  socket.message({ type: "ready", label: config.label });
  socket.message({ type: "storage", entries: [] });
  return { relay, socket, reload, closePage };
}

afterEach(() => {
  sockets.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.stubGlobal("WebSocket", NativeWebSocket);
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
    const { socket, reload } = connectedRelay(vi.fn(), { appRunning: false });
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
    new runtime.BrowserRelay(config, new Map(), vi.fn());
    const socket = sockets.at(-1)!;
    socket.message({ type: "ready", label: "browser-test" });
    socket.message({ type: "storage", entries: [] });
    expect(runtime.browserRuntimeDetached()).toBe(false);
    socket.message({ type: "browser-replaced" });
    expect(runtime.browserRuntimeDetached()).toBe(true);
    expect(detached).toHaveBeenCalledOnce();
  });
});

describe("returning a workspace to the Lattice app", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
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
