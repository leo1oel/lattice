import { describe, expect, test, vi } from "vitest";
import type { FileNode } from "../../app-types";
import { MarkdownWorkspaceIndex } from "./markdown-workspace-index";

const file = (path: string): FileNode => ({ name: path.split("/").pop() ?? path, path, kind: "file", contentKind: "text", children: [] });

async function indexOf(contents: Record<string, string>) {
  const index = new MarkdownWorkspaceIndex(async (path) => contents[path]);
  await index.update(Object.keys(contents).map(file));
  return index;
}

const paths = (index: MarkdownWorkspaceIndex) => index.searchPages("").map((doc) => doc.path);

describe("MarkdownWorkspaceIndex", () => {
  test("extracts titles and disambiguated headings while skipping frontmatter and fences", async () => {
    const index = await indexOf({
      "notes/foo.md": ["---", "# Frontmatter heading", "---", "# Document title", "## Repeat", "```md", "# Hidden", "```", "## Repeat"].join("\n"),
      "untitled.mdx": "Some text",
    });

    expect(index.getDoc("NOTES/FOO.MD")).toMatchObject({
      path: "notes/foo.md",
      docName: "notes/foo",
      title: "Document title",
      headings: [
        { level: 1, text: "Document title", slug: "document-title" },
        { level: 2, text: "Repeat", slug: "repeat" },
        { level: 2, text: "Repeat", slug: "repeat-1" },
      ],
    });
    expect(index.getDoc("untitled")?.title).toBe("untitled");
    expect(index.contentFor("untitled")).toBe("Some text");
  });

  test("leaves headings without text or slug out of the title and anchors", async () => {
    const index = await indexOf({ "blank.md": ["#", "# #", "## !!!", "# Real", "## Part"].join("\n"), "empty.md": "#\n\nBody" });

    expect(index.getDoc("blank")).toMatchObject({
      title: "Real",
      headings: [{ level: 1, text: "Real", slug: "real" }, { level: 2, text: "Part", slug: "part" }],
    });
    expect(index.getDoc("empty")?.title).toBe("empty");
  });

  test("ranks an exact title first and preserves source order for an empty query", async () => {
    const index = await indexOf({ "z.md": "# Alpha details\nAlpha is mentioned here.", "a.md": "# Alpha", "m.md": "# Other" });

    expect(index.searchPages("Alpha")[0]?.docName).toBe("a");
    expect(index.searchPages("", 2).map((doc) => doc.docName)).toEqual(["z", "a"]);
  });

  test("autocompletes non-Latin and mixed-script page titles", async () => {
    const index = await indexOf({ "zh.md": "# 量子计算研究", "mixed.md": "# Project 東京 Notes", "other.md": "# Project Notes" });

    expect(index.searchPages("量子计算").map((doc) => doc.docName)).toEqual(["zh"]);
    expect(index.searchPages("project 東京")[0]?.docName).toBe("mixed");
  });

  test("applies live changes and indexes new documents, but does not republish unchanged content", async () => {
    const index = await indexOf({ "source.md": "# Old" });
    const listener = vi.fn();
    index.subscribe(listener);
    index.noteDocumentContent("source.md", "# Old");
    expect(listener).not.toHaveBeenCalled();
    index.noteDocumentContent("source.md", "# New");
    index.noteDocumentContent("added.md", "# Added");

    expect(index.getDoc("source")?.headings).toEqual([{ level: 1, text: "New", slug: "new" }]);
    expect(paths(index)).toEqual(["source.md", "added.md"]);
  });

  // The index is mutated in place and never changes identity, so a render that
  // wants fresh content cannot depend on the prop — it has to subscribe and read
  // the value it draws. That only works if every mutation notifies and the
  // reader is already current when the listener runs, which is what this pins.
  test("publishes the new source to subscribers on both mutation paths until they unsubscribe", async () => {
    const index = new MarkdownWorkspaceIndex(async () => "# First");
    const seen: (string | undefined)[] = [];
    const unsubscribe = index.subscribe(() => seen.push(index.contentFor("source")));
    await index.update([file("source.md")]);
    index.noteDocumentContent("source.md", "# Second");
    index.noteDocumentContent("source.md", "# Third");

    expect(seen).toEqual(["# First", "# Second", "# Third"]);
    unsubscribe();
    index.noteDocumentContent("source.md", "# Renamed");
    expect(seen).toHaveLength(3);
  });

  test("coalesces concurrent updates and leaves the newest snapshot indexed", async () => {
    let releaseFirst!: (content: string) => void;
    const firstRead = new Promise<string>((resolve) => { releaseFirst = resolve; });
    const readFile = vi.fn((path: string) => path === "old.md" ? firstRead : Promise.resolve("# New"));
    const index = new MarkdownWorkspaceIndex(readFile);

    const first = index.update([file("old.md")]);
    const second = index.update([file("new.md")]);
    releaseFirst("# Old");
    await Promise.all([first, second]);

    expect(paths(index)).toEqual(["new.md"]);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  test("skips files that cannot be read", async () => {
    const index = new MarkdownWorkspaceIndex(async (path) => {
      if (path === "bad.md") throw new Error("unreadable");
      return "# Good";
    });
    await index.update([file("bad.md"), file("good.md")]);
    expect(paths(index)).toEqual(["good.md"]);
  });
});
