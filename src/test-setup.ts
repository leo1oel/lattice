import "@testing-library/jest-dom/vitest";
// Re-exported by the React bindings, which are the direct dependency here.
import { configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

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

afterEach(() => {
  vi.useRealTimers();
});

// A few test files (vendored Open Knowledge core suites) opt into the node
// environment via `@vitest-environment node`; everything below shims
// browser APIs and only applies under jsdom.
if (typeof window !== "undefined") setupDomShims();

function setupDomShims() {

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
