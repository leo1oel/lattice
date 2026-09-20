import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo, history } from "@codemirror/commands";
import { paperDropExtension } from "./paper-drop";
import { beginPaperDrag, PAPER_DRAG_TYPE } from "../papers/paper-drag";

const paper = { arxivId: "1706.03762", title: "Attention", citationKey: "attention2017", hasFullText: true, hasBlog: false };
let view: EditorView;
afterEach(() => view?.destroy());

function setup(path = "main.tex", editable = true) {
  const parent = document.createElement("div");
  document.body.replaceChildren(parent);
  const getLibrary = vi.fn(() => ({ projectRoot: "/project", papers: [paper] }));
  view = new EditorView({ parent, state: EditorState.create({ doc: "See \\citep{older,later}.", extensions: [history(), EditorView.editable.of(editable), paperDropExtension(path, getLibrary)] }) });
  vi.spyOn(view, "posAtCoords").mockReturnValue(16);
  const values = new Map<string, string>();
  const data = { types: [PAPER_DRAG_TYPE], setData: (type: string, value: string) => { values.set(type, value); }, getData: (type: string) => values.get(type) ?? "" } as unknown as DataTransfer;
  beginPaperDrag(data, "/project", paper);
  const drop = () => {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: data });
    view.contentDOM.dispatchEvent(event);
  };
  return { drop, data, getLibrary };
}

describe("CodeMirror paper drop", () => {
  it("reads the current library only when a drop occurs, never during extension setup", () => {
    const { drop, getLibrary } = setup();
    expect(getLibrary).not.toHaveBeenCalled();
    getLibrary.mockReturnValue({ projectRoot: "/switched-project", papers: [] });
    drop();
    expect(getLibrary).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("See \\citep{older,later}.");
  });

  it("merges at the pointer and undoes as one edit without deleting the selection", () => {
    const { drop } = setup();
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    drop();
    expect(view.state.doc.toString()).toBe("See \\citep{older, attention2017, later}.");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("See \\citep{older,later}.");
  });
  it.each([false, true])("handles a native text-only transfer (merge=%s)", (merge) => {
    const { drop, data } = setup();
    const plain = data.getData("text/plain");
    Object.defineProperty(data, "types", { value: ["text/plain"] });
    data.getData = (type) => type === "text/plain" ? plain : "";
    if (!merge) vi.mocked(view.posAtCoords).mockReturnValue(3);
    drop();
    expect(view.state.doc.toString()).toBe(merge
      ? "See \\citep{older, attention2017, later}."
      : "See~\\citep{attention2017} \\citep{older,later}.");
  });
  it("does not write a read-only editor or accept another project's drag", () => {
    let result = setup("main.tex", false);
    result.drop();
    expect(view.state.doc.toString()).toBe("See \\citep{older,later}.");
    view.destroy();
    result = setup();
    beginPaperDrag(result.data, "/other", paper);
    result.drop();
    expect(view.state.doc.toString()).toBe("See \\citep{older,later}.");
  });
  it("inserts source Markdown compatible with visual paper nodes", () => {
    const { drop } = setup("notes/note.md");
    vi.mocked(view.posAtCoords).mockReturnValue(4);
    drop();
    expect(view.state.doc.toString()).toBe("See [@attention2017](../.research/papers/1706.03762/paper.md)\\citep{older,later}.");
  });
});
