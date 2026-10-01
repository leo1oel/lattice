import { APPEARANCE_KEY } from "../settings/app-settings";

/* eslint-disable lingui/no-unlocalized-strings -- bridge protocol keys shared with Tauri and the native host */
const IPC_SERIALIZE_KEY = "__TAURI_TO_IPC_KEY__";
const BINARY_MARKER = "__latticeBridgeBinary";
/* eslint-enable lingui/no-unlocalized-strings */
const LOCAL_EVENT_START = -1;

type Callback = (payload: unknown) => void;

type BridgeValue = null | boolean | number | string | BridgeValue[] | { [key: string]: BridgeValue };

type BrowserMessage =
  | { type: "ready"; label: string }
  | { type: "storage"; entries: [string, string][] }
  | { type: "response"; id: number; ok: true; value: BridgeValue }
  | { type: "response"; id: number; ok: false; error: BridgeValue }
  | { type: "callback"; id: number; payload: BridgeValue }
  | { type: "yield" | "desktop-suspended" | "desktop-resumed" | "desktop-returned" }
  | { type: "browser-replaced" | "host-disconnected" }
  | { type: "error"; message: string };

type BrowserPeerRole = "browser" | "desktop";

/** Set while the Chromium window shows its standby screen, across that page's reload. */
const DESKTOP_STANDBY_KEY = "lattice.desktop-browser-standby";
/** The server switches anyway this long after asking; keep the save inside it. */
const YIELD_SAVE_LIMIT_MS = 4_000;

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
  latticeDesktop?: { getPathForFile: (file: File) => string };
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
let runtimeDetached = false;
const detachListeners = new Set<() => void>();
let yieldHandler: (() => Promise<unknown>) | null = null;

/**
 * What this page does when another surface (the default browser, or the
 * Lattice window) is about to take its workspace: save every edit. The bridge
 * hands the workspace over only after this settles, or after a timeout.
 */
export function setWorkspaceYieldHandler(handler: (() => Promise<unknown>) | null): void {
  yieldHandler = handler;
}

