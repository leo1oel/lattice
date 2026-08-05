import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import type { EditorCollabSession } from "./collab-session";

export function collabEditorExtensions(session: EditorCollabSession): Extension[] {
  return [
    yCollab(session.ytext, session.provider.awareness, { undoManager: session.undoManager }),
    EditorView.theme({
      ".cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, #3d7af2 38%, transparent) !important",
      },
      "&.cm-focused .cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, #3d7af2 45%, transparent) !important",
      },
    }),
  ];
}
