import { describe, expect, test, vi } from "vitest";
import type { FileNode } from "./app-types";
import { MarkdownWorkspaceIndex } from "./markdown-workspace-index";

function file(path: string): FileNode {
  return {
    name: path.split("/").pop() ?? path,
    path,
    kind: "file",
    contentKind: "text",
    children: [],
  };
}

function reader(contents: Record<string, string>) {
  return async (path: string) => contents[path];
}

describe("MarkdownWorkspaceIndex", () => {
  test("extracts titles and disambiguated headings while skipping frontmatter and fences", async () => {
    const index = new MarkdownWorkspaceIndex(
      reader({
        "notes/foo.md": [
          "---",
          "# Frontmatter heading",
          "---",
          "# Document title",
          "## Repeat",
          "```md",
          "# Hidden",
          "```",
          "## Repeat",
        ].join("\n"),
        "untitled.mdx": "Some text",
      }),
    );

    await index.update([file("notes/foo.md"), file("untitled.mdx")]);

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
    expect(index.previewDocuments()).toEqual([
      { path: "notes/foo.md", content: expect.stringContaining("# Document title") },
      { path: "untitled.mdx", content: "Some text" },
    ]);
  });

  test("extracts wiki and relative Markdown links and resolves backlinks", async () => {
    const contents = {
      "notes/source.md": [
        "[[target#Section|Alias]] [[folder/target]]",
        "[parent](../target.md#top)",
        "```",
        "[[ignored]] [ignored](../ignored.md)",
        "```",
      ].join("\n"),
      "folder/target.md": "# Target",
      "target.md": "# Root target",
    };
    const index = new MarkdownWorkspaceIndex(reader(contents));
    await index.update(Object.keys(contents).map(file));

    expect(index.getDoc("notes/source")?.outgoing).toEqual([
      { target: "target", anchor: "Section", kind: "wiki" },
      { target: "folder/target", anchor: null, kind: "wiki" },
      { target: "target", anchor: "top", kind: "md" },
    ]);
    expect(index.backlinksFor("folder/target")).toEqual(["notes/source.md"]);
    expect(index.backlinksFor("target")).toEqual(["notes/source.md"]);
  });

  test("ranks an exact title first and preserves source order for an empty query", async () => {
    const contents = {
      "z.md": "# Alpha details\nAlpha is mentioned here.",
      "a.md": "# Alpha",
      "m.md": "# Other",
    };
    const index = new MarkdownWorkspaceIndex(reader(contents));
    await index.update([file("z.md"), file("a.md"), file("m.md")]);

    expect(index.searchPages("Alpha")[0]?.docName).toBe("a");
    expect(index.searchPages("", 2).map((doc) => doc.docName)).toEqual(["z", "a"]);
  });

  test("autocompletes non-Latin and mixed-script page titles", async () => {
    const index = new MarkdownWorkspaceIndex(
      reader({
        "zh.md": "# 量子计算研究",
        "mixed.md": "# Project 東京 Notes",
        "other.md": "# Project Notes",
      }),
    );
    await index.update([file("zh.md"), file("mixed.md"), file("other.md")]);

    expect(index.searchPages("量子计算").map((doc) => doc.docName)).toEqual(["zh"]);
    expect(index.searchPages("project 東京")[0]?.docName).toBe("mixed");
  });

  test("applies live content changes to headings and backlinks", async () => {
    const index = new MarkdownWorkspaceIndex(
      reader({ "source.md": "# Old", "target.md": "# Target" }),
    );
    await index.update([file("source.md"), file("target.md")]);

    index.noteDocumentContent("source.md", "# New\n[[target]]");

    expect(index.headingsFor("source")).toEqual([{ level: 1, text: "New", slug: "new" }]);
    expect(index.backlinksFor("target")).toEqual(["source.md"]);
  });

  test("does not rebuild the corpus when an editor reports unchanged content", async () => {
    const index = new MarkdownWorkspaceIndex(reader({ "notes.md": "# Notes" }));
    await index.update([file("notes.md")]);
    const revision = index.revision;
    const listener = vi.fn();
    index.subscribe(listener);

    index.noteDocumentContent("notes.md", "# Notes");

    expect(index.revision).toBe(revision);
    expect(listener).not.toHaveBeenCalled();
  });

  test("coalesces concurrent updates and leaves the newest snapshot indexed", async () => {
    let releaseFirst!: (content: string) => void;
    const firstRead = new Promise<string>((resolve) => {
      releaseFirst = resolve;
    });
    const readFile = vi.fn((path: string) =>
      path === "old.md" ? firstRead : Promise.resolve("# New"),
    );
    const index = new MarkdownWorkspaceIndex(readFile);

    const first = index.update([file("old.md")]);
    const second = index.update([file("new.md")]);
    releaseFirst("# Old");
    await Promise.all([first, second]);

    expect(index.docs.map((doc) => doc.path)).toEqual(["new.md"]);
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  test("skips files that cannot be read", async () => {
    const index = new MarkdownWorkspaceIndex(async (path) => {
      if (path === "bad.md") throw new Error("unreadable");
      return "# Good";
    });
    await index.update([file("bad.md"), file("good.md")]);
    expect(index.docs.map((doc) => doc.path)).toEqual(["good.md"]);
  });

  test("treats inline hashtags as body text rather than tag metadata", async () => {
    const index = new MarkdownWorkspaceIndex(
      reader({
        "a.md": [
          "Model statistics: #Params, #Tokens, and #Samples",
          "#alpha mid#word #beta/gamma",
          "`#code-span` and text",
          "```md",
          "#fenced",
          "```",
        ].join("\n"),
      }),
    );
    await index.update([file("a.md")]);

    expect(index.getDoc("a")?.tags).toEqual([]);
  });

  test("indexes frontmatter tags: flow list, scalar, and dash list shapes", async () => {
    const index = new MarkdownWorkspaceIndex(
      reader({
        "flow.md": ['---', 'tags: [alpha, "beta/gamma", #delta]', '---', 'body'].join("\n"),
        "scalar.md": ["---", "tags: solo", "---", "body"].join("\n"),
        "dash.md": ["---", "tags:", "  - one", "  - two/three", "title: x", "---", "body"].join("\n"),
        "invalid.md": ["---", "tags: [ok, has space]", "---", "body"].join("\n"),
      }),
    );
    await index.update([file("flow.md"), file("scalar.md"), file("dash.md"), file("invalid.md")]);

    expect(index.getDoc("flow")?.tags.sort()).toEqual(["alpha", "beta/gamma", "delta"]);
    expect(index.getDoc("scalar")?.tags).toEqual(["solo"]);
    expect(index.getDoc("dash")?.tags.sort()).toEqual(["one", "two/three"]);
    expect(index.getDoc("invalid")?.tags).toEqual(["ok"]);
  });

  test("tagSummaries rolls hierarchy prefixes up with cumulative doc counts", async () => {
    const index = new MarkdownWorkspaceIndex(
      reader({
        "a.md": "---\ntags: [proj/team, proj]\n---\nbody\n",
        "b.md": "---\ntags: [proj/team]\n---\nbody\n",
        "c.md": "no tags\n",
      }),
    );
    await index.update([file("a.md"), file("b.md"), file("c.md")]);

    expect(index.tagSummaries()).toEqual([
      { name: "proj", count: 3, isLeaf: true },
      { name: "proj/team", count: 2, isLeaf: true },
    ]);
  });

  test("tagSummaries marks pure prefixes as non-leaf", async () => {
    const index = new MarkdownWorkspaceIndex(reader({
      "a.md": "---\ntags: [parent/child]\n---\nbody\n",
    }));
    await index.update([file("a.md")]);

    expect(index.tagSummaries()).toEqual([
      { name: "parent", count: 1, isLeaf: false },
      { name: "parent/child", count: 1, isLeaf: true },
    ]);
  });
});
