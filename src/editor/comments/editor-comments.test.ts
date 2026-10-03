import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEditorComment,
  createEditorCommentReply,
  loadAuthorNameSetting,
  persistAuthorNameSetting,
  resolveAuthorName,
  resolveCommentAnchor,
  type EditorComment,
} from "./editor-comment-data";
import {
  buildCommentDecorations,
  buildCommentTooltipDom,
  commentMarkStyle,
  commentsAtPosition,
  editorCommentsExtension,
  formatCommentTimestamp,
  setEditorCommentDraftEffect,
} from "./editor-comments";

const SOURCE = "alpha beta gamma";

/** A comment on "beta" in SOURCE unless overridden. */
function comment(overrides: Partial<Parameters<typeof createEditorComment>[0]> = {}): EditorComment {
  return createEditorComment({
    path: "main.tex", source: SOURCE, from: 6, to: 10, body: "check", authorId: "author-a", authorName: "Ada",
    ...overrides,
  })!;
}

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

function mountView(getComments: () => EditorComment[], doc = SOURCE) {
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: editorCommentsExtension("main.tex", { getComments }) }),
  });
  views.push(view);
  return view;
}

describe("comment author name", () => {
  afterEach(() => localStorage.clear());

  it("signs with the Git name, then the Overleaf name, then the Your name setting", () => {
    expect(resolveAuthorName({ git: " Ada ", overleaf: "Robin", setting: "Sam" })).toBe("Ada");
    expect(resolveAuthorName({ git: "  ", overleaf: "Robin", setting: "Sam" })).toBe("Robin");
    expect(resolveAuthorName({ git: null, overleaf: null, setting: " Sam " })).toBe("Sam");
    expect(resolveAuthorName({})).toBe("");
  });

  it("keeps a name set in the retired Shares dialog until the setting is saved", () => {
    expect(loadAuthorNameSetting()).toBe("");
    localStorage.setItem("lattice.collab.name", "Grace");
    expect(loadAuthorNameSetting()).toBe("Grace");
    persistAuthorNameSetting("  Ada Lovelace ");
    expect(loadAuthorNameSetting()).toBe("Ada Lovelace");
    persistAuthorNameSetting("");
    expect(loadAuthorNameSetting()).toBe("");
  });
});

describe("editor comment data", () => {
  it("creates a comment with quote and context", () => {
    expect(comment({ source: "Hello bold world today", body: "Make this stronger", authorName: "Robin" })).toMatchObject({
      path: "main.tex",
      quote: "bold",
      prefix: "Hello ",
      suffix: " world today",
      body: "Make this stronger",
      authorName: "Robin",
      resolved: false,
      replies: [],
    });
  });

  it("trims reply bodies and rejects empty replies", () => {
    expect(createEditorCommentReply({ body: "  sure  ", authorId: "b", authorName: "Bo" })?.body).toBe("sure");
    expect(createEditorCommentReply({ body: "   ", authorId: "b", authorName: "Bo" })).toBeNull();
  });

  it.each([
    ["by quote when offsets drift", "prefix TARGET suffix", { from: 0, to: 1, quote: "TARGET", prefix: "aaa ", suffix: " bbb" }, { from: 7, to: 13 }],
    ["after text is inserted before its selection", "New: Hello bold world", { from: 6, to: 10, quote: "bold", prefix: "Hello ", suffix: " world" }, { from: 11, to: 15 }],
    ["when its quote is missing", "the selection was deleted", { from: 2, to: 6, quote: "same", prefix: "missing ", suffix: " context" }, null],
    ["when its quote is ambiguous", "same and same", { from: 2, to: 6, quote: "same", prefix: "missing ", suffix: " context" }, null],
    ["when its complete context is ambiguous", "before TARGET after / before TARGET after", { from: 2, to: 8, quote: "TARGET", prefix: "before ", suffix: " after" }, null],
  ])("resolves a pending anchor %s", (_name, source, anchor, expected) => {
    expect(resolveCommentAnchor(source, anchor)).toEqual(expected);
  });
});

