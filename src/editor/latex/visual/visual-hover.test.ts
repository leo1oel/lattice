import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { coveredByVisual } from "../latex-visual-switch";
import type { CitationInfo, ReferenceInfo } from "../latex-text";
import { chipHoverSource, chipUnderPointer } from "./visual-hover";
import { host, visualView } from "./visual-test-editor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => undefined) }));

const CITATIONS: CitationInfo[] = [
  { key: "vaswani2017", title: "Attention Is All You Need", authors: "Vaswani, Ashish and Shazeer, Noam", year: "2017", venue: "NeurIPS" },
  { key: "devlin2019", title: "BERT: Pre-training of Deep Bidirectional Transformers", authors: "Devlin, Jacob", year: "2019", venue: "NAACL" },
];
const REFERENCES: ReferenceInfo[] = [
  { label: "sec:method", kind: "section", title: "Method", snippet: "", path: "main.tex", line: 9 },
  { label: "fig:case-failure", kind: "figure", title: "A failure case", snippet: "", path: "main.tex", line: 21 },
  { label: "fig:cost", kind: "figure", title: "Inference cost against sequence length", snippet: "", path: "main.tex", line: 27 },
  { label: "tab:main", kind: "table", title: "Main results", snippet: "Method & Score", path: "sections/results.tex", line: 5 },
];

const DOC = [
  "Prose \\citep{vaswani2017,devlin2019,missing2024} and \\cite{vaswani2017} here.",
  "See \\cref{fig:case-failure,fig:cost}, \\autoref{tab:main} and \\ref{sec:nowhere}.",
  "",
  "End.",
].join("\n");

async function open() {
  const visualHost = host({ citations: CITATIONS, citationKeys: CITATIONS.map((item) => item.key), references: REFERENCES });
  const view = await visualView(DOC, DOC.length, visualHost);
  return { view, visualHost };
}

/** The card the pointer resting on the chip that starts at `source` would open. */
function card(view: EditorView, visualHost: ReturnType<typeof host>, source: string): HTMLElement {
  const tooltip = chipHoverSource(visualHost)(view, DOC.indexOf(source), 1);
  if (!tooltip) throw new Error(`no card for ${source}`);
  return tooltip.create(view).dom;
}

const chipKey = (view: EditorView, key: string) => {
  const element = view.contentDOM.querySelector<HTMLElement>(`[data-key="${key}"]`);
  if (!element) throw new Error(`no chip for ${key}`);
  return element;
};

