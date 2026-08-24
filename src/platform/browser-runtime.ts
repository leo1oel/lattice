const IPC_SERIALIZE_KEY = "__TAURI_TO_IPC_KEY__";
const BINARY_MARKER = "__latticeBridgeBinary";
const LOCAL_EVENT_START = -1;

type Callback = (payload: unknown) => void;

type BridgeValue =
  | null
  | boolean
  | number
  | string
  | BridgeValue[]
  | { [key: string]: BridgeValue };

type BrowserMessage =
  | { type: "ready"; label: string }
  | { type: "storage"; entries: [string, string][] }
  | { type: "response"; id: number; ok: true; value: BridgeValue }
  | { type: "response"; id: number; ok: false; error: BridgeValue }
  | { type: "callback"; id: number; payload: BridgeValue }
  | { type: "desktop-suspended" }
  | { type: "desktop-resumed" }
  | { type: "browser-replaced" }
  | { type: "desktop-returned" }
  | { type: "host-disconnected" }
  | { type: "error"; message: string };

type BrowserPeerRole = "browser" | "desktop";

const DESKTOP_STANDBY_KEY = "lattice.desktop-browser-standby";
const APPEARANCE_KEY = "lattice.appearance.v5";

interface BrowserInternals {
  invoke: (command: string, args?: unknown, options?: unknown) => Promise<unknown>;
  transformCallback: (callback?: Callback, once?: boolean) => number;
  unregisterCallback: (id: number) => void;
  runCallback: (id: number, payload: unknown) => void;
  callbacks: Map<number, Callback>;
  convertFileSrc: (path: string) => string;
  metadata: {
    currentWindow: { label: string };
    currentWebview: { label: string; windowLabel: string };
  };
  plugins: { path: { sep: string; delimiter: string } };
}

interface RuntimeWindow {
  __TAURI_INTERNALS__?: BrowserInternals;
  __TAURI_EVENT_PLUGIN_INTERNALS__?: {
    unregisterListener: (event: string, eventId: number) => void;
  };
  __LATTICE_BROWSER_RUNTIME__?: boolean;
  isTauri?: boolean;
}

export interface BrowserRuntimeConfig {
  token: string;
  bridgePort: number;
  label: string;
}

let runtimeError: string | null = null;
let browserRuntime = false;
let runtimeReady: Promise<void> = Promise.resolve();

export class BrowserRelay {
  private readonly socket: WebSocket;
  private readonly callbacks: Map<number, Callback>;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>();
  // A refreshed page can receive a late response issued for its predecessor.
  // Randomizing the starting ID keeps that response from settling an unrelated
  // request whose counter happened to restart at the same number.
  private nextRequestId = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
  private ready = false;
  private readyResolve!: () => void;
  private readyReject!: (reason: unknown) => void;
  private readonly readyPromise: Promise<void>;
  private storageResolve!: () => void;
  private storageReject!: (reason: unknown) => void;
  private storageHydrated = false;
  private pageLeaving = false;
  private terminal = false;
  private recovering = false;
  private standby = false;
  readonly storageReady: Promise<void>;

  constructor(
    config: BrowserRuntimeConfig,
    callbacks: Map<number, Callback>,
    private readonly reloadPage: () => void = () => window.location.reload(),
    private readonly role: BrowserPeerRole = browserPeerRole(),
    private readonly closePage: () => void = () => window.close(),
  ) {
    this.callbacks = callbacks;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.storageReady = new Promise<void>((resolve, reject) => {
      this.storageResolve = resolve;
      this.storageReject = reject;
    });
    const socketUrl = new URL(`ws://127.0.0.1:${config.bridgePort}/__lattice_bridge`);
    socketUrl.searchParams.set("token", config.token);
    socketUrl.searchParams.set("role", role);
    this.socket = new WebSocket(socketUrl);
    this.socket.addEventListener("message", (event) => this.receive(event));
    this.socket.addEventListener("close", () => {
      this.disconnect(new Error("The local Lattice app disconnected."));
    });
    this.socket.addEventListener("error", () => {
      this.disconnect(new Error("Could not connect to the local Lattice app."));
    });
    window.addEventListener("pagehide", () => {
      this.pageLeaving = true;
      this.syncStorage();
    });
    window.addEventListener("pageshow", (event) => {
      this.pageLeaving = false;
      if (event.persisted && this.socket.readyState !== WebSocket.OPEN) {
        this.disconnect(new Error("The local Lattice app disconnected."));
      }
    });
    window.setTimeout(() => {
      if (!this.ready && !this.standby) {
        this.fail(new Error(runtimeMessage("handoff-timeout")));
      }
    }, 20_000);
  }

