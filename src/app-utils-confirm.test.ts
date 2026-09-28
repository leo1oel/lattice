import { afterEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@tauri-apps/plugin-dialog";
import { confirmAction } from "./app-utils";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("confirmAction", () => {
  // Why never `window.confirm`: see `askConfirmation` in app-utils.ts.
  it("asks through the dialog plugin, never window.confirm, and returns what was answered", async () => {
    const globalConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(confirm).mockResolvedValue(true);
    await expect(confirmAction("Delete everything?")).resolves.toBe(true);

    vi.mocked(confirm).mockResolvedValue(false);
    await expect(confirmAction("Delete everything?")).resolves.toBe(false);
    expect(confirm).toHaveBeenLastCalledWith("Delete everything?", expect.anything());
    expect(globalConfirm).not.toHaveBeenCalled();
  });
});
