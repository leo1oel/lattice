import { afterEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@tauri-apps/plugin-dialog";
import { confirmAction } from "./app-utils";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
});

describe("confirmAction", () => {
  /**
   * Not `window.confirm`. Tauri's dialog plugin overwrites that global with a
   * call to `plugin:dialog|confirm`, a command it no longer registers and no
   * permission grants, so in the app it was rejected by the ACL and no dialog
   * ever appeared — while `if (!window.confirm(…)) return;` sailed past,
   * because a rejected Promise is still truthy. This goes through the plugin's
   * own API, which uses the registered `message` command.
   */
  it("asks through the dialog plugin and returns what was answered", async () => {
    vi.mocked(confirm).mockResolvedValue(true);
    await expect(confirmAction("Delete everything?")).resolves.toBe(true);

    vi.mocked(confirm).mockResolvedValue(false);
    await expect(confirmAction("Delete everything?")).resolves.toBe(false);
    expect(confirm).toHaveBeenLastCalledWith("Delete everything?", expect.anything());
  });

  it("does not touch window.confirm, which is broken in the app", async () => {
    const globalConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(confirm).mockResolvedValue(false);
    await expect(confirmAction("Delete everything?")).resolves.toBe(false);
    expect(globalConfirm).not.toHaveBeenCalled();
    globalConfirm.mockRestore();
  });
});
