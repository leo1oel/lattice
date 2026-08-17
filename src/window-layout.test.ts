// Vitest empties CSS imports, so read the stylesheets off disk.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_WINDOW_MIN_HEIGHT,
  APP_WINDOW_MIN_WIDTH,
  minimumWindowWidth,
  SPLIT_PDF_MIN_WIDTH,
  SPLIT_SOURCE_MIN_WIDTH,
} from "./window-layout";

describe("minimumWindowWidth", () => {
  it("keeps the application baseline when no wider layout is visible", () => {
    expect(minimumWindowWidth({
      interfaceScale: 1,
      minimumSidebarWidth: 320,
      minimumWorkspaceWidth: 0,
      sidebarOpen: false,
    })).toBe(APP_WINDOW_MIN_WIDTH);
  });

  it("reserves the complete sidebar, divider, and split workspace", () => {
    expect(minimumWindowWidth({
      interfaceScale: 1,
      minimumSidebarWidth: 320,
      minimumWorkspaceWidth: 901,
      sidebarOpen: true,
    })).toBe(1222);
  });

  it("scales the native minimum with the webview zoom", () => {
    expect(minimumWindowWidth({
      interfaceScale: 1.1,
      minimumSidebarWidth: 320,
      minimumWorkspaceWidth: 901,
      sidebarOpen: true,
    })).toBe(1345);
  });

  it("derives the configured baseline from the split minimums", () => {
    // tauri.conf.json and the multi-window builder in lib.rs carry the same
    // number; a pane floor that moves without them leaves the native window
    // able to open narrower than its own contents.
    expect(SPLIT_SOURCE_MIN_WIDTH + SPLIT_PDF_MIN_WIDTH + 1 + 320 + 1)
      .toBe(APP_WINDOW_MIN_WIDTH);
    const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    expect(config.app.windows[0].minWidth).toBe(APP_WINDOW_MIN_WIDTH);
    expect(readFileSync("src-tauri/src/lib.rs", "utf8"))
      .toContain(`min_inner_size(${APP_WINDOW_MIN_WIDTH}.0, ${APP_WINDOW_MIN_HEIGHT}.0)`);
  });
});

describe("narrow pane chrome", () => {
  it("keeps both status bar counters at the narrowest editor pane", () => {
    // The bar is its own query container, so a step is compared against the
    // pane minus its `0 var(--space-6)` padding. Steps at or above that width
    // fire in the split layout, where the counters are the only entry point to
    // the comment and TODO panels.
    const statusBarPadding = 2 * 12;
    const steps = [
      ...readFileSync("src/styles/app-shell.css", "utf8")
        .matchAll(/@container \(max-width: (\d+)px\)\s*\{[^}]*\.status-(?:comments|manuscript-todos)\b/g),
    ].map((match) => Number(match[1]));

    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step).toBeLessThan(SPLIT_SOURCE_MIN_WIDTH - statusBarPadding);
    }
  });

  it("keeps PDF search usable and moves it to its own row in a narrow pane", () => {
    const css = readFileSync("src/pdf-viewer.css", "utf8");
    const template = /\.pdf-toolbar \{[^}]*grid-template-columns: ([^;]+);/.exec(css)?.[1];

    expect(template).toBe("auto minmax(0, 1fr) auto");
    expect(css).toMatch(/\.pdf-find-controls \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).toMatch(
      /\.pdf-find-controls:has\(\.pdf-outline-trigger\) \{ grid-template-columns: 24px minmax\(0, 1fr\); \}/,
    );
    expect(css).toMatch(/\.pdf-find-controls \.pdf-search \{[^}]*width: 100%; min-width: 0;/);
    expect(css).toMatch(
      /@container pdf-preview \(max-width: 560px\)[\s\S]*?\.pdf-find-controls \{ grid-row: 2; grid-column: 1 \/ -1; \}/,
    );
  });
});
