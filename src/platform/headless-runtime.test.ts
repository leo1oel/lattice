import { invoke, convertFileSrc, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installHeadlessRuntime, serverRequest } from "./headless-runtime";

class ServerEvents extends EventTarget {
  static current: ServerEvents;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();
  readyState = 1;
  constructor(public url: string) { super(); ServerEvents.current = this; }
}
const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});
function install() {
  vi.stubGlobal("EventSource", ServerEvents);
  disposers.push(installHeadlessRuntime({ headless: true, authenticated: true }));
}
describe("the real Tauri consumers on a headless server", () => {
  it("writes a file through same-origin session-authenticated HTTP without exposing a token", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: { saved: true } })));
    vi.stubGlobal("fetch", fetch);
    install();
    await expect(invoke("write_project_file", { path: "main.tex", content: "new" })).resolves.toEqual({ saved: true });
    expect(fetch).toHaveBeenCalledWith("/api/invoke", expect.objectContaining({
      credentials: "same-origin", cache: "no-store",
      body: JSON.stringify({ command: "write_project_file", args: { path: "main.tex", content: "new" } }),
    }));
    const client = new URL(ServerEvents.current.url, "https://server.example").searchParams.get("client");
    expect(client).toBeTruthy();
    expect(fetch.mock.calls[0][1].headers["X-Lattice-Client"]).toBe(client);
    expect(convertFileSrc("figures/plot 1.png")).toBe(`/api/asset?path=figures%2Fplot+1.png&client=${client}`);
  });
  it("delivers server build events to listen(), then removes the callback on unlisten", async () => {
    install();
    const callback = vi.fn();
    const unlisten = await listen("build-progress", callback);
    ServerEvents.current.onmessage?.({ data: JSON.stringify({ event: "build-progress", payload: { elapsedMs: 12 } }) });
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ event: "build-progress", payload: { elapsedMs: 12 } }));
    unlisten();
    ServerEvents.current.onmessage?.({ data: JSON.stringify({ event: "build-progress", payload: {} }) });
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it("surfaces server errors and does not turn unsupported operations into success", async () => {
    install();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "unsupported_command", message: "terminal unavailable" } }), { status: 400 })));
    await expect(invoke("terminal_spawn")).rejects.toThrow("terminal unavailable");
  });
  it("routes owner-filtered server callbacks through real Tauri channels", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: null })));
    vi.stubGlobal("fetch", fetch);
    install();
    const channel = new Channel<unknown>();
    const output = vi.fn();
    channel.onmessage = output;
    await invoke("terminal_attach", { onOutput: channel });
    const request = JSON.parse(fetch.mock.calls[0][1].body);
    expect(request.args.onOutput).toMatch(/^__CHANNEL__:\d+$/);
    const id = Number(request.args.onOutput.split(":")[1]);
    // Channel internally expects its ordered-message envelope.
    ServerEvents.current.onmessage?.({ data: JSON.stringify({ callback: id, payload: { message: { __latticeBridgeBinary: "aGk=" }, index: 0 } }) });
    expect(new Uint8Array(output.mock.calls[0][0])).toEqual(Uint8Array.from([104, 105]));
  });
  it("waits for SSE before starting a terminal so its first channel message cannot be lost", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: null })));
    vi.stubGlobal("fetch", fetch);
    install();
    ServerEvents.current.readyState = 0;
    const opening = invoke("terminal_open", {});
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    ServerEvents.current.readyState = 1;
    ServerEvents.current.dispatchEvent(new Event("open"));
    await opening;
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects an expired session without storing or retrying the access token", async () => {
    const expired = vi.fn();
    window.addEventListener("lattice:session-expired", expired, { once: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    await expect(serverRequest("/api/invoke", {})).rejects.toThrow("session expired");
    expect(expired).toHaveBeenCalledOnce();
  });
  it("opens an isolated browser login while preserving a self-hosted path prefix", async () => {
    install();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await expect(invoke("overleaf_open_login_in_browser", { host: "https://example.edu/overleaf/" })).resolves.toBeUndefined();
    expect(open).toHaveBeenCalledWith("https://example.edu/overleaf/login", "_blank", "noopener,noreferrer");
    await expect(invoke("overleaf_open_login_in_browser", { host: "javascript:alert(1)" })).rejects.toThrow("Invalid Overleaf host");
    expect(open).toHaveBeenCalledTimes(1);
  });
});
