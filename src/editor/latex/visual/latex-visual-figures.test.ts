/**
 * Visual mode and chemistry figures: compound numbers from chemnum and the
 * editable figures a drawing program pastes (docs/editable-figures.md),
 * drawn with the numbers the last build gave their marks.
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { latex } from "../latex-language";
import { isLatexVisual, latexVisualSlot, type LatexVisualHost } from "../latex-visual-switch";
import { chooseLatexView } from "../latex-view-choice";
import type { LatexEditorLiveData } from "../latex-editor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  localStorage.clear();
  vi.mocked(invoke).mockImplementation(async () => "");
});
beforeAll(() => import("./latex-visual"));

function host(overrides: Partial<LatexEditorLiveData> = {}): LatexVisualHost {
  const live: LatexEditorLiveData = {
    citationKeys: [], citations: [], references: [], unusedLabels: [], unusedCitations: [], localMacros: [],
    graphicsRoots: [], projectPaths: [], spellingWords: [], katexMacros: {}, ...overrides,
  };
  return { data: () => live, loadImage: async () => null, open: () => {} };
}

async function visualView(doc: string, anchor = doc.length, visualHost = host()) {
  chooseLatexView("visual");
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: { anchor }, extensions: [latex(), latexVisualSlot(visualHost)] }),
  });
  views.push(view);
  await vi.waitFor(() => expect(isLatexVisual(view.state)).toBe(true));
  await Promise.resolve();
  return view;
}

const text = (view: EditorView) => view.contentDOM.textContent;

describe("LaTeX Visual mode's chemistry figures", () => {
  it("draws compound numbers from the last build's .aux, with ? before one", async () => {
    const doc = "Ketone \\cmpd{ketone} gives \\cmpd{alcohol.OMe,ketone} and \\rcmpd{3}.\nEnd";
    const before = await visualView(doc, doc.length);
    expect([...before.contentDOM.querySelectorAll(".lx-tex-compound")].map((chip) => chip.textContent)).toEqual(["?", "?, ?", "?"]);
    const aux = [
      "\\chemnum@cmpd {ketone}{1}{1}{}{}{}{}{\\bfseries }",
      "\\chemnum@cmpd {alcohol}{2}{2}{}{}{}{}{}",
      "\\chemnum@subcmpd {alcohol}{OMe}{1}{a}",
      "\\chemnum@cmpd {3}{3}{3}{}{}{}{}{}",
    ].join("\n");
    vi.mocked(invoke).mockImplementation(async (_command, args) => ((args as { path?: string }).path === "main.aux" ? aux : ""));
    const view = await visualView(doc, doc.length, host({ compiledBuild: { rootDocument: "main.tex" } }));
    await vi.waitFor(() => expect([...view.contentDOM.querySelectorAll(".lx-tex-compound")].map((chip) => chip.textContent)).toEqual(["1", "2a, 1", "3"]));
    expect(text(view)).not.toContain("\\cmpd");
  });

  it("draws an editable figure's graphic with its compound marks, and opens its drawing from a button", async () => {
    const entry = [
      "% editable-figure source: scheme.reactio",
      "\\begin{tikzpicture}",
      "  \\node[inner sep=0pt,anchor=south west] (rdfig) at (0,0) {\\includegraphics{scheme.pdf}};",
      "  \\begin{scope}[x={(rdfig.south east)},y={(rdfig.north west)}]",
      "    \\node at (0.25,0.1) {\\fontsize{10}{12}\\selectfont \\textbf{\\rcmpd{1}}~(85\\%)};",
      "  \\end{scope}",
      "\\end{tikzpicture}%",
    ].join("\n");
    const drawings: string[] = [];
    const visualHost = {
      ...host({ projectPaths: ["main.tex", "figures/scheme.tex", "figures/scheme.pdf", "figures/scheme.reactio"] }),
      readFile: async (path: string) => (path === "figures/scheme.tex" ? entry : ""),
      loadImage: async (path: string) => (path === "figures/scheme.pdf" ? "data:image/png;base64,AA==" : null),
      openDrawing: (path: string) => drawings.push(path),
    };
    const doc = "Text.\n\\begin{scheme}\n  \\input{figures/scheme}\n  \\caption{}\\label{s1}\n\\end{scheme}\nEnd";
    const view = await visualView(doc, 0, visualHost);
    const figure = await vi.waitFor(() => {
      const drawn = view.contentDOM.querySelector<HTMLElement>(".lx-tex-figure.is-loaded");
      expect(drawn).not.toBeNull();
      return drawn!;
    });
    expect(figure.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
    const label = figure.querySelector<HTMLElement>(".lx-tex-figure-label")!;
    expect(label.textContent).toBe("? (85%)");
    expect([label.style.left, label.style.bottom]).toEqual(["25%", "10%"]);
    expect(text(view)).not.toContain("\\input");
    expect(view.contentDOM.querySelector(".lx-tex-caption-empty")?.textContent).toBe("Scheme ?: Add a caption");
    const button = figure.querySelector<HTMLElement>(".lx-tex-figure-edit")!;
    button.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { button: 0, bubbles: true }));
    expect(drawings).toEqual(["figures/scheme.tex"]);
    // The button opens the drawing, not the include's source.
    expect(view.state.selection.main.head).toBe(0);
    figure.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    expect(view.state.selection.main.head).toBe(doc.indexOf("\\input"));
    expect(text(view)).toContain("\\input{figures/scheme}");
  });

  it("keeps an \\input of a file with no drawing beside it a link", async () => {
    const visualHost = { ...host({ projectPaths: ["figures/plain.tex", "figures/plain.pdf"] }), readFile: async () => "" };
    const doc = "\\input{figures/plain}\nEnd";
    const view = await visualView(doc, doc.length, visualHost);
    expect(view.contentDOM.querySelector(".lx-tex-figure")).toBeNull();
    expect(view.contentDOM.querySelector(".lx-tex-include")?.textContent).toBe("figures/plain");
  });
});
