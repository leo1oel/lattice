import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEditorComment, editorCommentsExtension } from "../src/editor/comments/editor-comments";
import "../src/index.css";
import "../src/App.css";

let view: EditorView | undefined;

export function mountComment(top: number, long: boolean) {
  view?.destroy();
  document.body.replaceChildren();
  const host = document.createElement("div");
  host.className = "source-editor";
  host.style.cssText = `position:absolute;left:40px;top:${top}px;width:700px;height:80px`;
  document.body.append(host);
  const source = "A commented sentence in the document.";
  const comment = createEditorComment({
    path: "main.tex", source, from: 0, to: source.length,
    authorId: "reviewer", authorName: "Reviewer",
    body: long
      ? Array.from({ length: 35 }, (_, index) => `${index + 1}. Please clarify how this result follows from the assumptions.`).join("\n")
      : "Please clarify this result.",
  })!;
  view = new EditorView({ parent: host, state: EditorState.create({
    doc: source,
    extensions: [editorCommentsExtension("main.tex", {
      getComments: () => [comment],
      onResolve: () => { host.dataset.resolved = "true"; },
      onReply: () => { host.dataset.replied = "true"; },
    })],
  }) });
  const point = view.coordsAtPos(8)!;
  return { x: Math.round(point.left), y: Math.round((point.top + point.bottom) / 2) };
}
