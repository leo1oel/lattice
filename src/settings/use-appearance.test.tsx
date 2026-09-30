import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { APPEARANCE_KEY, SYSTEM_DARK_QUERY, THEME_PREFERENCE_KEY } from "./app-settings";
import { useAppearance } from "./use-appearance";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: vi.fn().mockResolvedValue(undefined) }),
}));

/** Replaces the jsdom shim with a dispatchable system-appearance query. */
function mockSystemDark(dark: boolean) {
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    get matches() { return query === SYSTEM_DARK_QUERY && dark; },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })) as unknown as typeof window.matchMedia;
  return (next: boolean) => {
    dark = next;
    for (const listener of listeners) listener();
  };
}

describe("useAppearance", () => {
  const baseMatchMedia = window.matchMedia;

  beforeEach(() => {
    cleanup();
    window.matchMedia = baseMatchMedia;
    localStorage.clear();
    localStorage.setItem(THEME_PREFERENCE_KEY, "light");
    vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  });

  it("keeps the native resize background synchronized with the theme", async () => {
    const { result } = renderHook(() => useAppearance());

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("set_window_background", { dark: false });
    });

    act(() => result.current.setThemePreference("dark"));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("set_window_background", { dark: true });
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("follows the system appearance by default and tracks later OS changes", async () => {
    localStorage.clear();
    const setSystemDark = mockSystemDark(false);
    const { result } = renderHook(() => useAppearance());

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(result.current.themePreference).toBe("system");

    act(() => setSystemDark(true));

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(result.current.theme).toBe("dark");
    expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBe("system");
  });

  it("stops tracking the system once the user picks a theme", async () => {
    localStorage.clear();
    const setSystemDark = mockSystemDark(false);
    const { result } = renderHook(() => useAppearance());

    act(() => result.current.setThemePreference("light"));
    act(() => setSystemDark(true));

    await waitFor(() => expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBe("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("follows the system language until the user chooses an override", async () => {
    const languages = vi.spyOn(window.navigator, "languages", "get")
      .mockReturnValue(["zh-CN"]);
    const { result } = renderHook(() => useAppearance());

    await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
    expect(result.current.appearance.interfaceLanguage).toBe("system");
    expect(localStorage.getItem(APPEARANCE_KEY)).toContain('"interfaceLanguage":"system"');

    act(() => result.current.setAppearance((appearance) => ({
      ...appearance,
      interfaceLanguage: "en",
    })));

    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    expect(localStorage.getItem(APPEARANCE_KEY)).toContain('"interfaceLanguage":"en"');
    languages.mockRestore();
  });
});