  async invoke(command: string, args: unknown, options: unknown): Promise<unknown> {
    // Once the handoff is ready, send before yielding to a microtask. This is
    // what lets a beforeunload save place its write on the socket while the
    // document is still alive.
    if (!this.ready) await this.readyPromise;
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify({
          type: "invoke",
          id,
          command,
          args: encodeBridgeValue(args),
          options: encodeBridgeValue(options),
        }));
      } catch (reason) {
        this.pending.delete(id);
        reject(reason);
      }
    });
  }

  syncStorage(): void {
    if (!this.storageHydrated || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      type: "storage-update",
      entries: Object.entries(localStorage),
    }));
  }

  private receive(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let message: BrowserMessage;
    try {
      message = JSON.parse(event.data) as BrowserMessage;
    } catch {
      return;
    }
    if (message.type === "ready") {
      if (this.role === "desktop") sessionStorage.removeItem(DESKTOP_STANDBY_KEY);
      if (!this.ready) {
        this.ready = true;
        this.readyResolve();
      }
      return;
    }
    if (message.type === "callback") {
      this.callbacks.get(message.id)?.(decodeBridgeValue(message.payload));
      return;
    }
    if (message.type === "storage") {
      localStorage.clear();
      for (const [key, value] of message.entries) localStorage.setItem(key, value);
      this.storageHydrated = true;
      this.storageResolve();
      return;
    }
    if (message.type === "response") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(decodeBridgeValue(message.value));
      else pending.reject(decodeBridgeValue(message.error));
      return;
    }
    if (message.type === "host-disconnected") {
      this.disconnect(new Error(runtimeMessage("app-disconnected")));
      return;
    }
    if (message.type === "desktop-suspended") {
      this.standby = true;
      const reason = new Error(runtimeMessage("desktop-suspended"));
      showRuntimeFailure(reason);
      for (const pending of this.pending.values()) pending.reject(reason);
      this.pending.clear();
      if (sessionStorage.getItem(DESKTOP_STANDBY_KEY) !== "1") {
        sessionStorage.setItem(DESKTOP_STANDBY_KEY, "1");
        this.recovering = true;
        try {
          this.reloadPage();
        } catch {
          this.recovering = false;
          // The status remains visible and the server will resume this peer
          // when the external browser closes.
        }
      }
      return;
    }
    if (message.type === "desktop-resumed") {
      sessionStorage.removeItem(DESKTOP_STANDBY_KEY);
      try {
        this.reloadPage();
      } catch (reason) {
        this.fail(reason instanceof Error ? reason : new Error(String(reason)));
      }
      return;
    }
    if (message.type === "browser-replaced") {
      this.terminal = true;
      this.fail(new Error(runtimeMessage("browser-replaced")));
      return;
    }
    if (message.type === "desktop-returned") {
      this.terminal = true;
      this.syncStorage();
      try {
        this.closePage();
      } catch {
        // Browsers may reject window.close() for a tab opened by another app.
      }
      // If the browser permits the close, this document disappears before the
      // fallback paints. Otherwise, leave an explicit completion message.
      this.fail(new Error(runtimeMessage("desktop-returned")));
      return;
    }
    if (message.type === "error") {
      this.terminal = true;
      this.fail(new Error(message.message));
    }
  }

  private disconnect(reason: Error): void {
    if (this.terminal || this.pageLeaving || this.recovering) return;
    if (this.standby) {
      this.recovering = true;
      try {
        this.reloadPage();
      } catch {
        this.recovering = false;
        this.fail(reason);
      }
      return;
    }
    if (!this.ready) {
      this.fail(reason);
      return;
    }
    this.recovering = true;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
    // Browser memory savers and laptop sleep can tear down an idle WebSocket
    // while leaving the document alive. Reload through the fixed entry so it
    // can reuse the five-second session grace period or create a fresh host
    // after a longer suspension. A normal close/navigation sets pageLeaving
    // first and therefore still releases the native workspace as before.
    const recoveryFallback = window.setTimeout(() => {
      // A dirty editor can cancel the browser's reload confirmation. Leave its
      // content in place, but make the failed connection visible instead of
      // leaving a page that silently ignores every later recovery attempt.
      this.recovering = false;
      this.fail(reason);
    }, 1_000);
    try {
      this.reloadPage();
    } catch {
      window.clearTimeout(recoveryFallback);
      this.recovering = false;
      this.fail(reason);
    }
  }

  private fail(reason: Error): void {
    if (!this.ready) this.readyReject(reason);
    else showRuntimeFailure(reason);
    this.storageReject(reason);
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }
}

