import { describe, expect, it, vi } from "vitest";
import { createReviewModeStore } from "./review-mode-store";

/** A store over a fake host whose project files are `disk`. */
function store(disk: Record<string, string>, bases: Record<string, string> | null = null) {
  const call = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "review_mode_load": return bases ? { startedAt: "2026-11-08T00:00:00Z", bases } : null;
      case "review_mode_start": return { startedAt: "2026-11-08T00:00:00Z", bases: { ...disk } };
      case "read_project_file": return disk[String(args?.path)] ?? null;
      default: return null;
    }
  });
  return { review: createReviewModeStore(call as never), call };
}

describe("review mode's store", () => {
  it("reads whether a project is in review mode, and its bases with the editor's line breaks", async () => {
    const { review } = store({}, { "main.tex": "One\r\nTwo\r\n" });
    await review.load("/project");
    expect(review.get()).toMatchObject({ root: "/project", active: true });
    expect(review.baseFor("main.tex")).toBe("One\nTwo\n");
    expect(review.baseFor("figure.png")).toBeNull();

    await review.load(null);
    expect(review.get().active).toBe(false);
    expect(review.baseFor("main.tex")).toBeNull();
  });

  it("takes the open file's unsaved text as its base when turned on", async () => {
    const { review } = store({ "main.tex": "Saved.\n", "intro.tex": "Intro.\n" });
    await review.load("/project");
    await review.start({ path: "main.tex", text: "Saved, then typed.\n" });
    expect(review.baseFor("main.tex")).toBe("Saved, then typed.\n");
    expect(review.baseFor("intro.tex")).toBe("Intro.\n");
  });

  it("moves a closed file's base forward with what an Overleaf sync pulled into it", async () => {
    const disk = { "main.tex": "The model is fast.\nIt is small.\n" };
    const { review } = store(disk);
    await review.load("/project");
    await review.start();
    // The writer's own edit, saved to disk.
    disk["main.tex"] = "The model is quick.\nIt is small.\n";
    const before = await review.beforeSync();
    // The sync merges a co-author's edit in.
    disk["main.tex"] = "The model is quick.\nIt is tiny.\n";
    await review.afterSync(before, ["main.tex"]);
    expect(review.baseFor("main.tex")).toBe("The model is fast.\nIt is tiny.\n");
  });

  it("names a co-author's text for an open file once, and forgets it after a while", async () => {
    vi.useFakeTimers();
    const { review } = store({ "main.tex": "x" });
    await review.load("/project");
    await review.start();
    review.noteCoauthorText("main.tex", "remote\r\ntext");
    expect(review.takeCoauthorText("main.tex", (text) => text === "other")).toBe(false);
    expect(review.takeCoauthorText("main.tex", (text) => text === "remote\ntext")).toBe(true);
    expect(review.takeCoauthorText("main.tex", () => true)).toBe(false);

    review.noteCoauthorText("main.tex", "late");
    vi.advanceTimersByTime(11_000);
    expect(review.takeCoauthorText("main.tex", () => true)).toBe(false);
    vi.useRealTimers();
  });

  it("asks before turning off and leaves review mode on when the writer declines", async () => {
    const { review, call } = store({ "main.tex": "x" });
    await review.load("/project");
    await review.start();
    // No dialog is mounted in a test: the native fallback answers no.
    await review.confirmStop().catch(() => undefined);
    expect(review.get().active).toBe(true);
    await review.stop();
    expect(review.get()).toMatchObject({ active: false, marked: false });
    expect(call).toHaveBeenLastCalledWith("review_mode_stop", { projectRoot: "/project" });
  });
});
