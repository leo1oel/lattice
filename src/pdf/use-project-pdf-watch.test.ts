import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { onProjectFilesChanged } from "../project/project-files-changed";
import { PDF_RECHECK_MS, useProjectPdfWatch } from "./use-project-pdf-watch";

vi.mock("../project/project-files-changed", async (importOriginal) => ({
  ...await importOriginal<typeof import("../project/project-files-changed")>(),
  onProjectFilesChanged: vi.fn(),
}));

let report: (paths: readonly string[] | null) => void = () => undefined;
const stopListening = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(onProjectFilesChanged).mockImplementation((_root, onChange) => {
    report = onChange;
    return stopListening;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("rechecks when the watcher reports the file, and on the poll for what it misses", () => {
  const recheck = vi.fn();
  renderHook(() => useProjectPdfWatch("/project", "out/main.pdf", false, recheck));
  expect(onProjectFilesChanged).toHaveBeenCalledWith("/project", expect.any(Function));
  report(["notes.md"]);
  expect(recheck).not.toHaveBeenCalled();
  report(["out/main.pdf"]);
  report(["out"]);
  report(null);
  expect(recheck).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(PDF_RECHECK_MS);
  expect(recheck).toHaveBeenCalledTimes(4);
});

it("polls a removed file half as often", () => {
  const recheck = vi.fn();
  renderHook(() => useProjectPdfWatch("/project", "out/main.pdf", true, recheck));
  vi.advanceTimersByTime(PDF_RECHECK_MS);
  expect(recheck).not.toHaveBeenCalled();
  vi.advanceTimersByTime(PDF_RECHECK_MS);
  expect(recheck).toHaveBeenCalledTimes(1);
});

it("checks nothing without a file or a project, and stops when it goes", () => {
  const recheck = vi.fn();
  const { rerender, unmount } = renderHook(
    ({ path }: { path: string | null }) => useProjectPdfWatch("/project", path, false, recheck),
    { initialProps: { path: null as string | null } },
  );
  expect(onProjectFilesChanged).not.toHaveBeenCalled();
  rerender({ path: "out/main.pdf" });
  unmount();
  expect(stopListening).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(4 * PDF_RECHECK_MS);
  expect(recheck).not.toHaveBeenCalled();
  renderHook(() => useProjectPdfWatch(null, "out/main.pdf", false, recheck));
  vi.advanceTimersByTime(4 * PDF_RECHECK_MS);
  expect(recheck).not.toHaveBeenCalled();
});