type RuntimeMessage =
  | "app-disconnected"
  | "handoff-timeout"
  | "desktop-suspended"
  | "browser-replaced"
  | "desktop-returned";

function runtimeMessage(message: RuntimeMessage): string {
  let configuredLanguage = "system";
  try {
    const appearance = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "{}") as {
      interfaceLanguage?: unknown;
    };
    if (appearance.interfaceLanguage === "en" || appearance.interfaceLanguage === "zh-CN") {
      configuredLanguage = appearance.interfaceLanguage;
    }
  } catch {
    // A malformed preference falls back to the browser language, just as the
    // main settings loader does.
  }
  const chinese = configuredLanguage === "zh-CN"
    || (configuredLanguage === "system" && navigator.languages.some((locale) => (
      locale.toLocaleLowerCase().startsWith("zh")
    )));
  const messages: Record<RuntimeMessage, [english: string, chinese: string]> = {
    "app-disconnected": [
      "The local Lattice app disconnected.",
      "与本地 Lattice 应用的连接已断开。",
    ],
    "handoff-timeout": [
      "The local Lattice app did not finish the browser handoff.",
      "本地 Lattice 应用未能完成浏览器切换。",
    ],
    "desktop-suspended": [
      "This workspace is open in your browser. It will return here when that browser tab closes.",
      "此工作区已在浏览器中打开。关闭浏览器标签页后，它会自动返回这里。",
    ],
    "browser-replaced": [
      "This Lattice workspace is open in another browser tab.",
      "此 Lattice 工作区已在另一个浏览器标签页中打开。",
    ],
    "desktop-returned": [
      "This workspace is now open in the Lattice desktop app. If this tab did not close automatically, you can close it.",
      "此工作区现已在 Lattice 桌面应用中打开。如果此标签页没有自动关闭，你可以手动关闭它。",
    ],
  };
  return messages[message][chinese ? 1 : 0];
}

function browserPeerRole(): BrowserPeerRole {
  return new URLSearchParams(window.location.search).get("latticeChromium") === "1"
    ? "desktop"
    : "browser";
}

function showRuntimeFailure(reason: Error): void {
  if (document.getElementById("lattice-browser-runtime-error")) return;
  const overlay = document.createElement("div");
  overlay.id = "lattice-browser-runtime-error";
  overlay.setAttribute("role", "alert");
  overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:var(--space-16);font:var(--font-ui-body) system-ui;color:CanvasText;background:Canvas";
  overlay.textContent = reason.message;
  document.body.append(overlay);
}

class BrowserEventRegistry {
  private nextLocalId = LOCAL_EVENT_START;
  private readonly entries = new Map<string, {
    callbackId: number;
    cleanup?: () => void;
  }>();

  constructor(private readonly runCallback: (id: number, payload: unknown) => void) {}

  listen(event: string, callbackId: number): number | null {
    const domEvent = event === "tauri://resize"
      ? "resize"
      : event === "tauri://focus"
        ? "focus"
        : event === "tauri://blur"
          ? "blur"
          : null;
    if (!domEvent) return null;
    const eventId = this.nextLocalId--;
    const notify = () => this.runCallback(callbackId, {
      event,
      id: eventId,
      payload: event === "tauri://resize"
        ? {
            width: Math.round(window.innerWidth * window.devicePixelRatio),
            height: Math.round(window.innerHeight * window.devicePixelRatio),
          }
        : event === "tauri://focus",
    });
    window.addEventListener(domEvent, notify);
    this.entries.set(this.key(event, eventId), {
      callbackId,
      cleanup: () => window.removeEventListener(domEvent, notify),
    });
    return eventId;
  }

  track(event: string, eventId: number, callbackId: number): void {
    this.entries.set(this.key(event, eventId), { callbackId });
  }

  unregister(event: string, eventId: number, unregisterCallback: (id: number) => void): void {
    const key = this.key(event, eventId);
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.cleanup?.();
    unregisterCallback(entry.callbackId);
    this.entries.delete(key);
  }

  private key(event: string, eventId: number): string {
    return `${event}:${eventId}`;
  }
}

