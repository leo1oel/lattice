import { readFileSync } from "node:fs";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { isBrowserHosted } from "../platform/browser-runtime";
import { invokeCalls, mockInvoke } from "../platform/tauri-test-mocks";
import { bundleLanguage, installNativeLocaleSync, nativeMenuLabels, syncNativeLocale } from "./native-locale";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: vi.fn(async () => () => {}) }),
}));
vi.mock("../platform/browser-runtime", () => ({ isBrowserHosted: vi.fn(() => false) }));

afterEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(isBrowserHosted).mockReturnValue(false);
});

describe("native locale", () => {
  it("labels every menu bar title the host requires", () => {
    const labels = nativeMenuLabels();
    expect(labels.about).toBe("About Lattice");
    expect(labels.quit).toBe("Quit Lattice");
    expect(labels.copy).toBe("Copy");
    // `MenuLabels` in native_locale.rs denies unknown and missing fields, so
    // the two field lists must stay identical.
    const rust = readFileSync("src-tauri/src/native_locale.rs", "utf8");
    const struct = /pub\(crate\) struct MenuLabels \{([^}]*)\}/.exec(rust)?.[1] ?? "";
    const rustFields = [...struct.matchAll(/(\w+): String/g)]
      .map(([, field]) => field.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase()));
    expect(Object.keys(labels).sort()).toEqual(rustFields.sort());
  });

  it("pins only an explicit interface language", () => {
    expect(bundleLanguage("system")).toBeNull();
    expect(bundleLanguage("en")).toBe("en");
    expect(bundleLanguage("zh-CN")).toBe("zh-Hans");
  });

  it("sends the menu from the desktop shell and only the language from a browser tab", async () => {
    mockInvoke({ set_native_locale: null });
    await syncNativeLocale("zh-CN");
    vi.mocked(isBrowserHosted).mockReturnValue(true);
    await syncNativeLocale("system");
    const [desktop, browser] = invokeCalls("set_native_locale");
    expect(desktop).toEqual({ menu: nativeMenuLabels(), bundleLanguage: "zh-Hans" });
    expect(browser).toEqual({ menu: null, bundleLanguage: null });
  });

  it("resends only when the locale actually changes", async () => {
    mockInvoke({ set_native_locale: null });
    const stop = installNativeLocaleSync();
    expect(invokeCalls("set_native_locale")).toHaveLength(1);
    i18n.emit("change");
    expect(invokeCalls("set_native_locale")).toHaveLength(1);
    const locale = i18n.locale;
    i18n.activate("zh-CN");
    i18n.activate(locale);
    expect(invokeCalls("set_native_locale")).toHaveLength(3);
    stop();
    i18n.activate("zh-CN");
    i18n.activate(locale);
    expect(invokeCalls("set_native_locale")).toHaveLength(3);
  });
});
