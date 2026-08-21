/* Runs before the app module. Tauri macOS uses system WKWebView; older
 * macOS lacks Map/WeakMap getOrInsert / getOrInsertComputed.
 *
 * React's development-only Components performance track recursively inspects
 * changed props. In WKWebView that inspection can reach an already-mounted
 * cross-origin Agent iframe, throw a SecurityError during commit, and leave
 * React's scheduler permanently inside the render context. Production React
 * does not install this track. Disable only that optional dev instrumentation
 * before react-dom evaluates; running this from main.tsx would be too late
 * because ESM dependencies execute first. */
(function () {
  if (
    typeof location !== "undefined" &&
    location.protocol === "http:" &&
    typeof navigator !== "undefined" &&
    /AppleWebKit/i.test(navigator.userAgent) &&
    typeof console !== "undefined" &&
    typeof console.timeStamp === "function"
  ) {
    try {
      console.timeStamp = undefined;
    } catch (_) {
      // A future WebKit may make the console property read-only. In that case
      // keep booting; the rest of the compatibility polyfills are still needed.
    }
  }

  function install(proto) {
    if (typeof proto.getOrInsert !== "function") {
      proto.getOrInsert = function getOrInsert(key, defaultValue) {
        if (this.has(key)) return this.get(key);
        this.set(key, defaultValue);
        return defaultValue;
      };
    }
    if (typeof proto.getOrInsertComputed !== "function") {
      proto.getOrInsertComputed = function getOrInsertComputed(key, callback) {
        if (this.has(key)) return this.get(key);
        var value = callback(key);
        this.set(key, value);
        return value;
      };
    }
  }
  install(Map.prototype);
  if (typeof WeakMap !== "undefined") install(WeakMap.prototype);
})();

/* Web fallback for the Tauri native bridge.
 *
 * Lattice is a Tauri desktop app: the real runtime injects
 * `window.__TAURI_INTERNALS__` before any page script runs, so `invoke`,
 * `listen`, and `getCurrentWindow()` can reach the native (Rust) backend.
 * When the same frontend is served as a plain website (e.g. a Vercel
 * deployment) that object is absent, and every `@tauri-apps/api` call throws
 * `TypeError: Cannot read properties of undefined (reading 'invoke')`.
 *
 * This shim installs a stand-in ONLY when the real bridge is missing, so it
 * never shadows the desktop runtime. Native commands become a tagged rejected
 * promise instead of a hard crash: existing `.catch()` guards keep working,
 * and `global-error-capture` recognises the tag to stay quiet in web mode. */
(function () {
  if (typeof window === "undefined") return;
  if (window.__TAURI_INTERNALS__) return;

  var LABEL = "main";
  function webBridgeError(cmd) {
    var error = new Error(
      "Lattice native bridge unavailable in the browser" +
        (cmd ? " (command: " + cmd + ")" : "") +
        ". This feature only works in the desktop app.",
    );
    error.latticeWebBridgeUnavailable = true;
    return error;
  }

  // Built-in Tauri plugin commands (window/webview/event management) fire
  // during startup from many call sites that don't guard with `.catch()`.
  // Rejecting them floods the console with unhandled rejections, so degrade
  // them to inert no-ops. Only the app's own native commands (non-`plugin:`)
  // reject with the tagged error, which the app already handles gracefully.
  function webInvoke(cmd) {
    if (typeof cmd === "string" && cmd.indexOf("plugin:") === 0) {
      // Boolean window/webview queries: report a plain, inactive window state.
      if (/\|is_/.test(cmd)) return Promise.resolve(false);
      // `listen` resolves to a numeric event id used later to unlisten.
      if (cmd === "plugin:event|listen") return Promise.resolve(0);
      // Everything else (emit, unlisten, start_dragging, set_*, show, hide…)
      // has no browser equivalent; resolve as a successful no-op.
      return Promise.resolve(undefined);
    }
    return Promise.reject(webBridgeError(cmd));
  }

  window.__TAURI_INTERNALS__ = {
    invoke: function (cmd) {
      return webInvoke(cmd);
    },
    // Event listeners never fire in web mode; hand back a stable callback id.
    transformCallback: function () {
      return 0;
    },
    unregisterCallback: function () {},
    // No custom protocol exists in the browser, so keep the path as-is.
    convertFileSrc: function (filePath) {
      return filePath;
    },
    // `getCurrentWindow()` / `getCurrentWebview()` read these labels
    // synchronously while constructing their handles.
    metadata: {
      currentWindow: { label: LABEL },
      currentWebview: { label: LABEL },
    },
  };
})();