function installBrowserRuntime(config: BrowserRuntimeConfig): Promise<void> {
  const runtimeWindow = window as unknown as RuntimeWindow;
  const callbacks = new Map<number, Callback>();
  const unregisterCallback = (id: number) => callbacks.delete(id);
  const runCallback = (id: number, payload: unknown) => callbacks.get(id)?.(payload);
  const transformCallback = (callback?: Callback, once = false): number => {
    let id: number;
    do {
      id = crypto.getRandomValues(new Uint32Array(1))[0];
    } while (callbacks.has(id));
    callbacks.set(id, (payload) => {
      if (once) callbacks.delete(id);
      callback?.(payload);
    });
    return id;
  };
  const events = new BrowserEventRegistry(runCallback);
  const relay = new BrowserRelay(config, callbacks);
  mirrorLocalStorage(relay);

  const invoke = async (command: string, args: unknown = {}, options?: unknown) => {
    const local = handleBrowserCommand(command, args);
    if (local.handled) return local.value;
    // Tauri's dialog plugin parents native panels to the invoking WebView.
    // That parent is the hidden bridge in browser mode, which leaves the panel
    // behind the browser. The browser-specific commands use an unparented
    // system panel while preserving the plugin's request and return shapes.
    if (command === "plugin:dialog|open") {
      return relay.invoke("browser_dialog_open", args, options);
    }
    if (command === "plugin:dialog|save") {
      return relay.invoke("browser_dialog_save", args, options);
    }
    if (command === "plugin:event|listen") {
      const eventArgs = args as { event: string; handler: number };
      const localEventId = events.listen(eventArgs.event, eventArgs.handler);
      if (localEventId !== null) return localEventId;
      const eventId = await relay.invoke(command, args, options) as number;
      events.track(eventArgs.event, eventId, eventArgs.handler);
      return eventId;
    }
    if (command === "plugin:event|unlisten") {
      const eventArgs = args as { eventId: number };
      if (eventArgs.eventId < 0) return undefined;
    }
    return relay.invoke(command, args, options);
  };

  runtimeWindow.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    unregisterCallback,
    runCallback,
    callbacks,
    convertFileSrc: (path) => path,
    metadata: {
      currentWindow: { label: config.label },
      currentWebview: { label: config.label, windowLabel: config.label },
    },
    plugins: { path: { sep: "/", delimiter: ":" } },
  };
  runtimeWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event, eventId) => events.unregister(event, eventId, unregisterCallback),
  };
  runtimeWindow.__LATTICE_BROWSER_RUNTIME__ = true;
  runtimeWindow.isTauri = true;
  browserRuntime = true;
  return relay.storageReady;
}

function mirrorLocalStorage(relay: BrowserRelay): void {
  const setItem = Storage.prototype.setItem;
  const removeItem = Storage.prototype.removeItem;
  const clear = Storage.prototype.clear;
  Storage.prototype.setItem = function (key: string, value: string) {
    setItem.call(this, key, value);
    if (this === localStorage) relay.syncStorage();
  };
  Storage.prototype.removeItem = function (key: string) {
    removeItem.call(this, key);
    if (this === localStorage) relay.syncStorage();
  };
  Storage.prototype.clear = function () {
    clear.call(this);
    if (this === localStorage) relay.syncStorage();
  };
}

function handleBrowserCommand(command: string, args: unknown): { handled: boolean; value?: unknown } {
  const payload = args as { value?: unknown; label?: string };
  switch (command) {
    case "set_window_background":
    case "plugin:window|set_min_size":
    case "plugin:window|start_dragging":
      return { handled: true };
    case "align_traffic_lights":
      return { handled: true, value: null };
    case "plugin:window|scale_factor":
      return { handled: true, value: window.devicePixelRatio };
    case "plugin:window|inner_size":
    case "plugin:window|outer_size":
      return {
        handled: true,
        value: {
          width: Math.round(window.innerWidth * window.devicePixelRatio),
          height: Math.round(window.innerHeight * window.devicePixelRatio),
        },
      };
    case "plugin:window|is_focused":
      return { handled: true, value: document.hasFocus() };
    case "plugin:window|is_fullscreen":
      return { handled: true, value: Boolean(document.fullscreenElement) };
    case "plugin:window|set_fullscreen":
      if (payload.value && !document.fullscreenElement) void document.documentElement.requestFullscreen();
      else if (!payload.value && document.fullscreenElement) void document.exitFullscreen();
      return { handled: true };
    case "plugin:window|set_title":
      if (typeof payload.value === "string") document.title = payload.value;
      return { handled: true };
    case "plugin:webview|set_webview_zoom":
      if (typeof payload.value === "number") document.documentElement.style.zoom = String(payload.value);
      return { handled: true };
    default:
      return { handled: false };
  }
}

function validBrowserConfig(
  token: string | null,
  bridgePort: number,
  label: string | null,
): BrowserRuntimeConfig | null {
  if (!token || !label || !Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65_535) {
    return null;
  }
  return { token, bridgePort, label };
}

