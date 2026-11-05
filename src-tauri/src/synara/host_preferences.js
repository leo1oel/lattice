/* Native document-start bridge, deliberately outside the eager React bundle.
 * WebKit's cross-site localStorage is ephemeral. Mirror only these UI choices,
 * never settings envelopes, credentials, draft text, or arbitrary storage keys. */
(() => {
  "use strict";
  const nonce = __LATTICE_PREFS_NONCE__;
  const message = "lattice:agent-ui-preferences";
  const providers = ["codex", "claudeAgent", "cursor", "devin", "antigravity", "grok", "droid", "opencode", "pi", "omp"];
  const efforts = ["none", "minimal", "off", "low", "medium", "high", "xhigh", "max", "ultra"];
  const appKey = "synara:app-settings:v1";
  const composerKey = "synara:composer-drafts:v1";
  const record = (value) => value && typeof value === "object" && !Array.isArray(value);
  const parse = (value) => { try { return JSON.parse(value); } catch { return null; } };
  const bounded = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9._:/@+ -]+$/.test(value);
  const composer = (state) => {
    if (!record(state) || !record(state.stickyModelSelectionByProvider)) return null;
    const entries = Object.entries(state.stickyModelSelectionByProvider);
    if (entries.length > 32) return null;
    const selections = {};
    for (const [key, value] of entries) {
      if (!record(value) || !providers.includes(value.provider) || !bounded(value.model, 256)
        || !bounded(key, 128) || key !== (value.instanceId || value.provider)) continue;
      const selection = { provider: value.provider, model: value.model };
      if (value.instanceId && bounded(value.instanceId, 128)) selection.instanceId = value.instanceId;
      const options = {};
      for (const name of ["reasoningEffort", "effort", "thinkingLevel"]) {
        if (efforts.includes(value.options?.[name])) options[name] = value.options[name];
      }
      if (typeof value.options?.fastMode === "boolean") options.fastMode = value.options.fastMode;
      if (Object.keys(options).length) selection.options = options;
      selections[key] = selection;
    }
    return {
      stickyModelSelectionByProvider: selections,
      stickyActiveProvider: Object.hasOwn(selections, state.stickyActiveProvider) ? state.stickyActiveProvider : null,
    };
  };
  if (window.parent === window) {
    // This listener exists only in native workspace windows. Both the DOM's
    // exact owning frame and the live managed origin (Rust) must agree.
    window.addEventListener("message", (event) => {
      if (!record(event.data) || event.data.type !== message || event.data.nonce !== nonce) return;
      const frame = [...document.querySelectorAll("iframe")].find((frame) => frame.contentWindow === event.source);
      try { if (!frame || new URL(frame.src).origin !== event.origin) return; } catch { return; }
      const patch = event.data.patch;
      if (!record(patch)) return;
      void window.__TAURI_INTERNALS__.invoke("synara_save_host_preferences", { origin: event.origin, patch })
        .catch(() => console.warn("Agent UI preference save failed"));
    });
    return;
  }
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const seed = parse(hash.get("lattice-prefs"));
  if (url.searchParams.get("embed") !== "1" || url.hostname !== "127.0.0.1" || url.protocol !== "http:"
    || !record(seed) || seed.nonce !== nonce || seed.origin !== url.origin || !record(seed.preferences)) return;
  const hostOrigin = url.searchParams.get("hostOrigin");
  if (!hostOrigin) return;
  // Consume the preference seed before Synara strips its own auth fragment.
  hash.delete("lattice-prefs");
  url.hash = hash.toString();
  window.history.replaceState(window.history.state, "", url);
  let storage;
  try { storage = window.localStorage; } catch { return; }
  const originalSet = Storage.prototype.setItem;
  const originalRemove = Storage.prototype.removeItem;
  const originalClear = Storage.prototype.clear;
  const write = (key, value) => originalSet.call(storage, key, JSON.stringify(value));
  try {
    // Sibling settings and composer frames share this partition. A later frame
    // must not replace this session's newer choices with its startup seed.
    const hydrated = "lattice:agent-ui-preferences-hydrated";
    if (window.sessionStorage.getItem(hydrated) !== nonce) {
      if (storage.getItem(appKey) === null && providers.includes(seed.preferences.defaultProvider)) {
        write(appKey, { defaultProvider: seed.preferences.defaultProvider });
      }
      const savedComposer = composer(seed.preferences.composer);
      if (storage.getItem(composerKey) === null && savedComposer) {
        // Version 6 is the pinned agent's composer persistence envelope; no draft
        // content is created or restored by this host bridge.
        write(composerKey, { version: 6, state: savedComposer });
      }
      // Keep a reset in this session authoritative even if another frame later
      // opens with the older runtime-info snapshot. This is not mirrored to disk.
      window.sessionStorage.setItem(hydrated, nonce);
    }
  } catch { return; }
  const last = new Map();
  const publish = (key, value) => {
    let patch;
    if (key === appKey) {
      const settings = parse(value);
      patch = { kind: "general", defaultProvider: providers.includes(settings?.defaultProvider) ? settings.defaultProvider : null };
    } else if (key === composerKey) {
      const saved = composer(parse(value)?.state);
      if (!saved) return;
      patch = { kind: "composer", composer: saved };
    } else return;
    const text = JSON.stringify(patch);
    if (last.get(key) === text) return;
    last.set(key, text);
    window.parent.postMessage({ type: message, nonce, patch }, hostOrigin);
  };
  Storage.prototype.setItem = function (key, value) {
    originalSet.call(this, key, value);
    if (this === storage) publish(String(key), String(value));
  };
  Storage.prototype.removeItem = function (key) {
    originalRemove.call(this, key);
    if (this === storage && key === appKey) publish(key, null);
    if (this === storage && key === composerKey) publish(key, JSON.stringify({ state: { stickyModelSelectionByProvider: {}, stickyActiveProvider: null } }));
  };
  Storage.prototype.clear = function () {
    originalClear.call(this);
    if (this === storage) {
      publish(appKey, null);
      publish(composerKey, JSON.stringify({ state: { stickyModelSelectionByProvider: {}, stickyActiveProvider: null } }));
    }
  };
})();
