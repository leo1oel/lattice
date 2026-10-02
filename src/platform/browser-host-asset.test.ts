import { afterEach, expect, it, vi } from "vitest";
import { FakeWebSocket, lastSocket } from "./fake-websocket";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reads project PDF ranges from the browser host with the session token in a header, never in the URL", async () => {
  // Installing the runtime is page-lifetime state: this file installs it once.
  vi.stubGlobal("WebSocket", FakeWebSocket);
  window.history.replaceState(null, "", "/#token=session-secret&bridgePort=18452&label=browser-test");
  const runtime = await import("./browser-runtime");
  lastSocket().message({ type: "ready", label: "browser-test" });
  lastSocket().message({ type: "storage", entries: [] });
  await runtime.browserRuntimeReady();
  expect(runtime.isBrowserHosted()).toBe(true);

  const fetchRange = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(new Uint8Array([37, 80])));
  const bytes = await runtime.readBrowserHostAsset({ path: "figures/scan.pdf", version: "v1", start: 0, end: 2 });
  expect(new Uint8Array(bytes)).toEqual(new Uint8Array([37, 80]));
  const [url, init] = fetchRange.mock.calls[0]!;
  expect(String(url)).toBe("http://127.0.0.1:18452/__lattice_asset?path=figures%2Fscan.pdf&version=v1&start=0&end=2");
  expect(String(url)).not.toContain("session-secret");
  expect(init).toMatchObject({ cache: "no-store", headers: { "x-lattice-session": "session-secret" } });

  // The host's refusal is the reader's error.
  fetchRange.mockResolvedValueOnce(new Response("This PDF changed on disk.", { status: 422 }));
  await expect(runtime.readBrowserHostAsset({ path: "figures/scan.pdf", version: "v1", start: 0, end: 2 }))
    .rejects.toThrow("This PDF changed on disk.");
});
