import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorComment } from "../comments/editor-comment-data";
import { citationReasons } from "./citation-reason-editor";
import { citationSites, createCitationReason, panelCitationReasons } from "./citation-reasons";
import type { LatexEditorLiveData } from "./latex-editor";
import { citationCardAtCursor, citationTooltips } from "./latex-hover-cards";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => undefined) }));

const ENTRIES = [{ key: "smith2020", title: "Sparse Bounds", authors: "Smith, Ann", year: "2020", venue: "ICML" }];

const DOC = [
  "\\section{Results}",
  "Our bound holds on every benchmark \\cite{smith2020}, as earlier work found.",
  "",
  "\\section{Limits}",
  "It fails for sparse inputs \\citep[p.~5]{smith2020}; we return to this later.",
].join("\n");

const views: EditorView[] = [];
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  vi.useRealTimers();
  vi.mocked(invoke).mockReset().mockResolvedValue([]);
});

let made = 0;
function reasonOn(doc: string, nth: number, role: "supporting" | "counterexample", body = ""): EditorComment {
  const site = citationSites(doc)[nth]!;
  made += 1;
  return {
    ...createCitationReason({ path: "main.tex", source: doc, site, role, body, authorId: "me", authorName: "Me" })!,
    createdAt: `2026-11-08T00:00:0${made}Z`,
  };
}

function setup(doc: string, reasons: EditorComment[], extra: Partial<LatexEditorLiveData> = {}) {
  const store = { reasons };
  const onSaveCitationReason = vi.fn((reason: EditorComment) => {
    store.reasons = store.reasons.some((item) => item.id === reason.id)
      ? store.reasons.map((item) => (item.id === reason.id ? reason : item))
      : [...store.reasons, reason];
  });
  const onReanchorCitationReasons = vi.fn();
  const data = (): LatexEditorLiveData => ({
    citationKeys: ["smith2020"], citations: ENTRIES, references: [], unusedLabels: [], unusedCitations: [],
    localMacros: [], graphicsRoots: [], projectPaths: [], spellingWords: [],
    citationReasons: store.reasons,
    citationReasonAuthor: { id: "me", name: "Me" },
    onSaveCitationReason,
    onReanchorCitationReasons,
    onDeleteCitationReason: vi.fn(),
    ...extra,
  });
  const reasonsExt = citationReasons(data, "main.tex");
  const context = { currentPath: "main.tex", api: reasonsExt.api };
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions: [reasonsExt.extension, citationTooltips(data, undefined, context)] }),
  });
  views.push(view);
  const openCardAt = (nth: number) => {
    const site = citationSites(view.state.doc.toString())[nth]!;
    view.dispatch({ selection: { anchor: site.from + 1 } });
    expect(citationCardAtCursor(data, undefined, context)(view)).toBe(true);
    return view.dom.querySelector<HTMLElement>(".citation-hover-card")!;
  };
  return { view, store, api: reasonsExt.api, openCardAt, onSaveCitationReason, onReanchorCitationReasons };
}

const rowsOf = (card: HTMLElement) => [...card.querySelectorAll<HTMLElement>(".citation-card-use")].map((row) => ({
  section: row.querySelector(".citation-card-use-section")?.textContent,
  role: row.querySelector(".citation-card-use-role")?.textContent ?? null,
  note: row.querySelector(".citation-card-use-note")?.textContent ?? null,
  page: row.querySelector(".citation-card-use-page")?.textContent ?? null,
  current: row.querySelector("[aria-current]") !== null,
}));

