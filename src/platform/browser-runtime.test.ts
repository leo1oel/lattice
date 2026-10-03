import { fireEvent, renderHook, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAppCommands } from "../app/use-app-commands";
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

  it("covers the app as a modal: the app is inert and focus moves to the screen's action", async () => {
    const { app, editor } = focusedApp();
    const { socket } = connectedRelay(vi.fn(), { appRunning: false });
    socket.message({ type: "host-disconnected" });
    socket.disconnect();
    await vi.advanceTimersByTimeAsync(0);

    const screen = within(document.body).getByRole("alertdialog", {
      name: "Lattice quit. Open it again, then reload this tab.",
    });
    expect(screen).toHaveAttribute("aria-modal", "true");
    expect(app).toHaveAttribute("inert");
    expect(screen).not.toHaveAttribute("inert");
    expect(document.activeElement).toBe(within(screen).getByRole("button", { name: "Reload" }));
    expect(document.activeElement).not.toBe(editor);

    // Whatever the app adds to the page later stays behind the screen too.
    const later = document.createElement("div");
    document.body.append(later);
    await Promise.resolve();
    expect(later).toHaveAttribute("inert");
    later.remove();
  });

  it("focuses a screen without an action itself", () => {
    const { editor } = focusedApp();
    const { socket } = connectedRelay();
    socket.message({ type: "browser-replaced" });
    expect(document.activeElement).toBe(runtimeError());
    expect(document.activeElement).not.toBe(editor);
  });

  it("keeps the app's shortcuts and key handlers from running behind the screen", async () => {
    const openSettings = vi.fn();
    const save = vi.fn();
    // The app's real shortcut dispatcher, and a dialog's capture-phase Escape.
    renderHook(() => useAppCommands([
      { id: "settings", key: ",", run: openSettings },
      { id: "save", key: "s", run: save },
    ], vi.fn()));
    const closeDialog = vi.fn();
    document.addEventListener("keydown", closeDialog, { capture: true });
    onTestFinished(() => document.removeEventListener("keydown", closeDialog, { capture: true }));

    // Before a failure, a shortcut runs as usual.
    focusedApp();
    fireEvent.keyDown(document.activeElement!, { key: ",", metaKey: true });
    expect(openSettings).toHaveBeenCalledOnce();

    const { socket, reload } = connectedRelay(vi.fn(), { appRunning: false });
    socket.message({ type: "host-disconnected" });
    socket.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    const reloadButton = within(runtimeError()!).getByRole("button", { name: "Reload" });
    expect(document.activeElement).toBe(reloadButton);
    closeDialog.mockClear();
    for (const key of [",", "s", "p"]) {
      fireEvent.keyDown(reloadButton, { key, metaKey: true });
      fireEvent.keyDown(reloadButton, { key, ctrlKey: true });
    }
    fireEvent.keyDown(reloadButton, { key: "Escape" });
    expect(openSettings).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(closeDialog).not.toHaveBeenCalled();
    // Keys still do the button's own default work: Enter is not cancelled.
    expect(fireEvent.keyDown(reloadButton, { key: "Enter" })).toBe(true);
    fireEvent.click(reloadButton);
    expect(reload).toHaveBeenCalledOnce();

    // Once the screen is gone, the app has its keys back.
    runtimeError()!.remove();
    await Promise.resolve();
    fireEvent.keyDown(document.body, { key: ",", metaKey: true });
    expect(openSettings).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["with an action", (socket: FakeWebSocket) => {
      socket.message({ type: "host-disconnected" });
      socket.disconnect();
    }, () => within(runtimeError()!).getByRole("button", { name: "Reload" })],
    ["without an action", (socket: FakeWebSocket) => socket.message({ type: "browser-replaced" }), runtimeError],
  ])("keeps Tab and Shift+Tab on a screen %s", async (_, fail, focusStop) => {
    const { editor } = focusedApp();
    const { socket } = connectedRelay(vi.fn(), { appRunning: false });
    fail(socket);
    await vi.advanceTimersByTimeAsync(0);
    const stop = focusStop()!;
    for (const shiftKey of [false, true]) {
      // Wherever focus has got to, Tab brings it back to the screen.
      editor.focus();
      expect(fireEvent.keyDown(editor, { key: "Tab", shiftKey })).toBe(false);
      expect(document.activeElement).toBe(stop);
      expect(fireEvent.keyDown(stop, { key: "Tab", shiftKey })).toBe(false);
      expect(document.activeElement).toBe(stop);
    }
  });

  it.each([
    ["dark", "light", "dark"],
    ["light", "dark", "light"],
  ])("draws a status in the app's %s theme on a %s system", (preference, system, expected) => {
    // Before React has applied the saved preference, as for a bootstrap failure.
    delete document.documentElement.dataset.theme;
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: system === "dark" && query === "(prefers-color-scheme: dark)",
    }) as MediaQueryList);
    const { socket } = connectedRelay();
    // The host mirrors the app's storage into the page on connect.
    localStorage.setItem("lattice.theme-preference.v1", preference);
    socket.message({ type: "browser-replaced" });
    expect(document.documentElement.dataset.theme).toBe(expected);
    const style = runtimeError()!.style;
    expect(style.getPropertyValue("color-scheme")).toBe(expected);
    expect(style.background).toContain("var(--surface-app");
    expect(style.color).toContain("var(--text-primary");
    delete document.documentElement.dataset.theme;
    localStorage.removeItem("lattice.theme-preference.v1");
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

/** An app root with a focused editor in it, removed after the test. */
function focusedApp() {
  const app = document.createElement("div");
  const editor = document.createElement("textarea");
  app.append(editor);
  document.body.append(app);
  editor.focus();
  onTestFinished(() => app.remove());
  return { app, editor };
}

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

  it("treats an empty entry as a stale link rather than resuming the tab's stored workspace", async () => {
    window.history.replaceState(null, "", "/?entry=");
    await expect(loadPage()).rejects.toThrow("This Lattice link has expired or was already used.");
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get("entry")).toBe("");
    expect(requests[0].searchParams.has("token")).toBe(false);
    expect(sessionStorage.getItem("lattice.browser-token")).toBe("token-a");
    expect(window.location.search).toBe("?entry=");
  });

  it("explains a used or expired entry and keeps the tab's own session and address", async () => {
    await expect(loadPage()).rejects.toThrow("This Lattice link has expired or was already used.");
    expect(sessionStorage.getItem("lattice.browser-token")).toBe("token-a");
    expect(window.location.search).toBe("?entry=nonce-b");
  });
});
