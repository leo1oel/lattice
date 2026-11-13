// The island bridge, injected into the main frame of every island before its
// own scripts run (lattice-webview, src/bridge.rs). It speaks to the host over
// Wry's IPC and is the page's whole view of the app:
//
//   latticeHost.post(type, payload)      an event for the host
//   latticeHost.request(type, payload)   a request; resolves with the host's answer
//   latticeHost.on(type, listener)       host events of one type; returns an unsubscribe
//   latticeHost.ready()                  the page is listening: the host may post
//   latticeHost.forwardKey(init)         a key from a child frame, relayed if it is the app's
//   latticeHost.pointerdown()            a press in a child frame
//
// It also reports, on its own, focus entering and leaving the page, presses in
// the page (so the host can close its popovers), and the app's shortcuts
// pressed in the page; and it applies the host's theme as CSS variables on
// the root element. Nothing here trusts a message that did not come from the
// host: host messages arrive only through `__latticeIsland.deliver`, which the
// host calls with evaluate_script. Every message to the host carries this
// webview's token, which lives only in this closure: the host drops a message
// without it, so another frame that reaches the IPC handler cannot speak.
(() => {
  if (window.__latticeIsland) return;
  const PRIMARY_IS_META = __LATTICE_PRIMARY_IS_META__;
  const TOKEN = __LATTICE_BRIDGE_TOKEN__;
  const send = (message) => {
    try {
      window.ipc.postMessage(JSON.stringify({ ...message, token: TOKEN }));
    } catch (_) {
      // The host is gone (the island is being torn down).
    }
  };
  const listeners = new Map();
  const pending = new Map();
  let nextId = 1;
  let relay = new Set();

  const comboOf = (event) =>
    (event.metaKey ? "meta+" : "") +
    (event.ctrlKey ? "ctrl+" : "") +
    (event.altKey ? "alt+" : "") +
    (event.shiftKey ? "shift+" : "") +
    event.code;

  const forwardKey = (event) => {
    if (!event || event.isComposing || !relay.has(comboOf(event))) return false;
    send({
      kind: "shortcut",
      code: event.code,
      key: event.key || "",
      meta: !!event.metaKey,
      ctrl: !!event.ctrlKey,
      alt: !!event.altKey,
      shift: !!event.shiftKey,
    });
    return true;
  };

  const emit = (type, payload) => {
    const set = listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(error);
      }
    }
  };

  const applyTheme = (theme) => {
    if (!theme || typeof theme !== "object") return;
    const root = document.documentElement;
    if (theme.appearance === "dark" || theme.appearance === "light") {
      root.dataset.theme = theme.appearance;
      root.style.colorScheme = theme.appearance;
    }
    for (const [name, value] of Object.entries(theme.vars || {})) {
      if (name.startsWith("--")) root.style.setProperty(name, String(value));
    }
  };

  const host = Object.freeze({
    primaryIsMeta: PRIMARY_IS_META,
    post(type, payload) {
      send({ kind: "event", type: String(type), payload: payload ?? null });
    },
    request(type, payload) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ kind: "request", id, type: String(type), payload: payload ?? null });
      });
    },
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      return () => listeners.get(type)?.delete(listener);
    },
    ready() {
      send({ kind: "ready" });
    },
    relay() {
      return [...relay];
    },
    pointerdown() {
      send({ kind: "pointerdown" });
    },
    forwardKey,
  });
  Object.defineProperty(window, "latticeHost", { value: host, configurable: false, writable: false });

  Object.defineProperty(window, "__latticeIsland", {
    configurable: false,
    writable: false,
    value: Object.freeze({
      deliver(message) {
        if (!message || typeof message !== "object") return;
        if (message.kind === "response") {
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          if (message.ok) waiter.resolve(message.payload);
          else waiter.reject(new Error(message.error || "The host refused the request"));
          return;
        }
        if (message.kind !== "event") return;
        if (message.type === "host:relay") {
          relay = new Set(Array.isArray(message.payload) ? message.payload : []);
        } else if (message.type === "host:theme") {
          applyTheme(message.payload);
        }
        emit(message.type, message.payload);
      },
    }),
  });

  // The app's shortcuts, claimed before the page's own handlers see them.
  window.addEventListener(
    "keydown",
    (event) => {
      if (forwardKey(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );

  // Focus is the page's as long as it, or a frame in it, holds the keyboard;
  // moving into a child frame blurs this window but keeps the page focused.
  let focused = false;
  const reportFocus = () => {
    const now = document.hasFocus();
    if (now === focused) return;
    focused = now;
    send({ kind: "focus", focused });
  };
  const checkFocus = () => setTimeout(reportFocus, 0);
  window.addEventListener("focus", checkFocus, true);
  window.addEventListener("blur", checkFocus, true);

  window.addEventListener("pointerdown", () => send({ kind: "pointerdown" }), true);
})();