describe("citation card rows", () => {
  it("lists each occurrence with its section, role, line and cited page", () => {
    const { openCardAt } = setup(DOC, [reasonOn(DOC, 0, "supporting", "Same benchmark suite"), reasonOn(DOC, 1, "counterexample")]);
    const card = openCardAt(1);
    expect(card.querySelector(".citation-card-uses-heading")?.textContent).toBe("Cited 2× here");
    expect(rowsOf(card)).toEqual([
      { section: "§1 Results", role: "Supporting", note: "Same benchmark suite", page: null, current: false },
      { section: "§2 Limits", role: "Counterexample", note: null, page: "p. 5", current: true },
    ]);
  });

  it("shows the cited page when the paper can be opened there", () => {
    const onOpenCitation = vi.fn();
    const { openCardAt } = setup(DOC, [], { canOpenCitation: () => true, onOpenCitation });
    const card = openCardAt(0);
    expect(rowsOf(card).map((row) => row.page)).toEqual([null, "p. 5"]);
    fireEvent.click(card.querySelector<HTMLButtonElement>("button.citation-card-use-page")!);
    expect(onOpenCitation).toHaveBeenCalledExactlyOnceWith("smith2020", 5);
  });

  it("jumps to the occurrence a row names", () => {
    const { view, openCardAt } = setup(DOC, []);
    const card = openCardAt(0);
    fireEvent.click(card.querySelectorAll<HTMLButtonElement>(".citation-card-use-jump")[1]!);
    const second = citationSites(DOC)[1]!;
    expect(view.state.selection.main).toMatchObject({ from: second.from, to: second.to });
  });

  it("scrolls a long list under Lattice's overlay scrollbar, not a native one", () => {
    const card = setup(DOC, []).openCardAt(0);
    const list = card.querySelector(".citation-card-uses-list")!;
    expect(list.parentElement).toHaveClass("citation-card-uses-frame");
    expect(list.parentElement?.querySelector(":scope > .lattice-scrollbar[data-orientation='vertical']")).not.toBeNull();
  });

  it("adds the other files' occurrences from the saved manuscript", async () => {
    const intro = "\\section{Introduction}\nPrior work \\cite{smith2020} shows it.";
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      if (command === "list_citation_usages") {
        return [{ kind: "citation", symbol: "smith2020", role: "reference", path: "intro.tex", line: 2, snippet: "" }];
      }
      if (command === "read_project_file" && (args as { path: string }).path === "intro.tex") return intro;
      return [];
    });
    const elsewhere = { ...reasonOn(intro, 0, "supporting", "Motivates the problem"), path: "intro.tex" };
    const onOpenCitationUse = vi.fn();
    const { openCardAt } = setup(DOC, [elsewhere], { projectRoot: "/p", citationUsageRevision: {}, onOpenCitationUse });
    const card = openCardAt(0);
    await waitFor(() => expect(card.querySelector(".citation-card-uses-heading")?.textContent).toBe("Cited 3× here"));
    expect(rowsOf(card)[2]).toMatchObject({ section: "§1 Introduction", role: "Supporting", note: "Motivates the problem" });
    fireEvent.click(card.querySelectorAll<HTMLButtonElement>(".citation-card-use-jump")[2]!);
    expect(onOpenCitationUse).toHaveBeenCalledExactlyOnceWith("intro.tex", 2);
  });
});

