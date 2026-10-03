// Vitest empties CSS imports, so read the stylesheets off disk.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_WINDOW_MIN_HEIGHT,
  APP_WINDOW_MIN_WIDTH,
  minimumWindowWidth,
  SPLIT_SOURCE_MIN_WIDTH,
} from "./window-layout";

describe("minimumWindowWidth", () => {
  // A 1440 pt screen with the Dock and menu bar taking nothing off its width.
  const screenWidth = 1440;

  it.each([
    ["is the layout's own minimum at interface zoom 1.0", 1100, 1, 1100],
    ["grows with interface zoom 1.35, but never past the screen's visible width", 1100, 1.35, 1440],
    ["grows with interface zoom 1.35 while it still fits the screen", 1000, 1.35, 1350],
    ["keeps room for the titlebar controls when the layout needs less", 300, 1, APP_WINDOW_MIN_WIDTH],
    ["scales that titlebar floor with the zoom too", 0, 1.35, Math.ceil(APP_WINDOW_MIN_WIDTH * 1.35)],
  ])("%s", (_name, layoutMinWidth, interfaceScale, expected) => {
    expect(minimumWindowWidth({ layoutMinWidth, interfaceScale, screenWidth })).toBe(expected);
  });

  it("is unclamped when the screen is unknown", () => {
    expect(minimumWindowWidth({ layoutMinWidth: 1100, interfaceScale: 1.35, screenWidth: Infinity })).toBe(1485);
  });

  it("matches the native window configuration", () => {
    // tauri.conf.json and the multi-window builder in lib.rs carry the same
    // titlebar floor, which every window keeps until its layout reports more.
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

  it("keeps PDF search and navigation on one row in a narrow pane", () => {
    const css = readFileSync("src/pdf/pdf-viewer.css", "utf8");
    const template = /\.pdf-toolbar \{[^}]*grid-template-columns: ([^;]+);/.exec(css)?.[1];

    expect(template).toBe("auto minmax(0, 1fr) auto");
    expect(css).toMatch(/\.pdf-find-controls \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).toMatch(
      /\.pdf-find-controls:has\(\.pdf-outline-trigger\) \{ grid-template-columns: 24px minmax\(0, 1fr\); \}/,
    );
    expect(css).toMatch(/\.pdf-history-controls \{[^}]*grid-template-columns: 24px 24px;/);
    expect(css).toMatch(/\.pdf-find-controls \.pdf-search \{[^}]*width: 100%; min-width: 0;/);
    expect(css).not.toMatch(/\.pdf-find-controls \{[^}]*grid-row:/);
  });

  it("queries the toolbar's own width, never the whole PDF preview's", () => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(readFileSync("src/pdf/pdf-viewer.css", "utf8"));
    const rules = (list: CSSRuleList): CSSRule[] => Array.from(list).flatMap((rule) => [
      rule, ...(rule instanceof CSSGroupingRule ? rules(rule.cssRules) : []),
    ]);
    const styleRules = rules(sheet.cssRules).filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
    const targets = (rule: CSSStyleRule, className: string) => rule.selectorText.split(",")
      .some((selector) => new RegExp(`\\.${className}(?![\\w-])`).test(selector.trim().split(/[\s>+~]+/).pop() ?? ""));
    const containment = (rule: CSSStyleRule) => {
      const [name, type] = rule.style.getPropertyValue("container").split("/").map((part) => part.trim());
      return {
        name: rule.style.getPropertyValue("container-name") || name || "",
        type: rule.style.getPropertyValue("container-type") || type || "",
      };
    };

    // Only the toolbar's frame is a size container: a container's width
    // change restyles everything inside it in WebKit, every PDF page included.
    expect(styleRules.filter((rule) => targets(rule, "pdf-toolbar-frame")).map(containment))
      .toContainEqual({ name: "pdf-toolbar", type: "inline-size" });
    expect(styleRules.filter((rule) => targets(rule, "pdf-preview")).map(containment)
      .filter(({ type }) => type && type !== "normal")).toEqual([]);
    const narrowToolbar = rules(sheet.cssRules).filter((rule): rule is CSSContainerRule => rule instanceof CSSContainerRule
      && rule.containerName === "pdf-toolbar" && rule.containerQuery === "(max-width: 640px)");
    expect(narrowToolbar.flatMap((rule) => rules(rule.cssRules))
      .some((rule) => rule instanceof CSSStyleRule && targets(rule, "pdf-overflow") && rule.style.display === "none")).toBe(true);
  });
});
