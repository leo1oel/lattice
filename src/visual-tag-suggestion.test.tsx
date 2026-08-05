/*
 * Unit tests for the pure halves of visual-tag-suggestion.tsx — the
 * boundary matcher, the ranking, and the item builder. Popup lifecycle
 * and keyboard flow are covered by the editor-level tests in
 * visual-markdown-editor.test.tsx.
 */
import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { sharedExtensions } from "./open-knowledge-core/extensions/shared.ts";
import type { TagSummaryEntry } from "./markdown-workspace-index";
import { buildTagSuggestionItems, rankTagsByQuery, tagMatcher } from "./visual-tag-suggestion";

const schema = getSchema(sharedExtensions);

/** Resolve the cursor at the end of a single-paragraph doc carrying `content`. */
function positionAtEnd(content: string) {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, content ? [schema.text(content)] : []),
  ]);
  return doc.resolve(doc.content.size - 1);
}

function summary(name: string, count = 1, isLeaf = true): TagSummaryEntry {
  return { name, count, isLeaf };
}

describe("tagMatcher", () => {
  it("triggers on a bare `#` at start of block", () => {
    const match = tagMatcher({ $position: positionAtEnd("#") });
    expect(match).toEqual({ range: { from: 1, to: 2 }, query: "", text: "#" });
  });

  it("triggers after whitespace and captures the typed body", () => {
    const match = tagMatcher({ $position: positionAtEnd("see #proj") });
    expect(match?.query).toBe("proj");
    expect(match?.text).toBe("#proj");
    // The range starts at the `#`, not at the whitespace boundary.
    expect(match?.range.from).toBe(5);
  });

  it("does NOT trigger for the `# ` heading shortcut", () => {
    expect(tagMatcher({ $position: positionAtEnd("# ") })).toBeNull();
    expect(tagMatcher({ $position: positionAtEnd("## ") })).toBeNull();
  });

  it("does NOT trigger mid-word", () => {
    expect(tagMatcher({ $position: positionAtEnd("abc#foo") })).toBeNull();
  });

  it("does NOT trigger on a leading digit body", () => {
    expect(tagMatcher({ $position: positionAtEnd("#9lives") })).toBeNull();
  });

  it("keeps matching hierarchy separators inside the body", () => {
    const match = tagMatcher({ $position: positionAtEnd("#proj/team-2026") });
    expect(match?.query).toBe("proj/team-2026");
  });
});

describe("rankTagsByQuery", () => {
  const tags = [summary("project", 2), summary("proj/team", 5), summary("other", 9)];

  it("returns every tag for an empty query without mutating the input", () => {
    const input = [summary("b"), summary("a")];
    // Equal tiers and counts fall through to the alphabetical tiebreak.
    expect(rankTagsByQuery(input, "").map((t) => t.name)).toEqual(["a", "b"]);
    expect(input.map((t) => t.name)).toEqual(["b", "a"]);
  });

  it("ranks prefix matches before substring matches, then by count", () => {
    expect(rankTagsByQuery(tags, "pro").map((t) => t.name)).toEqual(["proj/team", "project"]);
    expect(rankTagsByQuery(tags, "o").map((t) => t.name)).toEqual(["other", "proj/team", "project"]);
  });

  it("filters case-insensitively while keeping the case-sensitive names", () => {
    expect(rankTagsByQuery([summary("Project")], "proj").map((t) => t.name)).toEqual(["Project"]);
  });
});

describe("buildTagSuggestionItems", () => {
  it("caps existing matches and appends a create affordance for a valid new name", () => {
    const tags = Array.from({ length: 12 }, (_, i) => summary(`tag${i}`, 100 - i));
    const items = buildTagSuggestionItems(tags, "brand-new");
    expect(items).toEqual([{ kind: "create", value: "brand-new" }]);
    const capped = buildTagSuggestionItems(tags, "tag");
    // 8 capped matches + the create affordance (`tag` itself is valid and not indexed).
    expect(capped).toHaveLength(9);
    expect(capped.slice(0, 8).every((item) => item.kind === "tag")).toBe(true);
    expect(capped[8]).toEqual({ kind: "create", value: "tag" });
  });

  it("does NOT offer create when the query already exists verbatim (case-sensitive)", () => {
    const items = buildTagSuggestionItems([summary("project")], "project");
    expect(items).toEqual([{ kind: "tag", value: "project", count: 1, isLeaf: true }]);
  });

  it("DOES offer create for a case-variant of an existing tag", () => {
    const items = buildTagSuggestionItems([summary("project")], "Project");
    expect(items).toContainEqual({ kind: "create", value: "Project" });
  });

  it("does NOT offer create for names the parser would reject", () => {
    expect(buildTagSuggestionItems([], "9lives")).toEqual([]);
    expect(buildTagSuggestionItems([], "-lead")).toEqual([]);
  });
});
