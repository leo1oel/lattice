import { encodeBridgeValue, decodeBridgeValue, type BridgeValue } from "./browser-bridge-value";
import { detachRuntime, runtimeMessage, showRuntimeStatus, type BrowserRuntimeConfig, type RuntimeStatus } from "./browser-runtime";

type Callback = (payload: unknown) => void;

type BrowserMessage =
  | { type: "ready"; label: string }
  | { type: "storage"; entries: [string, string][] }
  | { type: "response"; id: number; ok: true; value: BridgeValue }
  | { type: "response"; id: number; ok: false; error: BridgeValue }
  | { type: "callback"; id: number; payload: BridgeValue }
  | { type: "desktop-returned" | "browser-replaced" | "host-disconnected" }
  | { type: "error"; message: string };

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
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
  readonly storageReady = this.storageGate.promise;

  constructor(
    config: BrowserRuntimeConfig,
    private readonly callbacks: Map<number, Callback>,
    private readonly reloadPage: () => void = () => window.location.reload(),
    private readonly closePage: () => void = () => window.close(),
    private readonly appReachable: () => Promise<boolean> = () => localAppReachable(config.bridgePort),
  ) {
    const socketUrl = new URL(`ws://127.0.0.1:${config.bridgePort}/__lattice_bridge`);
    socketUrl.searchParams.set("token", config.token);
    socketUrl.searchParams.set("role", "browser");
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
      if (!this.ready && !this.terminal) this.fail(new Error(runtimeMessage("handoff-timeout")));
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

  private disconnect(reason: Error): void {
    if (this.terminal || this.pageLeaving || this.recovering) return;
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

