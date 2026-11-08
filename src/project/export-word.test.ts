import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { message, save } from "@tauri-apps/plugin-dialog";
import { showNotice, showWarning } from "../app/notify";
import { exportWord } from "./export-word";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn(), save: vi.fn() }));
vi.mock("../app/notify", () => ({ showNotice: vi.fn(), showWarning: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(save).mockResolvedValue("C:/review.docx");
  vi.mocked(invoke).mockResolvedValue({ path: "C:/review.docx", warnings: "" });
});
it("saves pending edits before conversion and reports the exported document", async () => {
  const saveEdits = vi.fn(async () => true);
  await exportWord("My paper", saveEdits);
  expect(message).toHaveBeenCalled();
  expect(saveEdits).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("export_word", { destination: "C:/review.docx" });
  expect(saveEdits.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(invoke).mock.invocationCallOrder[0]);
  expect(showNotice).toHaveBeenCalled();
});
it("does not convert or save when the file chooser is cancelled", async () => {
  vi.mocked(save).mockResolvedValue(null);
  const saveEdits = vi.fn(async () => true);
  await exportWord("Paper", saveEdits);
  expect(saveEdits).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});
it("does not export stale disk contents if saving edits fails", async () => {
  await exportWord("Paper", async () => false);
  expect(invoke).not.toHaveBeenCalled();
});
it("shows Pandoc warnings instead of silently claiming a complete conversion", async () => {
  vi.mocked(invoke).mockResolvedValue({ path: "C:/review.docx", warnings: "Could not convert TikZ" });
  await exportWord("Paper", async () => true);
  expect(showWarning).toHaveBeenCalledWith("Could not convert TikZ", expect.any(String));
});
it("propagates conversion failures without a success notification", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("Missing image"));
  await expect(exportWord("Paper", async () => true)).rejects.toThrow("Missing image");
  expect(showNotice).not.toHaveBeenCalled();
});
