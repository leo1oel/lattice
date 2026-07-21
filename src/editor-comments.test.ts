import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  buildCommentDecorations,
  buildCommentTooltipDom,
  commentMarkStyle,
  commentsAtPosition,
  createEditorComment,
  createEditorCommentReply,
  editorCommentsExtension,
  formatCommentTimestamp,
  parseEditorComments,
  resolveCommentRange,
  serializeEditorComments,
  tryParseEditorComments,
} from "./editor-comments";

describe("editor comments", () => {
  it("creates a comment with quote and context", () => {
    const source = "Hello bold world today";
    const comment = createEditorComment({
      path: "main.tex",
      source,
      from: 6,
      to: 10,
      body: "Make this stronger",
      authorId: "a1",
      authorName: "Leo",
    });
    expect(comment).toMatchObject({
      path: "main.tex",
      quote: "bold",
      prefix: "Hello ",
      suffix: " world today",
      body: "Make this stronger",
      authorName: "Leo",
      resolved: false,
    });
  });

  it("re-anchors by quote when offsets drift", () => {
    const comment = createEditorComment({
      path: "main.tex",
      source: "aaa TARGET bbb",
      from: 4,
      to: 10,
      body: "check",
      authorId: "a1",
      authorName: "Leo",
    })!;
    comment.from = 0;
    comment.to = 1;
    expect(resolveCommentRange("prefix TARGET suffix", comment)).toEqual({ from: 7, to: 13 });
  });

  it("round-trips JSON", () => {
    const comment = createEditorComment({
      path: "main.tex",
      source: "abc",
      from: 0,
      to: 3,
      body: "note",
      authorId: "a1",
      authorName: "Leo",
    })!;
    const raw = serializeEditorComments([comment]);
    expect(parseEditorComments(raw)).toEqual([comment]);
  });

  it("builds unresolved comment decorations with per-author colors", () => {
    const source = "alpha beta gamma";
    const open = createEditorComment({
      path: "main.tex",
      source,
      from: 6,
      to: 10,
      body: "check",
      authorId: "author-a",
      authorName: "Ada",
    })!;
    const resolved = { ...open, id: "resolved", resolved: true };
    const deco = buildCommentDecorations(source, "main.tex", [open, resolved]);
    expect(deco.size).toBe(1);
    expect(commentMarkStyle(open)).toContain("border-bottom: 2px solid");
    expect(commentMarkStyle(open)).not.toEqual(commentMarkStyle({
      ...open,
      authorId: "author-b",
    }));
  });

  it("finds the comments covering a hovered position", () => {
    const source = "alpha beta gamma";
    const beta = createEditorComment({
      path: "main.tex",
      source,
      from: 6,
      to: 10,
      body: "check beta",
      authorId: "author-a",
      authorName: "Ada",
    })!;
    const other = createEditorComment({
      path: "other.tex",
      source,
      from: 6,
      to: 10,
      body: "wrong file",
      authorId: "author-a",
      authorName: "Ada",
    })!;
    const resolved = { ...beta, id: "resolved", resolved: true };
    // Inside the "beta" span.
    expect(commentsAtPosition(source, "main.tex", [beta, other, resolved], 7).map((c) => c.id))
      .toEqual([beta.id]);
    // Outside every span.
    expect(commentsAtPosition(source, "main.tex", [beta], 2)).toEqual([]);
    // Wrong active file.
    expect(commentsAtPosition(source, "main.tex", [other], 7)).toEqual([]);
  });

  it("distinguishes a corrupt payload from a legitimately empty list", () => {
    // Valid empty list → [] (not a failure).
    expect(tryParseEditorComments('{"schemaVersion":1,"comments":[]}')).toEqual([]);
    // Two concurrent whole-file rewrites merged by the CRDT into invalid JSON.
    expect(tryParseEditorComments('{"comments":[]}{"comments":[]}')).toBeNull();
    expect(tryParseEditorComments("not json at all")).toBeNull();
    // parseEditorComments stays lenient (returns [] on failure) for callers that
    // don't need to tell the two apart.
    expect(parseEditorComments("not json at all")).toEqual([]);
  });

  it("does not double-match two comments meeting at a shared boundary", () => {
    const source = "alphabeta";
    const first = createEditorComment({
      path: "main.tex", source, from: 0, to: 5, body: "one",
      authorId: "a", authorName: "A",
    })!;
    const second = createEditorComment({
      path: "main.tex", source, from: 5, to: 9, body: "two",
      authorId: "b", authorName: "B",
    })!;
    // At the seam (offset 5) only the comment that starts there matches.
    expect(commentsAtPosition(source, "main.tex", [first, second], 5).map((c) => c.body))
      .toEqual(["two"]);
  });

  it("renders a hover card with the author name and body", () => {
    const comment = createEditorComment({
      path: "main.tex",
      source: "alpha beta gamma",
      from: 6,
      to: 10,
      body: "please clarify",
      authorId: "author-a",
      authorName: "Ada Lovelace",
    })!;
    const dom = buildCommentTooltipDom([comment]);
    expect(dom.querySelector(".cm-editor-comment-tooltip-author")?.textContent).toBe("Ada Lovelace");
    expect(dom.querySelector(".cm-editor-comment-tooltip-body")?.textContent).toBe("please clarify");
    // With no actions passed the card stays read-only (no buttons).
    expect(dom.querySelector(".cm-editor-comment-tooltip-actions")).toBeNull();
  });

  it("keeps a fresh comment's reply list empty and appends replies", () => {
    const comment = createEditorComment({
      path: "main.tex",
      source: "alpha beta gamma",
      from: 6,
      to: 10,
      body: "please clarify",
      authorId: "author-a",
      authorName: "Ada",
    })!;
    expect(comment.replies).toEqual([]);
    const reply = createEditorCommentReply({ body: "  sure  ", authorId: "b", authorName: "Bo" });
    expect(reply?.body).toBe("sure");
    expect(createEditorCommentReply({ body: "   ", authorId: "b", authorName: "Bo" })).toBeNull();
  });

  it("renders reply threads and Resolve/Reply actions when actions are provided", () => {
    const comment = {
      ...createEditorComment({
        path: "main.tex",
        source: "alpha beta gamma",
        from: 6,
        to: 10,
        body: "please clarify",
        authorId: "author-a",
        authorName: "Ada",
      })!,
      replies: [createEditorCommentReply({ body: "will do", authorId: "b", authorName: "Bo" })!],
    };
    const resolved: string[] = [];
    const replied: string[] = [];
    const dom = buildCommentTooltipDom([comment], {
      currentAuthorId: "b",
      onResolve: (id) => resolved.push(id),
      onReply: (c) => replied.push(c.id),
    });
    expect(dom.querySelector(".cm-editor-comment-tooltip-reply .cm-editor-comment-tooltip-body")?.textContent)
      .toBe("will do");
    const buttons = Array.from(dom.querySelectorAll<HTMLButtonElement>(".cm-editor-comment-tooltip-actions button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Resolve", "Reply…"]);
    buttons[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    buttons[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(resolved).toEqual([comment.id]);
    expect(replied).toEqual([comment.id]);
  });

  it("formats comment timestamps relative to now", () => {
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    expect(formatCommentTimestamp("2026-01-01T11:57:00.000Z", now)).toBe("3 min ago");
    expect(formatCommentTimestamp("2026-01-01T11:59:59.000Z", now)).toBe("just now");
    expect(formatCommentTimestamp("not-a-date", now)).toBe("not-a-date");
  });

  it("shows a comment tooltip on hover via the extension", () => {
    const source = "alpha beta gamma";
    const comment = createEditorComment({
      path: "main.tex",
      source,
      from: 6,
      to: 10,
      body: "hover me",
      authorId: "author-a",
      authorName: "Ada",
    })!;
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: source,
        extensions: editorCommentsExtension("main.tex", { getComments: () => [comment] }),
      }),
    });
    // The mark no longer carries a native title (the hover tooltip replaces it).
    expect(view.dom.querySelector(".cm-editor-comment")?.getAttribute("title")).toBeNull();
    view.destroy();
  });

  it("seeds decorations from a live getter when the extension field is created", () => {
    const source = "alpha beta gamma";
    const comment = createEditorComment({
      path: "main.tex",
      source,
      from: 6,
      to: 10,
      body: "check",
      authorId: "author-a",
      authorName: "Ada",
    })!;
    const comments = [comment];
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: source,
        extensions: editorCommentsExtension("main.tex", { getComments: () => comments }),
      }),
    });
    expect(view.dom.querySelector(".cm-editor-comment")).not.toBeNull();
    // Fresh state (same as a reconfigure wipe) should still show marks via the getter.
    view.setState(EditorState.create({
      doc: source,
      extensions: editorCommentsExtension("main.tex", { getComments: () => comments }),
    }));
    expect(view.dom.querySelector(".cm-editor-comment")).not.toBeNull();
    view.destroy();
  });
});
