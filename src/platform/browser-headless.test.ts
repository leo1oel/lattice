import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { encodeBridgeValue } from "./browser-bridge-value";
import { FakeWebSocket, lastSocket, sockets } from "./fake-websocket";

type Invoke = (command: string, args?: unknown) => Promise<unknown>;
type TabWindow = Record<"__TAURI_INTERNALS__" | "__LATTICE_BROWSER_RUNTIME__" | "isTauri", unknown>;

const STORAGE_METHODS = ["setItem", "removeItem", "clear"] as const;
const storage = Object.fromEntries(STORAGE_METHODS.map((method) => [method, Storage.prototype[method]]));

/**
 * Load the page as a tab of a running host whose session reply is `reply`,
 * through the real runtime and relay, and return its Tauri `invoke`.
 */
async function loadTab(reply: Record<string, unknown>) {
  sessionStorage.setItem("lattice.browser-token", "token-a");
  sessionStorage.setItem("lattice.browser-port", "18452");
  sessionStorage.setItem("lattice.browser-label", "browser-a");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ token: "token-a", bridgePort: 18452, label: "browser-a", ...reply })));
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.resetModules();
  const runtime = await import("./browser-runtime");
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = lastSocket();
  socket.message({ type: "ready", label: "browser-a" });
  socket.message({ type: "storage", entries: [] });
  await runtime.browserRuntimeReady();
  const invoke = ((window as unknown as TabWindow).__TAURI_INTERNALS__ as { invoke: Invoke }).invoke;
  return { socket, invoke };
}

/** The commands the tab relayed to the host. */
const relayed = (socket: FakeWebSocket) => socket.send.mock.calls
  .map(([message]) => JSON.parse(String(message)) as { type: string; id: number; command?: string })
  .filter((message) => message.type === "invoke");

/** Invoke `command`, and have the host answer it with `value`. */
async function answered(socket: FakeWebSocket, invoke: Invoke, command: string, value: unknown) {
  const reply = invoke(command, { path: "/projects/b" });
  await vi.waitFor(() => expect(relayed(socket).at(-1)?.command).toBe(command));
  socket.message({ type: "response", id: relayed(socket).at(-1)!.id, ok: true, value: encodeBridgeValue(value) });
  return reply;
}

let open: MockInstance<typeof window.open>;

beforeEach(() => {
  open = vi.spyOn(window, "open").mockReturnValue({ opener: window } as unknown as Window);
});

afterEach(() => {
  sockets.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  Object.assign(Storage.prototype, storage);
  for (const key of ["__TAURI_INTERNALS__", "__LATTICE_BROWSER_RUNTIME__", "isTauri"] as const) {
    delete (window as unknown as Partial<TabWindow>)[key];
  }
});

describe("a tab of a host with a desktop", () => {
  it("relays links and folders to the host, as before", async () => {
    const { socket, invoke } = await loadTab({});
    void invoke("plugin:opener|open_url", { url: "https://example.org/" });
    void invoke("plugin:opener|reveal_item_in_dir", { path: "/projects/b" });
    await vi.waitFor(() => expect(relayed(socket)).toHaveLength(2));
    expect(relayed(socket).map(({ command }) => command)).toEqual(["plugin:opener|open_url", "plugin:opener|reveal_item_in_dir"]);
    expect(open).not.toHaveBeenCalled();
    expect((await import("./headless-host")).isHeadlessHost()).toBe(false);
  });
});

describe("a tab of a headless host", () => {
  it("knows it keeps every project in this tab", async () => {
    await loadTab({ headless: true });
    expect((await import("./headless-host")).isHeadlessHost()).toBe(true);
  });

  it("opens web links in this browser, without relaying them to the host", async () => {
    const { socket, invoke } = await loadTab({ headless: true });
    await invoke("plugin:opener|open_url", { url: "https://example.org/paper" });
    expect(open).toHaveBeenCalledWith("https://example.org/paper", "_blank", "noopener,noreferrer");
    await expect(invoke("plugin:opener|open_url", { url: "javascript:alert(1)" }))
      .rejects.toThrow("Lattice opens only web, email and phone links.");
    expect(open).toHaveBeenCalledOnce();
    expect(relayed(socket)).toEqual([]);
  });

  it.each(["plugin:opener|open_path", "plugin:opener|reveal_item_in_dir"])("refuses %s, which would open the host's desktop", async (command) => {
    const { socket, invoke } = await loadTab({ headless: true });
    await expect(invoke(command, { path: "/projects/b" }))
      .rejects.toThrow("This Lattice runs without a desktop, so it cannot open apps or folders on its computer.");
    expect(relayed(socket)).toEqual([]);
  });

  it("relays everything else to the host, project opening included", async () => {
    const { socket, invoke } = await loadTab({ headless: true });
    const reply = { label: "browser-a", focusedExisting: false, openHere: true };
    await expect(answered(socket, invoke, "open_project_window", reply)).resolves.toEqual(reply);
    expect(open).not.toHaveBeenCalled();
  });
});
