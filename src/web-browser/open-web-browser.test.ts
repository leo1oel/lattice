import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openWebBrowser } from "./open-web-browser";
const runtime = vi.hoisted(() => ({ browser: false }));
vi.mock("../platform/browser-runtime", () => ({ isBrowserHosted: () => runtime.browser }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(null) }));
afterEach(() => { runtime.browser = false; vi.clearAllMocks(); });
it("opens a native isolated window on desktop and an honest browser tab fallback on the web", async () => {
  await openWebBrowser("zh-CN");
  expect(invoke).toHaveBeenCalledWith("web_browser_open", { url: "https://example.com", locale: "zh-CN" });
  expect(openUrl).not.toHaveBeenCalled();
  vi.clearAllMocks(); runtime.browser = true;
  await openWebBrowser("en");
  expect(invoke).not.toHaveBeenCalled();
  expect(openUrl).toHaveBeenCalledWith("https://example.com");
});
