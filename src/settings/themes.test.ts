import { beforeEach, describe, expect, it } from "vitest";

import { type ThemeRequest, applyThemeVariables, cachedTheme, rememberTheme } from "./themes";

describe("themes", () => {
  beforeEach(() => localStorage.clear());

  it("sets a theme's variables, removes the ones it no longer sets and keeps the code theme's", () => {
    const style = document.createElement("div").style;
    style.setProperty("--syntax-comment", "#111111");
    let set = applyThemeVariables(style, [["--bg", "#191724"], ["--line", "#e0def41a"], ["--syntax-comment", "#6e6a86"]], new Set());
    expect(style.getPropertyValue("--bg")).toBe("#191724");
    expect(style.getPropertyValue("--line")).toBe("#e0def41a");
    set = applyThemeVariables(style, [], set, new Set(["--syntax-comment"]));
    expect(style.getPropertyValue("--bg")).toBe("");
    expect(style.getPropertyValue("--syntax-comment")).toBe("#6e6a86");
    expect(set.size).toBe(0);
  });

  it("never sets anything but a color on a custom property", () => {
    const style = document.createElement("div").style;
    applyThemeVariables(style, [["--bg", "url(https://example.org/x)"], ["color", "#ffffff"], ["--ok", "#abcdef"]], new Set());
    expect(style.getPropertyValue("--bg")).toBe("");
    expect(style.getPropertyValue("color")).toBe("");
    expect(style.getPropertyValue("--ok")).toBe("#abcdef");
  });

  it("remembers the last answer for each choice, for the first paint", () => {
    const request: ThemeRequest = { theme: "app.lattice.nord", appearance: "dark", accent: "theme", presetColor: null };
    expect(cachedTheme(request)).toBeUndefined();
    rememberTheme(request, { theme: "app.lattice.nord", variables: [["--bg", "#2e3440"]], accent: "#88c0d0" });
    expect(cachedTheme(request)?.variables).toEqual([["--bg", "#2e3440"]]);
    expect(cachedTheme({ ...request, appearance: "light" })).toBeUndefined();
  });
});
