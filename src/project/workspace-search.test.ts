import { describe, expect, it } from "vitest";
import { PageSearchIndex, type SearchablePage } from "./workspace-search";

const page = (path: string, title = path.split("/").pop() ?? path, content = ""): SearchablePage => ({ path, title, content });

function search(pages: SearchablePage[], query: string, limit = 20): string[] {
  const index = new PageSearchIndex();
  index.update(pages);
  return index.search(query, limit).map((result) => result.path);
}

describe("page autocomplete", () => {
  it("ranks an exact name, then name prefixes, folders, and names containing the query", () => {
    const pages = [
      page("notes/zeta", "Paper"),
      page("archive/weekly", "Weekly"),
      page("alpha-two", "Alpha two"),
      page("x/alpha", "Something"),
      page("letters", "Xalpha"),
      page("alphabet/notes", "Notes"),
    ];
    expect(search(pages, "alpha")).toEqual(["x/alpha", "alpha-two", "alphabet/notes", "letters"]);
    expect(search(pages, "arch")).toEqual(["archive/weekly"]);
  });

  it("matches names, never body text", () => {
    expect(search([page("a", "Alpha", "mentions beta"), page("b", "Beta")], "beta")).toEqual(["b"]);
    expect(search([page("a", "Alpha", "zzz")], "zzz")).toEqual([]);
    expect(search([page("a", "Alpha")], "   ")).toEqual([]);
  });

  it("prefers shorter and rarer names among equal matches and breaks ties by path", () => {
    const pages = [page("d", "Alpha one two three"), page("b", "Alpha one"), page("c", "Alpha"), page("a", "Alpha one")];
    expect(search(pages, "alp")).toEqual(["c", "a", "b", "d"]);
  });

  it("puts pages in hidden folders after visible ones, but not agent skill bundles", () => {
    const pages = [
      page(".research/papers/1/target", "Target"),
      page(".claude/skills/review/SKILL", "Target"),
      page("notes/target-notes", "Target notes"),
    ];
    expect(search(pages, "target")).toEqual([".claude/skills/review/SKILL", "notes/target-notes", ".research/papers/1/target"]);
  });

  it("ranks a phrase match first and keeps only a short tail of pages sharing some words", () => {
    const pages = [
      page("gnn", "Graph neural networks"),
      page("theory", "Graph theory"),
      ...Array.from({ length: 8 }, (_, index) => page(`n${index}`, `Neural note ${index}`)),
    ];
    const results = search(pages, "graph neural");
    expect(results[0]).toBe("gnn");
    expect(results).toHaveLength(7);
  });

  it("treats accented Latin vowels as plain letters and other accents as word breaks", () => {
    expect(search([page("x", "Café culture"), page("y", "Other")], "cafe zzz")).toEqual(["x"]);
    expect(search([page("x", "Über design"), page("y", "Other")], "ber zzz")).toEqual(["x"]);
  });

  it("finds words inside titles written without spaces", () => {
    const pages = [page("zh", "量子计算研究"), page("cs", "计算机科学"), page("ml", "机器学习笔记")];
    expect(search(pages, "计算")).toEqual(["cs", "zh"]);
    expect(search(pages, "机器")).toEqual(["ml"]);
  });

  it("follows title and membership changes across updates", () => {
    const index = new PageSearchIndex();
    index.update([page("a", "Alpha"), page("b", "Beta")]);
    index.update([page("a", "Gamma"), page("c", "Alpha")]);
    expect(index.search("alpha", 8).map((result) => result.path)).toEqual(["c"]);
    expect(index.search("gam", 8).map((result) => result.path)).toEqual(["a"]);
  });
});
