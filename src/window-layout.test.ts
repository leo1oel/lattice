import { describe, expect, it } from "vitest";
import { APP_WINDOW_MIN_WIDTH, minimumWindowWidth } from "./window-layout";

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
      minimumWorkspaceWidth: 981,
      sidebarOpen: true,
    })).toBe(1302);
  });

  it("scales the native minimum with the webview zoom", () => {
    expect(minimumWindowWidth({
      interfaceScale: 1.1,
      minimumSidebarWidth: 320,
      minimumWorkspaceWidth: 981,
      sidebarOpen: true,
    })).toBe(1433);
  });
});
