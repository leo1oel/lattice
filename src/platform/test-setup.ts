import "@testing-library/jest-dom/vitest";
// Re-exported by the React bindings, which are the direct dependency here.
import { configure } from "@testing-library/react";
import { createElement, useSyncExternalStore } from "react";
import { afterAll, afterEach, vi } from "vitest";
import { activateAppLocale, i18n } from "../i18n";

await activateAppLocale("en");

// Unit tests render feature components directly rather than mounting main.tsx.
// Give Lingui macros the same active instance without requiring every existing
// test to repeat an I18nProvider wrapper.
vi.mock("@lingui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lingui/react")>();
  const { TransNoContext } = await import("@lingui/react/server");
  // One object per locale, not one per module. Real `useLingui()` reads a
  // context whose value is replaced when the locale changes; a module-scope
  // singleton is stable forever, so anything memoized on it — the React
  // Compiler memoizes every `t\`…\`` result in a component — keeps rendering
  // the previous language. Stable *within* a locale is still required: a fresh
  // object per render would invalidate those same memos on every pass.
  const linguiByLocale = new Map<string, { i18n: typeof i18n; _: typeof i18n._; defaultComponent: undefined }>();
  const linguiFor = (locale: string) => {
    const existing = linguiByLocale.get(locale);
    if (existing) return existing;
    const value = { i18n, _: i18n._.bind(i18n), defaultComponent: undefined };
    linguiByLocale.set(locale, value);
    return value;
  };
  const useLinguiMock = () => linguiFor(useSyncExternalStore(
    (onStoreChange) => i18n.on("change", onStoreChange),
    () => i18n.locale,
    () => i18n.locale,
  ));
  return {
    ...actual,
    useLingui: useLinguiMock,
    // Subscribes on its own, like the real `Trans` does through context: a
    // `<Trans>` under a parent that does not itself call `useLingui` would
    // otherwise never be told the locale moved.
    Trans: (props: Parameters<typeof TransNoContext>[0]) => createElement(TransNoContext, {
      ...props,
      lingui: useLinguiMock(),
    }),
  };
});

// Much of the app is behind `lazy()`, so the first `findBy…` for one of those
// components is really waiting on a dynamic import. The default second is
// comfortable on an idle machine and not on a busy one, which showed up as a
// different test failing each run — always whichever happened to import a
// component first. A ceiling for a hang, not the expected duration of anything.
configure({ asyncUtilTimeout: 5_000 });

// Every notification is forwarded to the on-disk log (`app-log-store.ts`), which
// reaches for the Tauri plugin through a dynamic import. Unmocked, that import
// is a real module resolution on the first notification of a run and its
// rejection path calls `console.error` — both land in whichever test happened to
// notify first rather than in any test that is about logging.
vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn(async () => undefined),
  warn: vi.fn(async () => undefined),
  error: vi.fn(async () => undefined),
}));

afterEach(async () => {
  vi.useRealTimers();
  if (i18n.locale !== "en") await activateAppLocale("en");
});

/**
 * Let deferred unmount work finish while the DOM it needs still exists.
 *
 * `@tiptap/react` does not destroy an editor when its effect cleanup runs; it
 * calls `setTimeout(…, 1)` and destroys on the next tick, so that a remount
 * (StrictMode, a key change) can cancel it. In this runner that timer is a
 * *Node* timer, not a jsdom one: vitest's `populateGlobal` only copies window
 * keys that Node's global lacks, and `setTimeout` is not on its override list,
 * so `globalThis.setTimeout` stays Node's while `globalThis.window` becomes the
 * global itself. Teardown then does `dom.window.close()` — which clears jsdom's
 * own timer list, and that list is empty — followed by `delete global.window`.
 * A destroy scheduled by the last unmount in a file therefore survives teardown
 * and runs against a global with no `window`, and the first thing ProseMirror's
 * `destroyPluginViews` reaches is the `window.removeEventListener` pair in
 * @tiptap/core's drag plugin: `ReferenceError: window is not defined`, reported
 * as an unhandled exception that fails a run in which every test passed.
 *
 * Draining here rather than filtering the error keeps a real `window is not
 * defined` in app code failing the suite, and is the more correct outcome
 * anyway: the editor is actually destroyed, inside the environment that created
 * it, instead of being abandoned mid-teardown. Ordering is guaranteed, not
 * hopeful — Node fires timers in expiry order, so a 2 ms timer registered after
 * a pending 1 ms one cannot run first. Two passes because a destroy is free to
 * queue one more turn of work. `afterAll` and not `afterEach`: between tests the
 * window is still up, so those timers fire harmlessly on their own; only the
 * file's last one races teardown, and paying ~4 ms per file beats ~4 ms per test.
 */
