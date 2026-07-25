import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmAction } from "./app-utils";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("confirmAction", () => {
  // Tauri's dialog plugin injects `window.confirm = async (m) => invoke(…)`,
  // so in the app every confirmation resolves rather than returns. Guards
  // written as `if (!window.confirm(…)) return;` therefore never blocked: a
  // Promise is always truthy, and deletes and restores went ahead whatever
  // the person clicked.
  it("waits for an async confirm, the way the Tauri dialog plugin replaces it", async () => {
    vi.spyOn(window, "confirm").mockImplementation(
      (() => Promise.resolve(false)) as unknown as typeof window.confirm,
    );
    await expect(confirmAction("Delete everything?")).resolves.toBe(false);

    vi.spyOn(window, "confirm").mockImplementation(
      (() => Promise.resolve(true)) as unknown as typeof window.confirm,
    );
    await expect(confirmAction("Delete everything?")).resolves.toBe(true);
  });

  it("still works against a plain synchronous confirm", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await expect(confirmAction("Delete everything?")).resolves.toBe(false);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await expect(confirmAction("Delete everything?")).resolves.toBe(true);
  });
});
