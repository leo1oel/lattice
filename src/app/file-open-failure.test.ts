import { afterEach, expect, it, vi } from "vitest";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { notifyError } from "../telemetry/app-notify";
import { showFileOpenFailure } from "./file-open-failure";
import { showError } from "./notify";

vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(async () => {}) }));
vi.mock("../telemetry/app-notify", () => ({ notifyError: vi.fn() }));
vi.mock("./notify", () => ({ showError: vi.fn() }));
afterEach(() => vi.clearAllMocks());

// What `read_file` and `read_asset` say about a 9 MB library (src-tauri/src/project/tree.rs).
const TOO_LARGE = "This file is too large to open in the editor (9437248 bytes; the limit is 8388608 bytes).";

it("says a text file is too large, with both sizes, and offers it in Finder", async () => {
  showFileOpenFailure(TOO_LARGE, "/papers/survey", "refs/library.bib");
  expect(showError).not.toHaveBeenCalled();
  const [, title, options] = vi.mocked(notifyError).mock.calls[0]!;
  expect(title).toBe("library.bib is too large to open in the editor");
  expect(options?.detail).toBe("It is 9.4 MB; the editor opens files up to 8.4 MB. Open it in another app instead.");
  expect(options?.primaryAction?.label).toBe("Show in Finder");
  await options?.primaryAction?.onClick();
  expect(revealItemInDir).toHaveBeenCalledWith("/papers/survey/refs/library.bib");
});

it("shows every other failure as it came", () => {
  const binary = "This is a binary or unsupported file and cannot be opened in the source editor.";
  showFileOpenFailure(new Error(binary), "/papers/survey", "figure.dat");
  expect(showError).toHaveBeenCalledWith(binary);
  expect(notifyError).not.toHaveBeenCalled();
});
