/**
 * Tauri on macOS uses the system WKWebView.
 * Map/WeakMap getOrInsert* only exist on newer WebKit (roughly Safari 26.2+).
 * Older macOS installs crash the UI with "getOrInsertComputed is not a function".
 * Also loaded early via public/polyfills.js before the module graph.
 */
function installGetOrInsertPolyfills(
  proto: Map<unknown, unknown> | WeakMap<object, unknown>,
): void {
  const target = proto as typeof proto & {
    getOrInsert?: (key: never, defaultValue: unknown) => unknown;
    getOrInsertComputed?: (key: never, callback: (key: never) => unknown) => unknown;
  };

  if (typeof target.getOrInsert !== "function") {
    target.getOrInsert = function getOrInsert(key, defaultValue) {
      if (this.has(key)) return this.get(key);
      this.set(key, defaultValue);
      return defaultValue;
    };
  }

  if (typeof target.getOrInsertComputed !== "function") {
    target.getOrInsertComputed = function getOrInsertComputed(key, callback) {
      if (this.has(key)) return this.get(key);
      const value = callback(key);
      this.set(key, value);
      return value;
    };
  }
}

installGetOrInsertPolyfills(Map.prototype);
installGetOrInsertPolyfills(WeakMap.prototype);

export {};
