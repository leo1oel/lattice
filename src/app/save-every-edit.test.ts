import { describe, expect, it, vi } from "vitest";
import { saveEveryEdit } from "./save-every-edit";

describe("saveEveryEdit", () => {
  const steps = (overrides: Partial<Parameters<typeof saveEveryEdit>[0]> = {}) => ({
    flush: vi.fn(() => true),
    save: vi.fn(async () => true),
    flushWholeFiles: vi.fn(async () => {}),
    flushProjectStores: vi.fn(async () => {}),
    hasUnsavedEdits: vi.fn(() => false),
    ...overrides,
  });

  it("is saved only once every edit is on disk and nothing changed meanwhile", async () => {
    const edits = steps();
    await expect(saveEveryEdit(edits)).resolves.toBe("saved");
    expect(edits.save).toHaveBeenCalledOnce();
    expect(edits.flushWholeFiles).toHaveBeenCalledOnce();
    expect(edits.flushProjectStores).toHaveBeenCalledOnce();
  });

  it("waits for the project's stores to write before letting go of the project", async () => {
    let written: () => void = () => {};
    const edits = steps({ flushProjectStores: () => new Promise<void>((resolve) => { written = resolve; }) });
    let outcome: string | null = null;
    const saving = saveEveryEdit(edits).then((result) => { outcome = result; });
    await Promise.resolve();
    await Promise.resolve();
    expect(outcome).toBeNull();
    written();
    await saving;
    expect(outcome).toBe("saved");
  });

  it("does not save around an unfinished IME composition", async () => {
    const edits = steps({ flush: () => false });
    await expect(saveEveryEdit(edits)).resolves.toBe("composing");
    expect(edits.save).not.toHaveBeenCalled();
    expect(edits.flushProjectStores).not.toHaveBeenCalled();
  });

  it("reports a failed save", async () => {
    await expect(saveEveryEdit(steps({ save: async () => false }))).resolves.toBe("failed");
  });

  it("reports an edit typed while the save ran", async () => {
    let typed = false;
    const edits = steps({
      save: async () => {
        typed = true;
        return true;
      },
      hasUnsavedEdits: () => typed,
    });
    await expect(saveEveryEdit(edits)).resolves.toBe("changed");
  });
});
