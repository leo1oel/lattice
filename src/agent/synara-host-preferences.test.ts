import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { synaraFrameUrl, type SynaraHostPreferences } from "./synara-runtime";

const script = readFileSync("src-tauri/src/synara/host_preferences.js", "utf8");
const origin = "http://127.0.0.1:4567";
const appKey = "synara:app-settings:v1";
const composerKey = "synara:composer-drafts:v1";
const selection = { provider: "codex", model: "gpt-6.1-sol", instanceId: "codex", options: { reasoningEffort: "high", fastMode: false } };
const choices = { stickyActiveProvider: "codex", stickyModelSelectionByProvider: { codex: selection } };

function harness(initial: SynaraHostPreferences["preferences"] = {}) {
  const frames: { src: string; contentWindow: object }[] = [];
  const listeners: ((event: unknown) => void)[] = [];
  const sessionBacking = new Map<string, string>();
  const saved = structuredClone(initial);
  const invoke = vi.fn(async (_: string, { patch }: { patch: { kind: string; defaultProvider?: string | null; composer?: typeof choices } }) => {
    if (patch.kind === "general") {
      if (patch.defaultProvider === null) delete saved.defaultProvider;
      else saved.defaultProvider = patch.defaultProvider;
    }
    if (patch.kind === "composer") saved.composer = patch.composer;
  });
  const host: Record<string, unknown> = { addEventListener: (_: string, listener: (event: unknown) => void) => listeners.push(listener), __TAURI_INTERNALS__: { invoke } };
  host.parent = host;
  runInContext(script.replace("__LATTICE_PREFS_NONCE__", '"native-nonce"'), createContext({ window: host, document: { querySelectorAll: () => frames }, URL, console }));
  const child = (preferences = initial, backing = new Map<string, string>(), install = true, childOrigin = origin) => {
    const seed = { nonce: "native-nonce", origin: childOrigin, preferences };
    const src = synaraFrameUrl({ origin: childOrigin, workspaceRoot: "/synthetic", theme: "light", hostOrigin: "tauri://localhost", authToken: "synthetic-auth", hostPreferences: seed });
    const history = { state: null, replaceState: vi.fn((_state: unknown, _title: string, _url: URL) => {}) };
    const childWindow: Record<string, unknown> = { location: { href: src }, history };
    childWindow.parent = { postMessage: (data: unknown) => listeners.forEach((listener) => listener({ data, origin: childOrigin, source: childWindow })) };
    const context = createContext({ window: childWindow, URL, URLSearchParams, console, backing, sessionBacking });
    runInContext(`class Storage {
      constructor(values) { this.values = values; }
      getItem(key) { return this.values.get(key) ?? null; }
      setItem(key, value) { this.values.set(String(key), String(value)); }
      removeItem(key) { this.values.delete(String(key)); }
      clear() { this.values.clear(); }
    }
    globalThis.Storage = Storage; window.localStorage = new Storage(backing); window.sessionStorage = new Storage(sessionBacking);`, context);
    frames.push({ src, contentWindow: childWindow });
    if (install) runInContext(script.replace("__LATTICE_PREFS_NONCE__", '"native-nonce"'), context);
    const write = (key: string, value: unknown) => {
      context.key = key; context.value = JSON.stringify(value);
      runInContext("window.localStorage.setItem(key, value)", context);
    };
    const remove = (key: string) => { context.key = key; runInContext("window.localStorage.removeItem(key)", context); };
    return { backing, write, remove, window: childWindow, history };
  };
  return { child, saved, invoke, frames, listeners };
}

it("restores provider, model, effort and speed before app startup after losing the entire frame storage", () => {
  const first = harness();
  const session = first.child();
  session.write(appKey, { defaultProvider: "codex", providers: { apiKey: "NEVER_COPY" } });
  session.write(composerKey, { version: 6, state: { ...choices, draftsByThreadId: { private: { prompt: "PRIVATE_DRAFT" } }, authToken: "NEVER_COPY" } });
  expect(first.saved).toEqual({ defaultProvider: "codex", composer: choices });
  expect(JSON.stringify(first.invoke.mock.calls)).not.toMatch(/NEVER_COPY|PRIVATE_DRAFT|draftsByThreadId|authToken|apiKey/);
  // A new process has no partitioned Web Storage. Only the native snapshot is
  // carried across; no application module has run in the new frame yet.
  const restarted = harness(first.saved).child();
  expect(JSON.parse(restarted.backing.get(appKey)!)).toEqual({ defaultProvider: "codex" });
  expect(JSON.parse(restarted.backing.get(composerKey)!)).toEqual({ version: 6, state: choices });
  const consumed = restarted.history.replaceState.mock.calls[0][2];
  expect(new URLSearchParams(consumed.hash.slice(1)).has("lattice-prefs")).toBe(false);
  expect(new URLSearchParams(consumed.hash.slice(1)).get("lattice-auth")).toBe("synthetic-auth");
});

it("retains newer shared-session choices when a later settings iframe has an older startup seed", () => {
  const host = harness({ defaultProvider: "claudeAgent" });
  const first = host.child();
  first.write(appKey, { defaultProvider: "codex" });
  first.write(composerKey, { version: 6, state: choices });
  const sibling = host.child({ defaultProvider: "claudeAgent" }, first.backing);
  expect(JSON.parse(sibling.backing.get(appKey)!)).toEqual({ defaultProvider: "codex" });
  expect(JSON.parse(sibling.backing.get(composerKey)!).state).toEqual(choices);
});

it("needs the native bridge to survive a cold ephemeral-storage restart", () => {
  const host = harness();
  const withoutBridge = host.child({}, new Map(), false);
  withoutBridge.write(appKey, { defaultProvider: "codex" });
  expect(host.invoke).not.toHaveBeenCalled();
  expect(harness(host.saved).child().backing.get(appKey)).toBeUndefined();
});

it("keeps an explicit reset authoritative when a sibling opens with an older seed", () => {
  const host = harness({ defaultProvider: "codex", composer: choices });
  const first = host.child();
  first.remove(appKey);
  first.remove(composerKey);
  const sibling = host.child({ defaultProvider: "codex", composer: choices }, first.backing);
  expect(sibling.backing.get(appKey)).toBeUndefined();
  expect(sibling.backing.get(composerKey)).toBeUndefined();
  expect(host.saved.defaultProvider).toBeUndefined();
  expect(host.saved.composer).toEqual({ stickyActiveProvider: null, stickyModelSelectionByProvider: {} });
});

it("rejects a foreign frame or mismatched origin and only seeds native-authorized loopback embeds", () => {
  const host = harness();
  const child = host.child();
  for (const event of [
    { source: {}, origin },
    { source: child.window, origin: "https://foreign.example" },
  ]) host.listeners.forEach((listener) => listener({ ...event, data: { type: "lattice:agent-ui-preferences", nonce: "native-nonce", patch: { kind: "general", defaultProvider: "codex" } } }));
  const foreign = host.child({ defaultProvider: "codex" }, new Map(), true, "https://foreign.example");
  expect(foreign.backing.get(appKey)).toBeUndefined();
  foreign.write(appKey, { defaultProvider: "codex" });
  expect(host.invoke).not.toHaveBeenCalled();
});
