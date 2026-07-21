/* Runs before the app module. Tauri macOS uses system WKWebView; older
 * macOS lacks Map/WeakMap getOrInsert / getOrInsertComputed. */
(function () {
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