// The page stays alive under the status overlay after another surface takes
// over, but its bridge no longer reaches the native host.
// Anything embedded here that accepts edits must stop doing so: nothing on
// this page can apply them to the project any more.
function detachRuntime(): void {
  if (runtimeDetached) return;
  runtimeDetached = true;
  for (const listener of [...detachListeners]) listener();
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const isChromiumPeer = () => new URLSearchParams(window.location.search).get("latticeChromium") === "1";

export class BrowserRelay {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>();
  // A refreshed page can receive a late response issued for its predecessor.
  // Randomizing the starting ID keeps that response from settling an unrelated
  // request whose counter happened to restart at the same number.
  private nextRequestId = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
  private ready = false;
  private readonly readyGate = deferred();
  private readonly storageGate = deferred();
  private storageHydrated = false;
  private pageLeaving = false;
  private terminal = false;
  private recovering = false;
  private standby = false;
  readonly storageReady = this.storageGate.promise;

  constructor(
    config: BrowserRuntimeConfig,
    private readonly callbacks: Map<number, Callback>,
    private readonly reloadPage: () => void = () => window.location.reload(),
    private readonly role: BrowserPeerRole = isChromiumPeer() ? "desktop" : "browser",
    private readonly closePage: () => void = () => window.close(),
    private readonly appReachable: () => Promise<boolean> = () => localAppReachable(config.bridgePort),
  ) {
    const socketUrl = new URL(`ws://127.0.0.1:${config.bridgePort}/__lattice_bridge`);
    socketUrl.searchParams.set("token", config.token);
    socketUrl.searchParams.set("role", role);
    this.socket = new WebSocket(socketUrl);
    this.socket.addEventListener("message", (event) => this.receive(event));
    this.socket.addEventListener("close", () => {
      this.disconnect(new Error(runtimeMessage("app-disconnected")));
    });
    this.socket.addEventListener("error", () => {
      this.disconnect(new Error(runtimeMessage("connect-failed")));
    });
    window.addEventListener("pagehide", () => {
      this.pageLeaving = true;
      this.syncStorage();
    });
    window.addEventListener("pageshow", (event) => {
      this.pageLeaving = false;
      if (event.persisted && this.socket.readyState !== WebSocket.OPEN) {
        this.disconnect(new Error(runtimeMessage("app-disconnected")));
      }
    });
    window.setTimeout(() => {
      if (!this.ready && !this.standby) this.fail(new Error(runtimeMessage("handoff-timeout")));
    }, 20_000);
  }

  async invoke(command: string, args: unknown, options: unknown): Promise<unknown> {
    // Once the handoff is ready, send before yielding to a microtask. This is
    // what lets a beforeunload save place its write on the socket while the
    // document is still alive.
    if (!this.ready) await this.readyGate.promise;
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        const message = { type: "invoke", id, command, args: encodeBridgeValue(args), options: encodeBridgeValue(options) };
        this.socket.send(JSON.stringify(message));
      } catch (reason) {
        this.pending.delete(id);
        reject(reason);
      }
    });
  }

  syncStorage(): void {
    if (!this.storageHydrated || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "storage-update", entries: Object.entries(localStorage) }));
  }

  /** A bridge control message the server handles itself; it is never relayed. */
  private sendControl(type: "yielded" | "reclaim"): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type }));
  }

  /** Save, then let the waiting surface take over. */
  private async yieldWorkspace(): Promise<void> {
    try {
      await Promise.race([
        yieldHandler?.(),
        new Promise((resolve) => window.setTimeout(resolve, YIELD_SAVE_LIMIT_MS)),
      ]);
    } catch {
      // A failed save is reported where it happened; the switch goes ahead
      // either way, as the server would after its timeout.
    }
    this.syncStorage();
    this.sendControl("yielded");
  }

  private receive(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let message: BrowserMessage;
    try {
      message = JSON.parse(event.data) as BrowserMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case "ready":
        if (this.role === "desktop") sessionStorage.removeItem(DESKTOP_STANDBY_KEY);
        if (!this.ready) {
          this.ready = true;
          this.readyGate.resolve();
        }
        break;
      case "callback":
        this.callbacks.get(message.id)?.(decodeBridgeValue(message.payload));
        break;
      case "storage":
        localStorage.clear();
        for (const [key, value] of message.entries) localStorage.setItem(key, value);
        this.storageHydrated = true;
        this.storageGate.resolve();
        break;
      case "response": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(decodeBridgeValue(message.value));
        else pending.reject(decodeBridgeValue(message.error));
        break;
      }
      case "host-disconnected":
        this.disconnect(new Error(runtimeMessage("app-disconnected")));
        break;
      case "yield":
        void this.yieldWorkspace();
        break;
      case "desktop-suspended":
        // A browser tab holds the workspace: this window waits behind a
        // standby screen, hidden, until the tab gives it back or closes.
        this.standby = true;
        detachRuntime();
        this.rejectPending(new Error(runtimeMessage("standby")));
        this.showStandby();
        if (sessionStorage.getItem(DESKTOP_STANDBY_KEY) !== "1") {
          sessionStorage.setItem(DESKTOP_STANDBY_KEY, "1");
          // Reload once so nothing of the workspace keeps running behind the
          // standby screen. If the reload is refused, the screen stays.
          this.reloadToRecover();
        }
        break;
      case "desktop-resumed":
        sessionStorage.removeItem(DESKTOP_STANDBY_KEY);
        this.reloadToRecover(() => this.fail(new Error(runtimeMessage("app-disconnected"))));
        break;
      case "desktop-returned":
        this.terminal = true;
        this.syncStorage();
        try {
          this.closePage();
        } catch {
          // Browsers may refuse to close a tab another app opened.
        }
        // If the close went through, this page is gone before this paints.
        this.fail(new Error(runtimeMessage("desktop-returned")));
        break;
      case "browser-replaced":
        this.terminal = true;
        this.fail(new Error(runtimeMessage("browser-replaced")));
        break;
      case "error":
        this.terminal = true;
        this.fail(new Error(message.message));
        break;
    }
  }

  private showStandby(): void {
    showRuntimeStatus({
      title: runtimeMessage("standby"),
      message: runtimeMessage("standby-detail"),
      action: {
        label: runtimeMessage("standby-action"),
        busyLabel: runtimeMessage("standby-busy"),
        run: () => this.sendControl("reclaim"),
      },
    });
  }

  private disconnect(reason: Error): void {
    if (this.terminal || this.pageLeaving || this.recovering) return;
    if (this.standby) {
      this.reloadToRecover(() => this.fail(reason));
      return;
    }
    if (!this.ready) {
      this.fail(reason);
      return;
    }
    this.rejectPending(reason);
    this.recovering = true;
    void this.appReachable().then((reachable) => {
      this.recovering = false;
      if (this.terminal || this.pageLeaving) return;
      if (reachable) {
        this.recover(reason);
        return;
      }
      // Lattice itself is gone. Reloading now would only replace this page
      // with the browser's own connection error.
      this.terminal = true;
      this.fail(new Error(runtimeMessage("app-quit")), {
        label: runtimeMessage("reload"),
        run: () => this.reloadPage(),
      });
    });
  }

  private recover(reason: Error): void {
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
    this.reloadToRecover(() => {
      window.clearTimeout(recoveryFallback);
      this.fail(reason);
    });
  }

  private reloadToRecover(onFailure?: () => void): void {
    this.recovering = true;
    try {
      this.reloadPage();
    } catch {
      this.recovering = false;
      onFailure?.();
    }
  }

  private rejectPending(reason: Error): void {
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }

  private fail(reason: Error, action?: RuntimeStatus["action"]): void {
    detachRuntime();
    if (!this.ready) this.readyGate.reject(reason);
    else showRuntimeStatus({ message: reason.message, action });
    this.storageGate.reject(reason);
    this.rejectPending(reason);
  }
}

