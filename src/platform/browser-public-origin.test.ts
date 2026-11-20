// @vitest-environment-options {"url": "https://lattice.example/"}
// The page a reverse proxy serves at an origin Lattice was started with
// (`--browser-public-origin`): the host's own page, at another origin.
import { afterEach, expect, it, vi } from "vitest";
import { FakeWebSocket, lastSocket, sockets } from "./fake-websocket";

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  sockets.length = 0;
});

function loadPage(fetchMock: (input: string | URL) => Promise<Response>) {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn(fetchMock));
  vi.resetModules();
  return import("./browser-runtime");
}

const requested = (call: number) => String(vi.mocked(fetch).mock.calls[call]![0]);

// First: once a page installs the runtime it stays installed, so a later
// import in this file would not start again.
it("shows the host's refusal of an origin it was not started with, and opens no bridge", async () => {
  const runtime = await loadPage(async () => new Response("", { status: 403 }));
  await expect(runtime.browserRuntimeReady()).rejects.toThrow("The local Lattice entry returned 403.");
  expect(requested(0)).toBe("https://lattice.example/__lattice_session");
  expect(sockets).toHaveLength(0);
  expect(sessionStorage.getItem("lattice.browser-token")).toBeNull();
});

it("reaches the host through its own origin, wss: under https, and never the loopback address", async () => {
  const runtime = await loadPage(async () => Response.json({
    token: "session-secret", bridgePort: 18452, label: "browser-test",
  }));
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  // The page at the proxy's origin is the host's fixed entry.
  expect(requested(0)).toBe("https://lattice.example/__lattice_session");
  expect(lastSocket().url).toBe("wss://lattice.example/__lattice_bridge?token=session-secret&role=browser");
  lastSocket().message({ type: "ready", label: "browser-test" });
  lastSocket().message({ type: "storage", entries: [] });
  await runtime.browserRuntimeReady();
  expect(runtime.isBrowserHosted()).toBe(true);

  vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array([37, 80])));
  await runtime.readBrowserHostAsset({ path: "main.pdf", version: "v1", start: 0, end: 2 });
  expect(requested(1)).toBe("https://lattice.example/__lattice_asset?path=main.pdf&version=v1&start=0&end=2");
  expect(vi.mocked(fetch).mock.calls[1]![1]).toMatchObject({ headers: { "x-lattice-session": "session-secret" } });
  for (const call of vi.mocked(fetch).mock.calls) expect(String(call[0])).not.toContain("127.0.0.1");
});