function persistBrowserConfig(config: BrowserRuntimeConfig): void {
  sessionStorage.setItem("lattice.browser-token", config.token);
  sessionStorage.setItem("lattice.browser-port", String(config.bridgePort));
  sessionStorage.setItem("lattice.browser-label", config.label);
}

function readHashBrowserConfig(): BrowserRuntimeConfig | null {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const config = validBrowserConfig(
    hash.get("token"),
    Number(hash.get("bridgePort")),
    hash.get("label"),
  );
  if (!config) return null;
  persistBrowserConfig(config);
  if (window.location.hash) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  return config;
}

function readStoredBrowserConfig(): BrowserRuntimeConfig | null {
  return validBrowserConfig(
    sessionStorage.getItem("lattice.browser-token"),
    Number(sessionStorage.getItem("lattice.browser-port")),
    sessionStorage.getItem("lattice.browser-label"),
  );
}

async function requestBrowserSession(
  bridgePort: number,
  resumeToken?: string,
): Promise<BrowserRuntimeConfig> {
  const endpoint = new URL(`http://127.0.0.1:${bridgePort}/__lattice_session`);
  if (resumeToken) endpoint.searchParams.set("token", resumeToken);
  const response = await fetch(endpoint, {
    cache: "no-store",
    mode: "cors",
  });
  if (!response.ok) {
    throw new Error(`The local Lattice entry returned ${response.status}.`);
  }
  const value = await response.json() as Partial<BrowserRuntimeConfig>;
  const config = validBrowserConfig(
    typeof value.token === "string" ? value.token : null,
    Number(value.bridgePort),
    typeof value.label === "string" ? value.label : null,
  );
  if (!config) throw new Error("The local Lattice entry returned an invalid session.");
  persistBrowserConfig(config);
  return config;
}

async function initializeBrowserRuntime(): Promise<void> {
  const fromHash = readHashBrowserConfig();
  if (fromHash) {
    await installBrowserRuntime(fromHash);
    return;
  }
  const stored = readStoredBrowserConfig();
  const fixedEntry = window.location.hostname === "127.0.0.1"
    && window.location.port === "18452";
  const developmentEntry = new URLSearchParams(window.location.search).get("latticeBrowser") === "1";
  if (!stored && !fixedEntry && !developmentEntry) {
    runtimeError = "Open this page from the installed Lattice app to use its local tools.";
    return;
  }
  const config = await requestBrowserSession(stored?.bridgePort ?? 18_452, stored?.token);
  if (developmentEntry) {
    const url = new URL(window.location.href);
    url.searchParams.delete("latticeBrowser");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  await installBrowserRuntime(config);
}

function encodeBridgeValue(value: unknown): BridgeValue {
  const encoded = JSON.stringify(value ?? null, (_key, current: unknown) => {
    if (current instanceof ArrayBuffer) {
      return { [BINARY_MARKER]: bytesToBase64(new Uint8Array(current)) };
    }
    if (ArrayBuffer.isView(current)) {
      return {
        [BINARY_MARKER]: bytesToBase64(new Uint8Array(
          current.buffer,
          current.byteOffset,
          current.byteLength,
        )),
      };
    }
    if (current && typeof current === "object") {
      const serializable = current as Record<string, unknown>;
      const serialize = serializable[IPC_SERIALIZE_KEY];
      if (typeof serialize === "function") return serialize.call(current);
    }
    return current;
  });
  return JSON.parse(encoded) as BridgeValue;
}

function decodeBridgeValue(value: BridgeValue): unknown {
  if (Array.isArray(value)) return value.map(decodeBridgeValue);
  if (value && typeof value === "object") {
    if (BINARY_MARKER in value && typeof value[BINARY_MARKER] === "string") {
      return base64ToBytes(value[BINARY_MARKER]).buffer;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, decodeBridgeValue(child)]),
    );
  }
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 24_576;
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    encoded += btoa(binary);
  }
  return encoded;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isLoopbackPage(): boolean {
  return window.location.protocol === "http:"
    && (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost");
}

const runtimeWindow = window as unknown as RuntimeWindow;
if (!runtimeWindow.__TAURI_INTERNALS__ && isLoopbackPage()) {
  runtimeReady = initializeBrowserRuntime();
}

export function isBrowserHosted(): boolean {
  return browserRuntime;
}

export function isBundledChromium(): boolean {
  return browserRuntime
    && new URLSearchParams(window.location.search).get("latticeChromium") === "1";
}

export function browserRuntimeError(): string | null {
  return runtimeError;
}

export function browserRuntimeReady(): Promise<void> {
  return runtimeReady;
}

export { decodeBridgeValue, encodeBridgeValue };
