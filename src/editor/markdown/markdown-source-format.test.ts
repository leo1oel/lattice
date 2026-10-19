import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  markdownSelectionFormat, setMarkdownBlock, toggleMarkdownInline, type MarkdownBlockType, type MarkdownInlineFormat,
} from "./markdown-source-format";

/** A state from `doc`, where `«` and `»` mark the selection (and are removed). */
function stateOf(marked: string) {
  const from = marked.indexOf("«");
  const to = marked.indexOf("»") - 1;
  const doc = marked.slice(0, from) + marked.slice(from + 1, to + 1) + marked.slice(to + 2);
  return EditorState.create({ doc, selection: { anchor: from, head: to } });
}

/** The document after the command, with the selection marked the same way. */
function apply(state: EditorState, spec: ReturnType<typeof toggleMarkdownInline>) {
  if (!spec) return null;
  const next = state.update(spec).state;
  const { from, to } = next.selection.main;
  const doc = next.doc.toString();
  return `${doc.slice(0, from)}«${doc.slice(from, to)}»${doc.slice(to)}`;
}

const inline = (marked: string, format: MarkdownInlineFormat) => {
  const state = stateOf(marked);
  return apply(state, toggleMarkdownInline(state, format));
};
const block = (marked: string, type: MarkdownBlockType) => {
  const state = stateOf(marked);
  return apply(state, setMarkdownBlock(state, type));
};

describe("toggleMarkdownInline", () => {
  it.each([
    ["bold", "a **«word»** b"],
    ["italic", "a *«word»* b"],
    ["underline", "a <u>«word»</u> b"],
    ["strike", "a ~~«word»~~ b"],
    ["code", "a `«word»` b"],
    ["highlight", "a ==«word»== b"],
    ["math", "a $«word»$ b"],
  ] as const)("wraps the selection in %s and takes it off again", (format, wrapped) => {
    expect(inline("a «word» b", format)).toBe(wrapped);
    expect(inline(wrapped, format)).toBe("a «word» b");
  });

  it("takes a format off a selection that holds its markers", () => {
    expect(inline("a «**word**» b", "bold")).toBe("a «word» b");
    expect(inline("a «~~word~~» b", "strike")).toBe("a «word» b");
  });

  it("tells bold, italic and both apart", () => {
    expect(inline("**«word»**", "italic")).toBe("***«word»***");
    expect(inline("*«word»*", "bold")).toBe("***«word»***");
    expect(inline("***«word»***", "bold")).toBe("*«word»*");
    expect(inline("***«word»***", "italic")).toBe("**«word»**");
    expect(inline("__«word»__", "bold")).toBe("«word»");
  });

  it("keeps the selection's edge whitespace outside the markers", () => {
    expect(inline("a« word »b", "bold")).toBe("a **«word»** b");
  });

  it("wraps each line of a selection over several", () => {
    expect(inline("«one\n\ntwo»", "bold")).toBe("**«one**\n\n**two»**");
    expect(inline("«**one**\n\n**two**»", "bold")).toBe("«one\n\ntwo»");
    // Only some lines bold: the rest become bold too.
    expect(inline("«**one**\n\ntwo»", "bold")).toBe("«**one**\n\n**two»**");
  });

  it("makes a link with the caret waiting for its destination, and unlinks one", () => {
    expect(inline("see «paper» now", "link")).toBe("see [paper](«») now");
    expect(inline("see [«paper»](https://x.org) now", "link")).toBe("see «paper» now");
    expect(inline("see «[paper](https://x.org)» now", "link")).toBe("see «paper» now");
  });

  it("declines a selection of only whitespace", () => {
    expect(toggleMarkdownInline(stateOf("a«  »b"), "bold")).toBeNull();
  });
});

describe("setMarkdownBlock", () => {
  it("sets a heading level, keeping the selection on the text", () => {
    expect(block("Some «text»", "heading-2")).toBe("## Some «text»");
    expect(block("## Some «text»", "heading-4")).toBe("#### Some «text»");
    expect(block("## Some «text»", "heading-2")).toBeNull();
    expect(block("## Some «text»", "text")).toBe("Some «text»");
  });

  it("toggles lists over every line, numbering an ordered one", () => {
    expect(block("«one\ntwo\n\nthree»", "bullet-list")).toBe("- «one\n- two\n\n- three»");
    expect(block("- «one\n- two»", "bullet-list")).toBe("«one\ntwo»");
    expect(block("- «one\n- two»", "ordered-list")).toBe("1. «one\n2. two»");
    expect(block("«one»", "task-list")).toBe("- [ ] «one»");
    expect(block("- [ ] «one»", "task-list")).toBe("«one»");
  });

  it("quotes lines, keeping their list markers, and unquotes them", () => {
    expect(block("- «one\n- two»", "quote")).toBe("> - «one\n> - two»");
    expect(block("> «one»", "quote")).toBe("«one»");
    expect(block("> - «one»", "text")).toBe("«one»");
  });

  it("fences lines as a code block and takes the fences off again", () => {
    expect(block("a\n«code»\nb", "code-block")).toBe("a\n```\n«code»\n```\nb");
    expect(block("a\n```\n«code»\n```\nb", "code-block")).toBe("a\n«code»\nb");
    expect(block("```\n«code»\n```", "heading-1")).toBe("# «code»");
  });

  it("leaves out a line the selection only reaches the start of", () => {
    expect(block("«one\n»two", "bullet-list")).toBe("- «one\n»two");
  });
});

describe("markdownSelectionFormat", () => {
  it("reports the inline formats every selected line has", () => {
    expect([...markdownSelectionFormat(stateOf("***«word»*** b")).inline].sort()).toEqual(["bold", "italic"]);
    expect([...markdownSelectionFormat(stateOf("**«one**\ntwo»")).inline]).toEqual([]);
    expect([...markdownSelectionFormat(stateOf("a [«x»](u) b")).inline]).toEqual(["link"]);
  });

  it("reports the first line's block type", () => {
    expect(markdownSelectionFormat(stateOf("### «title»")).block).toBe("heading-3");
    expect(markdownSelectionFormat(stateOf("> - [ ] «task»")).block).toBe("task-list");
    expect(markdownSelectionFormat(stateOf("> «quote»")).block).toBe("quote");
    expect(markdownSelectionFormat(stateOf("1. «item»")).block).toBe("ordered-list");
    expect(markdownSelectionFormat(stateOf("«plain»")).block).toBe("text");
  });

  it("knows a selection inside a fenced code block", () => {
    expect(markdownSelectionFormat(stateOf("```js\n«code»\n```"))).toMatchObject({ block: "code-block", inCode: true });
    expect(markdownSelectionFormat(stateOf("```\nx\n```\n«after»"))).toMatchObject({ block: "text", inCode: false });
  });
});
