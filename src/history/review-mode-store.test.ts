import { describe, expect, it, vi } from "vitest";
import { createReviewModeStore } from "./review-mode-store";

/** A store over a fake host whose project files are `disk`; `excluded` are the ones the host leaves out of review. */
function store(disk: Record<string, string>, bases: Record<string, string> | null = null, excluded: string[] = []) {
  const call = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "review_mode_load": return bases ? { startedAt: "2026-11-08T00:00:00Z", bases, excluded } : null;
      case "review_mode_start": {
        const kept = Object.fromEntries(Object.entries(disk).filter(([path]) => !excluded.includes(path)));
        return { startedAt: "2026-11-08T00:00:00Z", bases: kept, excluded };
      }
      case "review_mode_files": return { ...disk };
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
    expect(review.get()).toMatchObject({ root: "/project", active: true, marked: true });
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

  it("takes a file a co-author made on Overleaf as theirs, not the writer's", async () => {
    const disk: Record<string, string> = { "main.tex": "Hello.\n" };
    const { review } = store(disk);
    await review.load("/project");
    await review.start();
    const before = await review.beforeSync();
    disk["appendix.tex"] = "The co-author's appendix.\n";
    await review.afterSync(before, ["appendix.tex"]);
    // Its base is its text: nothing in it is marked as the writer's insertion.
    expect(review.baseFor("appendix.tex")).toBe("The co-author's appendix.\n");
  });

  it("moves forward the base of a file the writer made since, with a co-author's edit to it", async () => {
    const disk: Record<string, string> = { "main.tex": "Hello.\n" };
    const { review } = store(disk);
    await review.load("/project");
    await review.start();
    // The writer makes a file after turning review mode on: all of it is theirs.
    disk["notes.tex"] = "My notes.\n";
    expect(review.baseFor("notes.tex")).toBe("");
    const before = await review.beforeSync();
    disk["notes.tex"] = "My notes.\nTheir line.\n";
    await review.afterSync(before, ["notes.tex"]);
    // Only the writer's text is left to review.
    expect(review.baseFor("notes.tex")).toBe("Their line.\n");
  });

  it("never tracks a file the host left out of review, nor takes a base for it", async () => {
    const disk: Record<string, string> = { "main.tex": "Hello.\n", "table.tex": "generated rows\n" };
    const { review, call } = store(disk, null, ["table.tex"]);
    await review.load("/project");
    await review.start();
    expect(review.baseFor("main.tex")).toBe("Hello.\n");
    expect(review.baseFor("table.tex")).toBeNull();
    review.setBase("table.tex", "anything");
    const before = await review.beforeSync();
    disk["table.tex"] = "more generated rows\n";
    await review.afterSync(before, ["table.tex"]);
    await review.flush();
    expect(review.baseFor("table.tex")).toBeNull();
    expect(call).not.toHaveBeenCalledWith("review_mode_save_base", expect.anything());
    // A path deeper than the host looks is not tracked either.
    expect(review.baseFor("a/b/c/d/e/f/g/h/deep.tex")).toBeNull();
  });

  it("shows the changes in the PDF whenever review mode is on or turned on, until the writer asks for the clean PDF", async () => {
    const { review } = store({ "main.tex": "x" }, { "main.tex": "x" });
    await review.load("/project");
    expect(review.get()).toMatchObject({ active: true, marked: true });
    review.setMarked(false);
    // Read again for the same project: the writer's choice stands.
    await review.load("/project");
    expect(review.get().marked).toBe(false);
    await review.stop();
    expect(review.get().marked).toBe(false);
    await review.start();
    expect(review.get().marked).toBe(true);
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
