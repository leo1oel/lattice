import { afterEach, describe, expect, it } from "vitest";
import { showNarrowScreenPage } from "./demo-chrome";

describe("the demo's narrow-screen page", () => {
  afterEach(() => {
    document.body.replaceChildren();
    delete document.documentElement.dataset.webDemoTheme;
  });

  it("takes the appearance the website asked for, and the browser's otherwise", () => {
    showNarrowScreenPage("zh-CN", "dark");
    expect(document.documentElement.dataset.webDemoTheme).toBe("dark");
    expect(document.querySelector("h1")?.textContent).toBe("请在更大的屏幕上试用 Lattice");
    document.body.replaceChildren();
    delete document.documentElement.dataset.webDemoTheme;
    showNarrowScreenPage("en", "system");
    expect(document.documentElement.dataset.webDemoTheme).toBeUndefined();
  });
});
