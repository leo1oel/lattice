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
