/**
 * Every window shares one localStorage. These model a second window two ways:
 * a second `useAppearance` in this page, and another page's write to storage
 * (with or without the `storage` event that reports it).
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPEARANCE_KEY, BUILD_PREFERENCES_KEY, THEME_PREFERENCE_KEY, loadAppearance,
} from "./app-settings";
import { useAppearance } from "./use-appearance";
import { useBuildPreferences } from "../app/use-build-preferences";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "unsupported") }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: vi.fn().mockResolvedValue(undefined) }),
}));

/** What another window does: write storage, then (unless still in flight) this page hears of it. */
function writeFromAnotherWindow(key: string, value: string, { announce = true } = {}) {
  const oldValue = localStorage.getItem(key);
  localStorage.setItem(key, value);
  if (announce) {
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue: value }));
    });
  }
}

describe("settings shared between windows", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("keeps the language one window chose when another changes the size", () => {
    const windowA = renderHook(() => useAppearance());
    const windowB = renderHook(() => useAppearance());

    act(() => windowA.result.current.setAppearance((current) => ({ ...current, interfaceLanguage: "zh-CN" })));
    expect(loadAppearance().interfaceLanguage).toBe("zh-CN");
    expect(windowB.result.current.appearance.interfaceLanguage).toBe("zh-CN");

    // ⌘+ in the other window.
    act(() => windowB.result.current.setAppearance((current) => ({ ...current, interfaceScale: 1.1 })));
    expect(loadAppearance()).toMatchObject({ interfaceLanguage: "zh-CN", interfaceScale: 1.1 });
    expect(windowA.result.current.appearance).toMatchObject({ interfaceLanguage: "zh-CN", interfaceScale: 1.1 });
  });

  it("follows another window's appearance, theme and build choices as they change", () => {
    const appearance = renderHook(() => useAppearance());
    const build = renderHook(() => useBuildPreferences());

    writeFromAnotherWindow(APPEARANCE_KEY, JSON.stringify({
      ...loadAppearance(), interfaceLanguage: "zh-CN", editorFontSize: 18, editorKeymap: "vim", editorSpellcheck: false,
    }));
    writeFromAnotherWindow(THEME_PREFERENCE_KEY, "dark");
    writeFromAnotherWindow(BUILD_PREFERENCES_KEY, JSON.stringify({ autoBuildMode: "manual" }));

    expect(appearance.result.current.appearance).toMatchObject({
      interfaceLanguage: "zh-CN", editorFontSize: 18, editorKeymap: "vim", editorSpellcheck: false,
    });
    expect(appearance.result.current.themePreference).toBe("dark");
    expect(appearance.result.current.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--editor-font-size")).toBe("18px");
    expect(build.result.current[0]).toEqual({ autoBuildMode: "manual" });
  });

  it("writes back only what this window changed, even before it hears of another window's change", () => {
    const { result } = renderHook(() => useAppearance());
    const seen = result.current.appearance;

    // Another window's choices, whose storage events have not arrived yet.
    writeFromAnotherWindow(APPEARANCE_KEY, JSON.stringify({
      ...loadAppearance(), interfaceLanguage: "zh-CN", codeTheme: "dracula", hiddenTitlebarTools: ["git"],
    }), { announce: false });

    // Settings hands back the whole object it last rendered, with one field changed.
    act(() => result.current.setAppearance({ ...seen, editorFontSize: 16 }));
    expect(loadAppearance()).toMatchObject({
      interfaceLanguage: "zh-CN", codeTheme: "dracula", hiddenTitlebarTools: ["git"], editorFontSize: 16,
    });
    expect(result.current.appearance).toMatchObject({ interfaceLanguage: "zh-CN", editorFontSize: 16 });
  });
});
