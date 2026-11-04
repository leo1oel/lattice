import { BrowserEventRegistry, decodeBridgeValue, encodeBridgeValue, isHeadlessHosted, LOCAL_COMMANDS } from "./browser-runtime";
import { showServerLogin } from "./headless-login";
import "./headless.css";

/* eslint-disable lingui/no-unlocalized-strings -- transport protocol and diagnostic errors; bootstrap UI lives in headless-login */
type Callback = (value: unknown) => void;
type EventPayload = { event?: string; callback?: number; payload: unknown };
let activeClient: string | undefined;
export interface HeadlessSession {
  headless: boolean;
  authenticated: boolean;
  capabilities?: { commands: string[]; unavailable: string[] };
}

export async function serverRequest<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = body === undefined ? {} : { "Content-Type": "application/json" };
  if (activeClient) headers["X-Lattice-Client"] = activeClient;
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) {
    window.dispatchEvent(new Event("lattice:session-expired"));
    throw new Error("Server session expired. Reload to sign in again.");
  }
  const value = await response.json();
  if (!response.ok || value.error) {
    throw new Error(value.error?.message ?? `Server request failed (${response.status}).`);
  }
  return value as T;
}

/** A Tauri API adapter, with no native host, loopback URLs or credentials in URLs/storage. */
export function installHeadlessRuntime(session: HeadlessSession): () => void {
  const client = crypto.randomUUID();
  activeClient = client;
  const callbacks = new Map<number, Callback>();
  const listeners = new Map<number, { event: string; callback: number }>();
  let nextId = 1;
  const runCallback = (id: number, payload: unknown) => callbacks.get(id)?.(payload);
  const localEvents = new BrowserEventRegistry(runCallback);
  const eventSource = new EventSource(`/api/events?${new URLSearchParams({ client })}`, { withCredentials: true });
  const waitForEvents = () => {
    if (eventSource.readyState === 1) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const opened = () => { clearTimeout(timer); resolve(); };
      const timer = window.setTimeout(() => {
        eventSource.removeEventListener("open", opened);
        reject(new Error("The server event stream is unavailable. Reconnect before opening a terminal."));
      }, 20_000);
      eventSource.addEventListener("open", opened, { once: true });
    });
  };
  eventSource.onmessage = (message) => {
    let value: EventPayload;
    try { value = JSON.parse(message.data) as EventPayload; } catch { return; }
    if (typeof value.callback === "number") {
      runCallback(value.callback, decodeBridgeValue(value.payload as Parameters<typeof decodeBridgeValue>[0]));
      return;
    }
    for (const [id, listener] of listeners) {
      if (listener.event === value.event) runCallback(listener.callback, { event: value.event, id, payload: value.payload });
    }
  };
  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    const local = LOCAL_COMMANDS.get(command);
    if (local) return local(args);
    if (command === "plugin:event|listen") {
      const event = String(args.event);
      const handler = Number(args.handler);
      const localId = localEvents.listen(event, handler);
      if (localId !== null) return localId;
      const id = nextId++;
      listeners.set(id, { event, callback: handler });
      return id;
    }
    if (command === "plugin:event|unlisten") {
      const id = Number(args.eventId);
      localEvents.unregister(String(args.event), id, (callback) => callbacks.delete(callback));
      listeners.delete(id);
      return;
    }
    if (command === "plugin:opener|open_url") {
      const url = new URL(String(args.url));
      if (!["https:", "http:", "mailto:"].includes(url.protocol)) throw new Error("Unsupported URL scheme.");
      window.open(url.href, "_blank", "noopener,noreferrer");
      return;
    }
    if (command === "overleaf_open_login_in_browser") {
      const host = new URL(typeof args.host === "string" ? args.host : "https://www.overleaf.com");
      if (!["https:", "http:"].includes(host.protocol) || host.username || host.password || host.search || host.hash) throw new Error("Invalid Overleaf host.");
      host.pathname = `${host.pathname.replace(/\/+$/, "")}/login`;
      // noopener deliberately returns null even when the browser opens it.
      window.open(host.href, "_blank", "noopener,noreferrer");
      return;
    }
    if (command === "plugin:clipboard-manager|write_text") return navigator.clipboard.writeText(String(args.text));
    if (command === "plugin:clipboard-manager|read_text") return navigator.clipboard.readText();
    if (command === "plugin:dialog|open") {
      const { chooseServerProject } = await import("./headless-project-picker");
      return chooseServerProject();
    }
    if (session.capabilities && !session.capabilities.commands.includes(command)) {
      throw new Error(`${command} is unavailable on this server. See server capabilities.`);
    }
    if (command === "terminal_open" || command === "terminal_attach") await waitForEvents();
    const value = await serverRequest<{ result: unknown }>("/api/invoke", { command, args: encodeBridgeValue(args) });
    if (command === "read_compiled_pdf" && Array.isArray(value.result)) return Uint8Array.from(value.result).buffer;
    return decodeBridgeValue(value.result as Parameters<typeof decodeBridgeValue>[0]);
  };
  const runtime = window as unknown as Record<string, unknown>;
  runtime.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(callback: Callback, once = false) {
      const id = nextId++;
      callbacks.set(id, (payload) => {
        if (once) callbacks.delete(id);
        callback?.(payload);
      });
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    runCallback,
    callbacks,
    convertFileSrc(path: string) {
      return `/api/asset?${new URLSearchParams({ path, client })}`;
    },
    metadata: { currentWindow: { label: "headless" }, currentWebview: { label: "headless", windowLabel: "headless" } },
    plugins: { path: { sep: "/", delimiter: ":" } },
  };
  runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event: string, id: number) {
      localEvents.unregister(event, id, (callback) => callbacks.delete(callback));
      listeners.delete(id);
    },
  };
  runtime.__LATTICE_BROWSER_RUNTIME__ = true;
  runtime.__LATTICE_HEADLESS_CLIENT__ = client;
  runtime.__LATTICE_HEADLESS_TERMINAL__ = Boolean(session.capabilities?.commands.includes("terminal_open"));
  runtime.isTauri = true;
  return () => {
    eventSource.close(); listeners.clear(); callbacks.clear();
    if (activeClient === client) activeClient = undefined;
  };
}

export async function initializeHeadlessRuntime(): Promise<void> {
  if (!isHeadlessHosted()) return;
  let session = await serverRequest<HeadlessSession>("/api/session");
  if (!session.authenticated) session = await showServerLogin();
  const dispose = installHeadlessRuntime(session);
  window.addEventListener("pagehide", dispose, { once: true });
}
