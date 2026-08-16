import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { APPEARANCE_KEY, THEME_KEY } from "./app-settings";
import { useAppearance } from "./use-appearance";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: vi.fn().mockResolvedValue(undefined) }),
}));

describe("useAppearance", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    localStorage.setItem(THEME_KEY, "light");
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("keeps the native resize background synchronized with the theme", async () => {
    const { result } = renderHook(() => useAppearance());

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("set_window_background", { dark: false });
    });

    act(() => result.current.setTheme("dark"));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("set_window_background", { dark: true });
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
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