describe("editor comment decorations", () => {
  it("builds unresolved comment decorations with per-author colors", () => {
    const open = comment();
    expect(buildCommentDecorations(SOURCE, "main.tex", [open, { ...open, id: "resolved", resolved: true }]).size).toBe(1);
    expect(commentMarkStyle(open)).toContain("border-bottom: 2px solid");
    expect(commentMarkStyle(open)).not.toEqual(commentMarkStyle({ ...open, authorId: "author-b" }));
  });

  it("finds the comments covering a hovered position", () => {
    const beta = comment();
    const other = comment({ path: "other.tex" });
    const ids = (comments: EditorComment[], pos: number) =>
      commentsAtPosition(SOURCE, "main.tex", comments, pos).map((hit) => hit.comment.id);
    expect(ids([beta, other, { ...beta, id: "resolved", resolved: true }], 7)).toEqual([beta.id]);
    expect(ids([beta], 2)).toEqual([]);
    expect(ids([other], 7)).toEqual([]);
    // Two comments meeting at a shared boundary are not double-matched.
    const first = comment({ source: "alphabeta", from: 0, to: 5, body: "one" });
    const second = comment({ source: "alphabeta", from: 5, to: 9, body: "two" });
    expect(commentsAtPosition("alphabeta", "main.tex", [first, second], 5).map((hit) => hit.comment.body))
      .toEqual(["two"]);
  });

  it("marks a draft, reanchors it after edits, and cancels without removing an overlapping comment", () => {
    const existing = comment({ source: "Hello bold world" });
    const view = mountView(() => [existing], "Hello bold world");
    view.dispatch({ effects: setEditorCommentDraftEffect.of(existing) });
    expect(view.dom.querySelector(".editor-comment-draft")?.textContent).toBe("bold");
    expect(view.dom.querySelector(".editor-comment-draft")).not.toHaveAttribute("data-comment-id");
    view.dispatch({ changes: { from: 0, insert: "New: " } });
    expect(view.dom.querySelector(".editor-comment-draft")?.textContent).toBe("bold");
    view.dispatch({ effects: setEditorCommentDraftEffect.of(null) });
    expect(view.dom.querySelector(".editor-comment-draft")).toBeNull();
    expect(view.dom.querySelector(".cm-editor-comment")?.textContent).toBe("bold");
  });

  it("seeds decorations from a live getter, keeps the empty fast path live, and restores marks after a reset", () => {
    // With zero comments the field skips doc serialization entirely on every
    // doc change; this guards the transition out of that fast path.
    const comments: EditorComment[] = [];
    const view = mountView(() => comments);
    view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });
    expect(view.dom.querySelector(".cm-editor-comment")).toBeNull();
    comments.push(comment({ source: view.state.doc.toString(), from: 7, to: 11 }));
    // Any transaction re-reads the getter; the marks must materialize.
    view.dispatch({ changes: { from: 0, to: 1, insert: "" } });
    expect(view.dom.querySelector(".cm-editor-comment")).not.toBeNull();
    // The hover tooltip replaces a native title on the mark.
    expect(view.dom.querySelector(".cm-editor-comment")?.getAttribute("title")).toBeNull();
    // Fresh state (same as a reconfigure wipe) should still show marks via the getter.
    view.setState(EditorState.create({
      doc: SOURCE,
      extensions: editorCommentsExtension("main.tex", { getComments: () => comments }),
    }));
    expect(view.dom.querySelector(".cm-editor-comment")?.textContent).toBe("beta");
  });
});

describe("editor comment tooltip", () => {
  it("renders a read-only hover card with the author name and body", () => {
    const dom = buildCommentTooltipDom([comment({ body: "please clarify", authorName: "Ada Lovelace" })]);
    expect(dom.querySelector(".cm-editor-comment-tooltip-author")?.textContent).toBe("Ada Lovelace");
    expect(dom.querySelector(".cm-editor-comment-tooltip-body")?.textContent).toBe("please clarify");
    expect(dom.querySelector(".cm-editor-comment-tooltip-actions")).toBeNull();
  });

  it("renders reply threads and Resolve/Reply actions when actions are provided", () => {
    const item = {
      ...comment(),
      replies: [createEditorCommentReply({ body: "will do", authorId: "b", authorName: "Bo" })!],
    };
    const resolved: string[] = [];
    const replied: string[] = [];
    const dom = buildCommentTooltipDom([item], {
      onResolve: (id) => resolved.push(id),
      onReply: (target) => replied.push(target.id),
    });
    expect(dom.querySelector(".cm-editor-comment-tooltip-reply .cm-editor-comment-tooltip-body")?.textContent)
      .toBe("will do");
    const buttons = Array.from(dom.querySelectorAll<HTMLButtonElement>(".cm-editor-comment-tooltip-actions button"));
    expect(buttons.map((button) => button.textContent)).toEqual(["Resolve", "Reply"]);
    for (const button of buttons) button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(resolved).toEqual([item.id]);
    expect(replied).toEqual([item.id]);
  });

  it("uses localized labels in comment tooltips", () => {
    const dom = buildCommentTooltipDom(
      [{ ...comment(), authorName: "Anonymous", body: "" }],
      { onResolve: () => undefined, onReply: () => undefined },
      Date.parse("2026-01-01T12:00:00.000Z"),
      { locale: "zh-CN", anonymous: "匿名", noCommentText: "（无评论内容）", reopen: "重新打开", resolve: "解决评论", reply: "回复" },
    );
    expect(dom.textContent).toContain("匿名");
    expect(dom.textContent).toContain("（无评论内容）");
    expect(Array.from(dom.querySelectorAll("button"), (button) => button.textContent)).toEqual(["解决评论", "回复"]);
  });

  it("formats comment timestamps relative to now", () => {
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    expect(formatCommentTimestamp("2026-01-01T11:57:00.000Z", now)).toBe("3 minutes ago");
    expect(formatCommentTimestamp("2026-01-01T11:59:59.000Z", now)).toBe("now");
    expect(formatCommentTimestamp("2026-01-01T11:57:00.000Z", now, "zh-CN")).toBe("3分钟前");
    expect(formatCommentTimestamp("2026-01-01T09:00:00.000Z", now)).toBe("3 hours ago");
    expect(formatCommentTimestamp("2025-12-29T12:00:00.000Z", now)).toBe("3 days ago");
    expect(formatCommentTimestamp("not-a-date", now)).toBe("not-a-date");
  });
});