describe("Why cited", () => {
  const popover = () => document.querySelector<HTMLElement>(".citation-reason-popover");
  const choose = (role: string) => fireEvent.click([...popover()!.querySelectorAll<HTMLButtonElement>(".citation-role-chip")].find((chip) => chip.textContent === role)!);
  const button = (name: string) => [...popover()!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === name)!;

  it("files a reason on the hovered occurrence only", () => {
    const { openCardAt, onSaveCitationReason } = setup(DOC, []);
    const card = openCardAt(1);
    fireEvent.click([...card.querySelectorAll<HTMLButtonElement>(".citation-card-actions button")].find((item) => item.textContent === "Why cited")!);
    expect(button("Save").disabled).toBe(true);
    choose("Counterexample");
    fireEvent.change(popover()!.querySelector("input")!, { target: { value: "Fails on sparse inputs" } });
    popover()!.querySelector<HTMLInputElement>("input")!.value = "Fails on sparse inputs";
    fireEvent.click(button("Save"));
    const saved = onSaveCitationReason.mock.calls[0]![0];
    const second = citationSites(DOC)[1]!;
    expect(saved).toMatchObject({ citation: { key: "smith2020", role: "counterexample" }, body: "Fails on sparse inputs", from: second.from, to: second.to });
    expect(saved.number).toBeUndefined();
    expect(popover()).toBeNull();
  });

  it("edits the existing reason in place, and the card shows the change", () => {
    const first = reasonOn(DOC, 0, "supporting", "Same benchmark suite");
    const { openCardAt, onSaveCitationReason } = setup(DOC, [first]);
    let card = openCardAt(0);
    fireEvent.click([...card.querySelectorAll<HTMLButtonElement>(".citation-card-actions button")].find((item) => item.textContent === "Why cited")!);
    expect(popover()!.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.textContent).toBe("Supporting");
    expect(popover()!.querySelector("input")!.value).toBe("Same benchmark suite");
    choose("Comparison");
    fireEvent.click(button("Save"));
    expect(onSaveCitationReason.mock.calls[0]![0]).toMatchObject({ id: first.id, citation: { role: "comparison" } });
    card = openCardAt(0);
    expect(rowsOf(card)[0]).toMatchObject({ role: "Comparison", note: "Same benchmark suite" });
  });

  it("opens from a right-click on the key", () => {
    const { view } = setup(DOC, []);
    const site = citationSites(DOC)[0]!;
    const coords = view.coordsAtPos(site.from + 2);
    vi.spyOn(view, "posAtCoords").mockReturnValue(site.from + 2);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: coords?.left ?? 0, clientY: coords?.top ?? 0 });
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(popover()?.querySelector(".citation-card-key")?.textContent).toBe("smith2020");
  });
});

describe("reasons through edits", () => {
  it("keep their occurrence through typing and a moved paragraph, and save the new context once it settles", () => {
    vi.useFakeTimers();
    const supporting = reasonOn(DOC, 0, "supporting");
    const counter = reasonOn(DOC, 1, "counterexample");
    const { view, api, onReanchorCitationReasons } = setup(DOC, [supporting, counter]);
    const line = (id: string) => api.placed(view.state).sites.get(id)?.line;
    // Typing right before the cite.
    const at = view.state.doc.toString().indexOf(" \\cite{smith2020}");
    view.dispatch({ changes: { from: at, insert: " we tried" } });
    expect([line(supporting.id), line(counter.id)]).toEqual([2, 5]);
    // Cut the Limits section and paste it above Results.
    const text = view.state.doc.toString();
    const limits = text.slice(text.indexOf("\\section{Limits}"));
    view.dispatch({ changes: { from: text.indexOf("\n\n\\section{Limits}"), to: text.length } });
    view.dispatch({ changes: { from: 0, insert: `${limits}\n\n` } });
    expect([line(supporting.id), line(counter.id)]).toEqual([5, 2]);
    vi.advanceTimersByTime(1500);
    expect(onReanchorCitationReasons).toHaveBeenCalledTimes(1);
    const moves = onReanchorCitationReasons.mock.calls[0]![0] as Map<string, { prefix: string }>;
    expect(moves.get(supporting.id)?.prefix).toContain("we tried");
  });

  it("orphans the reason of a deleted cite, which the Annotations panel then lists", () => {
    const supporting = reasonOn(DOC, 0, "supporting");
    const counter = reasonOn(DOC, 1, "counterexample");
    const { view, api, store } = setup(DOC, [supporting, counter]);
    const text = view.state.doc.toString();
    const cite = " \\cite{smith2020}";
    view.dispatch({ changes: { from: text.indexOf(cite), to: text.indexOf(cite) + cite.length } });
    expect([...api.placed(view.state).sites.keys()]).toEqual([counter.id]);
    expect(panelCitationReasons(store.reasons, () => view.state.doc.toString()).map((item) => item.id)).toEqual([supporting.id]);
    // A file the panel cannot read is not called orphaned.
    expect(panelCitationReasons(store.reasons, () => undefined)).toEqual([]);
  });
});
