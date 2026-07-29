import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { THEME_KEY } from "./app-settings";
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
});