afterAll(async () => {
  vi.useRealTimers();
  for (let pass = 0; pass < 2; pass += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 2); });
  }
});

// A few test files (vendored Open Knowledge core suites) opt into the node
// environment via `@vitest-environment node`; everything below shims
// browser APIs and only applies under jsdom.
if (typeof window !== "undefined") setupDomShims();

function setupDomShims() {

// jsdom does not implement requestAnimationFrame / cancelAnimationFrame.
// Preact 11's hooks call cancelAnimationFrame during unmount, and navigator
// tests that install fake timers can leave a scheduled frame whose cancel
// then throws `cancelAnimationFrame is not defined` after every test has
// passed. Implement both with timers so an all-green suite cannot exit 1.
// Delay is 0 ms, not a frame's 16 ms: afterAll only waits 2 ms twice, which
// is what flushes these callbacks before jsdom teardown.
if (typeof globalThis.requestAnimationFrame !== "function") {
  (globalThis as unknown as { requestAnimationFrame: (cb: (time: number) => void) => number })
    .requestAnimationFrame = (callback) => (
      globalThis.setTimeout(() => callback(Date.now()), 0) as unknown as number
    );
}
if (typeof globalThis.cancelAnimationFrame !== "function") {
  (globalThis as unknown as { cancelAnimationFrame: (id: number) => void })
    .cancelAnimationFrame = (id) => { globalThis.clearTimeout(id); };
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

const storage = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, String(value)),
  },
});

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: () => undefined,
});

// Base UI waits for viewport animations before refreshing ScrollArea geometry.
// jsdom does not implement the Web Animations API, so expose the settled state
// browsers return when no CSS or JS animations are attached.
if (!("getAnimations" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
}

// jsdom has no 2D canvas backend; ThinkingOrb reads getContext("2d") and
// bails when it is null, so return null here to exercise that path without
// flooding the run with jsdom "Not implemented" warnings.
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => null,
});

Object.defineProperty(Range.prototype, "getClientRects", {
  configurable: true,
  value: () => [],
});

Object.defineProperty(Range.prototype, "getBoundingClientRect", {
  configurable: true,
  value: () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0 }),
});

// tldraw's environment detection calls CSS.supports at module scope; jsdom
// exposes the CSS global without implementing it.
if (typeof globalThis.CSS === "undefined" || typeof globalThis.CSS.supports !== "function") {
  (globalThis as unknown as { CSS: unknown }).CSS = { supports: () => false };
}
// jsdom's CSS.supports rejects content-visibility, which would silently turn
// the vendored chunk-wrapper-decoration plugin into a no-op at module init
// and fail its tests. The shipping WKWebView (Safari 18+) supports it, so
// tests should exercise the active plugin.
{
  const supports = globalThis.CSS.supports.bind(globalThis.CSS);
  globalThis.CSS.supports = ((property: string, value?: string) => (
    property === "content-visibility" ? true : supports(property as never, value as never)
  )) as typeof globalThis.CSS.supports;
}

// Radix UI (shadcn menus/tooltips/etc.) relies on APIs jsdom doesn't implement.
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
for (const method of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!(method in Element.prototype)) {
    Object.defineProperty(Element.prototype, method, { configurable: true, value: () => undefined });
  }
}

}