describe("Visual mode chips", () => {
  it("finds the chip under the pointer on either side of it, and only while it is drawn", async () => {
    const { view } = await open();
    const from = DOC.indexOf("\\autoref");
    const to = DOC.indexOf(" and \\ref");
    expect(chipUnderPointer(view.state, from, 1)).toMatchObject({ kind: "reference", keys: ["tab:main"] });
    expect(chipUnderPointer(view.state, to, -1)).toMatchObject({ kind: "reference", keys: ["tab:main"] });
    // The pointer beside the chip is on the text next to it.
    expect(chipUnderPointer(view.state, from, -1)).toBeNull();
    expect(chipUnderPointer(view.state, to, 1)).toBeNull();
    // The source editor's own hovers (TexLab's command help among them) stand aside over the chip.
    expect(coveredByVisual(view.state, from, 1)).toBe(true);
    expect(coveredByVisual(view.state, DOC.indexOf("Prose"), 1)).toBe(false);
    // With the caret in it the chip shows its source, and the source editor's cards take over.
    view.dispatch({ selection: { anchor: from + 3 } });
    expect(chipUnderPointer(view.state, from, 1)).toBeNull();
    expect(coveredByVisual(view.state, from, 1)).toBe(false);
  });

  it("shows each cited entry in its own section, and says when a key has no entry", async () => {
    const { view, visualHost } = await open();
    const dom = card(view, visualHost, "\\citep");
    const sections = [...dom.querySelectorAll<HTMLElement>(".hover-card-section")];
    expect(sections).toHaveLength(3);
    expect(sections[0].querySelector(".citation-card-title")?.textContent).toBe("Attention Is All You Need");
    expect(sections[0].querySelector(".citation-card-venue")?.textContent).toBe("NeurIPS, 2017");
    expect(sections[1].querySelector(".citation-card-title")?.textContent).toContain("BERT");
    expect(sections[2].querySelector(".citation-card-key")?.textContent).toBe("missing2024");
    expect(sections[2].querySelector(".hover-card-unresolved")).not.toBeNull();
    // Several keys keep the card short: no "cited here" list per key.
    expect(dom.querySelector(".citation-card-uses")).toBeNull();

    const goTo = [...sections[1].querySelectorAll("button")].find((button) => button.textContent === "Go to entry");
    goTo?.click();
    expect(visualHost.opened).toEqual([{ kind: "citation", key: "devlin2019" }]);
  });

  it("shows a single key's full card", async () => {
    const { view, visualHost } = await open();
    const dom = card(view, visualHost, "\\cite{vaswani2017}");
    expect(dom.querySelector(".hover-card-section")).toBeNull();
    expect(dom.querySelector(".citation-card-title")?.textContent).toBe("Attention Is All You Need");
    expect(dom.getAttribute("aria-label")).toBe("Attention Is All You Need");
  });

  it("shows what each label names, with Go to across files, and an undefined label as such", async () => {
    const { view, visualHost } = await open();
    const figures = card(view, visualHost, "\\cref");
    const sections = [...figures.querySelectorAll<HTMLElement>(".hover-card-section")];
    expect(sections.map((section) => section.querySelector("strong")?.textContent)).toEqual([
      "A failure case", "Inference cost against sequence length",
    ]);

    const table = card(view, visualHost, "\\autoref");
    expect(table.querySelector("strong")?.textContent).toBe("Main results");
    expect(table.querySelector("em")?.textContent).toBe("sections/results.tex");
    [...table.querySelectorAll("button")].find((button) => button.textContent === "Go to")?.click();
    expect(visualHost.opened).toEqual([{ kind: "reference", path: "sections/results.tex", line: 5, label: "tab:main" }]);

    const missing = card(view, visualHost, "\\ref{sec:nowhere}");
    expect(missing.querySelector(".citation-card-key")?.textContent).toBe("sec:nowhere");
    expect(missing.querySelector(".hover-card-unresolved")).not.toBeNull();
    expect(missing.querySelector("button")).toBeNull();
  });

  it("goes to the key under the pointer on ⌘-click, and a plain click still opens the chip's source", async () => {
    const { view, visualHost } = await open();
    const cost = chipKey(view, "fig:cost");
    cost.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, metaKey: true, button: 0 }));
    cost.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true, button: 0 }));
    expect(visualHost.opened).toEqual([{ kind: "reference", path: "main.tex", line: 27, label: "fig:cost" }]);
    // The caret stayed where it was: the jump did not open the chip.
    expect(view.state.selection.main.head).toBe(DOC.length);

    chipKey(view, "devlin2019").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, button: 0 }));
    expect(visualHost.opened.at(-1)).toEqual({ kind: "citation", key: "devlin2019" });

    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    chipKey(view, "tab:main").dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(visualHost.opened).toHaveLength(2);
  });

  it("draws each key's words in a span of its own, with no native tooltip", async () => {
    const { view } = await open();
    const chip = view.contentDOM.querySelector<HTMLElement>(".lx-tex-cite");
    expect(chip?.textContent).toBe("[Vaswani and Shazeer, 2017; Devlin, 2019; missing2024]");
    expect(chip?.title).toBe("");
    expect([...chip!.querySelectorAll<HTMLElement>("[data-key]")].map((part) => part.dataset.key)).toEqual(["vaswani2017", "devlin2019", "missing2024"]);
  });
});
