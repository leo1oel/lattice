import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addToPaperNote, paperNotePath, withPaperNoteEntry } from "./paper-notes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const paper = { arxivId: "1706.03762", citationKey: "vaswani2017attention", title: "Attention Is All You Need", hasFullText: true };

describe("a paper's note", () => {
  it("is named by the citation key, else the library id, as a safe project path", () => {
    expect(paperNotePath(paper)).toBe("notes/vaswani2017attention.md");
    expect(paperNotePath({ arxivId: "web-0123", citationKey: undefined })).toBe("notes/web-0123.md");
    expect(paperNotePath({ arxivId: "x", citationKey: "../a b:c/d" })).toBe("notes/a-b-c-d.md");
    expect(paperNotePath({ arxivId: "张三2024", citationKey: " " })).toBe("notes/张三2024.md");
  });

  it("starts with the paper's title linking to the paper, then appends each entry after a blank line", () => {
    const first = withPaperNoteEntry(null, paper, "> one [p. 1](x)");
    expect(first).toBe("# Attention Is All You Need\n\n[Attention Is All You Need](../.research/papers/1706.03762/paper.md)\n\n> one [p. 1](x)\n");
    expect(withPaperNoteEntry(first, paper, "> two")).toBe(`${first}\n> two\n`);
    expect(withPaperNoteEntry("My notes\n\n\n", paper, "> two")).toBe("My notes\n\n> two\n");
    expect(withPaperNoteEntry("", paper, "> two")).toBe("> two\n");
  });

  describe("adding to it", () => {
    const calls = () => vi.mocked(invoke).mock.calls;
    beforeEach(() => vi.mocked(invoke).mockReset());

    it("writes a new note without a base", async () => {
      vi.mocked(invoke).mockImplementation(async (command) => (command === "stat_project_file" ? { exists: false } : undefined));
      await expect(addToPaperNote("/p", paper, "> q")).resolves.toBe("notes/vaswani2017attention.md");
      expect(calls().map(([command]) => command)).toEqual(["stat_project_file", "write_project_file"]);
      expect(calls()[1][1]).toEqual({ path: "notes/vaswani2017attention.md", projectRoot: "/p", content: expect.stringContaining("> q\n") });
    });

    it("merges onto what it read, so an edit made meanwhile survives", async () => {
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === "stat_project_file") return { exists: true };
        if (command === "read_project_file") return "# Mine\n";
        return undefined;
      });
      await addToPaperNote("/p", paper, "> q");
      expect(calls().at(-1)?.[1]).toEqual({ path: "notes/vaswani2017attention.md", projectRoot: "/p", content: "# Mine\n\n> q\n", baseContent: "# Mine\n" });
    });
  });
});
