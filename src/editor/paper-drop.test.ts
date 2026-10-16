import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo, history } from "@codemirror/commands";
import { latexCitationAfter, paperDropExtension } from "./paper-drop";
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
  it("does not write a read-only editor, another project's drag, or a drop after the library switched", () => {
    let result = setup("main.tex", false);
    result.drop();
    expect(view.state.doc.toString()).toBe("See \\citep{older,later}.");
    view.destroy();
    result = setup();
    beginPaperDrag(result.data, "/other", paper);
    result.drop();
    expect(view.state.doc.toString()).toBe("See \\citep{older,later}.");
    // The current library is read only when a drop occurs, never during extension setup.
    view.destroy();
    result = setup();
    expect(result.getLibrary).not.toHaveBeenCalled();
    result.getLibrary.mockReturnValue({ projectRoot: "/switched-project", papers: [] });
    result.drop();
    expect(result.getLibrary).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("See \\citep{older,later}.");
  });
  it("inserts source Markdown compatible with visual paper nodes", () => {
    const { drop } = setup("notes/note.md");
    vi.mocked(view.posAtCoords).mockReturnValue(4);
    drop();
    expect(view.state.doc.toString()).toBe("See [@attention2017](../.research/papers/1706.03762/paper.md)\\citep{older,later}.");
  });
});

describe("latexCitationAfter", () => {
  const cite = (source: string, quote: string, key = "jain2019") => {
    const from = source.indexOf(quote);
    const edit = latexCitationAfter(source, from, from + quote.length, key);
    return edit ? source.slice(0, edit.from) + edit.insert + source.slice(edit.to) : null;
  };
  it("puts the citation after the claim's last word, before the punctuation that ends it", () => {
    expect(cite("Attention is not explanation. Next.", "Attention is not explanation.")).toBe("Attention is not explanation~\\citep{jain2019}. Next.");
    expect(cite("Attention is not explanation. Next.", "Attention is not explanation")).toBe("Attention is not explanation~\\citep{jain2019}. Next.");
    expect(cite("First, attention is not explanation, and so on.", "attention is not explanation, ")).toBe("First, attention is not explanation~\\citep{jain2019}, and so on.");
    expect(cite("注意力不是解释。下一句。", "注意力不是解释。")).toBe("注意力不是解释~\\citep{jain2019}。下一句。");
  });
  it("joins the citation list that already follows the claim, once", () => {
    expect(cite("Not explanation~\\citep{serrano2019}. Next.", "Not explanation")).toBe("Not explanation~\\citep{serrano2019, jain2019}. Next.");
    expect(cite("Not explanation \\cite[see][]{serrano2019}.", "Not explanation")).toBe("Not explanation \\cite[see][]{serrano2019, jain2019}.");
    expect(cite("Not explanation~\\citep{serrano2019}.", "Not explanation~\\citep{serrano2019}.")).toBe("Not explanation~\\citep{serrano2019, jain2019}.");
    expect(cite("Not explanation~\\citep{jain2019}.", "Not explanation")).toBeNull();
  });
});