/** True when the local Lattice app still answers at its address. */
async function localAppReachable(port: number): Promise<boolean> {
  try {
    // Any answer at all, even an opaque or error one, means it is running.
    await fetch(`http://127.0.0.1:${port}/`, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

// Shown before a saved locale is loaded (or after the app has gone), so these
// bootstrap messages carry their own English and Chinese text: the saved
// interface language lives in localStorage, which the native host mirrors
// into this page only once the bridge connects, and Lingui is activated after
// that. They are read at call time, so a live page follows the saved setting.
/* eslint-disable lingui/no-unlocalized-strings -- self-translated bootstrap text, see above */
const RUNTIME_MESSAGES = {
  "app-disconnected": [
    "The local Lattice app disconnected.",
    "与本地 Lattice 应用的连接已断开。",
  ],
  "connect-failed": [
    "Could not connect to the local Lattice app.",
    "无法连接到本地 Lattice 应用。",
  ],
  "entry-status": [
    "The local Lattice entry returned {status}.",
    "本地 Lattice 入口返回了 {status}。",
  ],
  "entry-invalid-session": [
    "The local Lattice entry returned an invalid session.",
    "本地 Lattice 入口返回了无效的会话。",
  ],
  "open-from-app": [
    "Open this page from the installed Lattice app to use its local tools.",
    "请从已安装的 Lattice 应用中打开此页面，以使用其本地工具。",
  ],
  "handoff-timeout": [
    "The local Lattice app did not finish the browser handoff.",
    "本地 Lattice 应用未能完成浏览器切换。",
  ],
  "browser-replaced": [
    "This Lattice workspace is open in another browser tab.",
    "此 Lattice 工作区已在另一个浏览器标签页中打开。",
  ],
  standby: [
    "This workspace is open in your browser",
    "此工作区正在浏览器中使用",
  ],
  "standby-detail": [
    "Close the tab to bring it back here.",
    "关闭标签页即可回到这里。",
  ],
  "standby-action": ["Use here", "在这里使用"],
  "standby-busy": ["Switching…", "正在切换…"],
  "desktop-returned": [
    "Back in the Lattice app. You can close this tab.",
    "已回到 Lattice 应用，可以关闭此标签页。",
  ],
  "app-quit": [
    "Lattice quit. Open it again, then reload this tab.",
    "Lattice 已退出。重新打开后，刷新此标签页。",
  ],
  reload: ["Reload", "刷新"],
} satisfies Record<string, [english: string, chinese: string]>;
/* eslint-enable lingui/no-unlocalized-strings */

function runtimeMessage(message: keyof typeof RUNTIME_MESSAGES, values: Record<string, string> = {}): string {
  let configuredLanguage: unknown;
  try {
    configuredLanguage = (JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "{}") as {
      interfaceLanguage?: unknown;
    }).interfaceLanguage;
  } catch {
    // A malformed preference falls back to the browser language, just as the
    // main settings loader does.
  }
  const chinese = configuredLanguage === "en" || configuredLanguage === "zh-CN"
    ? configuredLanguage === "zh-CN"
    : navigator.languages[0]?.toLocaleLowerCase().startsWith("zh");
  return RUNTIME_MESSAGES[message][chinese ? 1 : 0]
    .replace(/\{(\w+)\}/g, (placeholder, name: string) => values[name] ?? placeholder);
}

interface RuntimeStatus {
  title?: string;
  message: string;
  action?: { label: string; busyLabel?: string; run: () => void };
}

/**
 * Cover the page with a short status, optionally with one button. The
 * Chromium shell waits for this element to be gone before it shows a window
 * that comes back from the browser.
 */
function showRuntimeStatus(status: RuntimeStatus): void {
  document.getElementById("lattice-browser-runtime-error")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "lattice-browser-runtime-error";
  overlay.setAttribute("role", "alert");
  const overlayStyle = "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:var(--space-16);font:var(--font-ui-body) system-ui;color:CanvasText;background:Canvas";
  overlay.style.cssText = overlayStyle;
  const panel = document.createElement("div");
  const panelStyle = "display:grid;justify-items:center;gap:var(--space-4);max-width:28rem;text-align:center";
  panel.style.cssText = panelStyle;
  if (status.title) {
    const title = document.createElement("strong");
    const titleStyle = "font-size:1.25em";
    title.style.cssText = titleStyle;
    title.textContent = status.title;
    panel.append(title);
  }
  const message = document.createElement("p");
  const messageStyle = "margin:0;opacity:0.72";
  message.style.cssText = messageStyle;
  message.textContent = status.message;
  panel.append(message);
  const action = status.action;
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    const buttonStyle = "margin-top:var(--space-6);padding:var(--space-3) var(--space-8);border:0;border-radius:var(--radius-control);font:inherit;cursor:pointer";
    button.style.cssText = buttonStyle;
    button.textContent = action.label;
    button.addEventListener("click", () => {
      if (action.busyLabel) {
        button.disabled = true;
        button.textContent = action.busyLabel;
      }
      action.run();
    });
    panel.append(button);
  }
  overlay.append(panel);
  document.body.append(overlay);
}

function physicalWindowSize() {
  return {
    width: Math.round(window.innerWidth * window.devicePixelRatio),
    height: Math.round(window.innerHeight * window.devicePixelRatio),
  };
}

const DRAG_EVENTS = new Map([
  ["tauri://drag-enter", "dragenter"],
  ["tauri://drag-over", "dragover"],
  ["tauri://drag-drop", "drop"],
  ["tauri://drag-leave", "dragleave"],
]);
const WINDOW_EVENTS = new Map([["tauri://resize", "resize"], ["tauri://focus", "focus"], ["tauri://blur", "blur"]]);

export class BrowserEventRegistry {
  private nextLocalId = LOCAL_EVENT_START;
  private readonly entries = new Map<string, {
    callbackId: number;
    cleanup?: () => void;
  }>();

  constructor(private readonly runCallback: (id: number, payload: unknown) => void) {}

  listen(event: string, callbackId: number): number | null {
    const desktop = (window as unknown as RuntimeWindow).latticeDesktop;
    const dragEvent = DRAG_EVENTS.get(event);
    if (desktop && dragEvent) {
      return this.subscribe(event, callbackId, dragEvent, true, (raw, emit) => {
        const drag = raw as DragEvent;
        // eslint-disable-next-line lingui/no-unlocalized-strings -- DataTransfer type for OS file drags
        if (!drag.dataTransfer?.types.includes("Files")) return;
        // Internal tree drags use text data. Only consume OS file drops, and
        // prevent Chromium from navigating to the dropped file. Capture runs
        // before editor/tree handlers that would otherwise import it twice.
        // Preserve other window subscribers (the paper drop bridge and App's
        // importer both listen): stopping immediately lets the first swallow the drop.
        drag.preventDefault();
        drag.stopPropagation();
        if (dragEvent === "dragleave" && drag.relatedTarget) return;
        const scale = window.devicePixelRatio || 1;
        emit({
          // Chromium protects the file list until drop. Tree hover still
          // works by position; classification becomes available on drop.
          paths: Array.from(drag.dataTransfer.files, (file) => desktop.getPathForFile(file)).filter(Boolean),
          position: { x: drag.clientX * scale, y: drag.clientY * scale },
        });
      });
    }
    const domEvent = WINDOW_EVENTS.get(event);
    if (!domEvent) return null;
    return this.subscribe(event, callbackId, domEvent, false, (_raw, emit) => {
      emit(event === "tauri://resize" ? physicalWindowSize() : event === "tauri://focus");
    });
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

  /** Emulates a Tauri event with a window DOM event under a negative local id. */
  private subscribe(
    event: string,
    callbackId: number,
    domEvent: string,
    capture: boolean,
    handle: (raw: Event, emit: (payload: unknown) => void) => void,
  ): number {
    const eventId = this.nextLocalId--;
    const emit = (payload: unknown) => this.runCallback(callbackId, { event, id: eventId, payload });
    const listener = (raw: Event) => handle(raw, emit);
    window.addEventListener(domEvent, listener, capture);
    this.entries.set(this.key(event, eventId), {
      callbackId,
      cleanup: () => window.removeEventListener(domEvent, listener, capture),
    });
    return eventId;
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
    const local = LOCAL_COMMANDS.get(command);
    if (local) return local(args as { value?: unknown });
    const dialog = BROWSER_DIALOG_COMMANDS.get(command);
    if (dialog) return relay.invoke(dialog, args, options);
    if (command === "plugin:event|listen") {
      const eventArgs = args as { event: string; handler: number };
      const localEventId = events.listen(eventArgs.event, eventArgs.handler);
      if (localEventId !== null) return localEventId;
      const eventId = await relay.invoke(command, args, options) as number;
      events.track(eventArgs.event, eventId, eventArgs.handler);
      return eventId;
    }
    if (command === "plugin:event|unlisten" && (args as { eventId: number }).eventId < 0) return undefined;
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
  for (const method of ["setItem", "removeItem", "clear"] as const) {
    const original: (this: Storage, ...args: string[]) => void = Storage.prototype[method];
    Storage.prototype[method] = function (this: Storage, ...args: string[]) {
      original.apply(this, args);
      if (this === localStorage) relay.syncStorage();
    };
  }
}

// Window commands the page answers itself. Anything else goes to the native host.
/* eslint-disable lingui/no-unlocalized-strings -- Tauri command names */
const ignored = () => undefined;
const LOCAL_COMMANDS = new Map<string, (payload: { value?: unknown }) => unknown>([
  ["set_window_background", ignored],
  ["plugin:window|set_min_size", ignored],
  ["plugin:window|start_dragging", ignored],
  ["align_traffic_lights", () => null],
  ["plugin:window|scale_factor", () => window.devicePixelRatio],
  ["plugin:window|inner_size", physicalWindowSize],
  ["plugin:window|outer_size", physicalWindowSize],
  ["plugin:window|is_focused", () => document.hasFocus()],
  ["plugin:window|is_fullscreen", () => Boolean(document.fullscreenElement)],
  ["plugin:window|set_fullscreen", ({ value }) => {
    if (value && !document.fullscreenElement) void document.documentElement.requestFullscreen();
    else if (!value && document.fullscreenElement) void document.exitFullscreen();
  }],
  ["plugin:window|set_title", ({ value }) => {
    if (typeof value === "string") document.title = value;
  }],
  ["plugin:webview|set_webview_zoom", ({ value }) => {
    if (typeof value !== "number") return;
    document.documentElement.style.zoom = String(value);
    // Native chrome drawn over the page (the bundled Chromium's traffic
    // lights) does not zoom; its injected CSS divides its inset by this.
    document.documentElement.style.setProperty("--lattice-page-zoom", String(value));
  }],
]);

// Tauri's dialog plugin parents native panels to the invoking WebView. That
// parent is the hidden bridge in browser mode, which leaves the panel behind
// the browser. The browser-specific commands use an unparented system panel
// while preserving the plugin's request and return shapes.
const BROWSER_DIALOG_COMMANDS = new Map([
  ["plugin:dialog|open", "browser_dialog_open"],
  ["plugin:dialog|save", "browser_dialog_save"],
]);
/* eslint-enable lingui/no-unlocalized-strings */

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
  entry?: string,
): Promise<BrowserRuntimeConfig> {
  const endpoint = new URL(`http://127.0.0.1:${bridgePort}/__lattice_session`);
  if (resumeToken) endpoint.searchParams.set("token", resumeToken);
  if (entry) endpoint.searchParams.set("entry", entry);
  endpoint.searchParams.set("role", isChromiumPeer() ? "desktop" : "browser");
  const response = await fetch(endpoint, { cache: "no-store", mode: "cors" });
  if (!response.ok) {
    throw new Error(runtimeMessage("entry-status", { status: String(response.status) }));
  }
  const value = await response.json() as Partial<BrowserRuntimeConfig>;
  const config = validBrowserConfig(
    typeof value.token === "string" ? value.token : null,
    Number(value.bridgePort),
    typeof value.label === "string" ? value.label : null,
  );
  if (!config) throw new Error(runtimeMessage("entry-invalid-session"));
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
  const search = new URLSearchParams(window.location.search);
  const developmentEntry = search.get("latticeBrowser") === "1";
  // The app opens the default browser on a single-use `?entry=<nonce>`, never
  // on a token: the address lands in process arguments and browser history.
  const entry = search.get("entry") ?? undefined;
  if (!stored && !fixedEntry && !developmentEntry && !entry) {
    runtimeError = runtimeMessage("open-from-app");
    return;
  }
  const config = await requestBrowserSession(
    stored?.bridgePort ?? 18_452,
    stored?.token,
    entry,
  );
  if (developmentEntry || entry) {
    const url = new URL(window.location.href);
    url.searchParams.delete("latticeBrowser");
    url.searchParams.delete("entry");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  await installBrowserRuntime(config);
}

export function encodeBridgeValue(value: unknown): BridgeValue {
  const encoded = JSON.stringify(value ?? null, (_key, current: unknown) => {
    if (current instanceof ArrayBuffer || ArrayBuffer.isView(current)) {
      const bytes = current instanceof ArrayBuffer
        ? new Uint8Array(current)
        : new Uint8Array(current.buffer, current.byteOffset, current.byteLength);
      return { [BINARY_MARKER]: bytesToBase64(bytes) };
    }
    if (current && typeof current === "object") {
      const serialize = (current as Record<string, unknown>)[IPC_SERIALIZE_KEY];
      if (typeof serialize === "function") return serialize.call(current);
    }
    return current;
  });
  return JSON.parse(encoded) as BridgeValue;
}

export function decodeBridgeValue(value: BridgeValue): unknown {
  if (Array.isArray(value)) return value.map(decodeBridgeValue);
  if (value && typeof value === "object") {
    if (BINARY_MARKER in value && typeof value[BINARY_MARKER] === "string") {
      return Uint8Array.from(atob(value[BINARY_MARKER]), (character) => character.charCodeAt(0)).buffer;
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

/** The bundled Chromium window, as opposed to a tab in the default browser. */
export function isBundledChromium(): boolean {
  return browserRuntime && isChromiumPeer();
}

export function browserRuntimeError(): string | null {
  return runtimeError;
}

export function browserRuntimeReady(): Promise<void> {
  return runtimeReady;
}

export function browserRuntimeDetached(): boolean {
  return runtimeDetached;
}

export function subscribeBrowserRuntimeDetached(listener: () => void): () => void {
  detachListeners.add(listener);
  return () => detachListeners.delete(listener);
}
