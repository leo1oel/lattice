import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManuscriptChecklistPanel, type ManuscriptChecklistData } from "./manuscript-checklist";
import { activateAppLocale } from "../i18n";
import type { SubmissionItem } from "../app-types";
import { loadSubmissionTemplates } from "../settings/app-settings";

const base: ManuscriptChecklistData = {
  words: 5_080, wordSource: "texcount", wordBudget: null, pages: 12, body: { kind: "none" }, pageBudget: null,
  deadline: null, venue: "NeurIPS",
  todos: 0, unusedLabels: 0, unusedCitations: 0, buildOk: true, buildMessage: "",
  items: [], fileStats: {}, filePaths: [],
};

function renderChecklist(data: Partial<ManuscriptChecklistData>) {
  const onSaveItems = vi.fn().mockResolvedValue(true);
  const onOpenFile = vi.fn();
  const panel = (change: Partial<ManuscriptChecklistData>) => (
    <ManuscriptChecklistPanel
      data={{ ...base, ...change }}
      onClose={vi.fn()}
      onOpenTodos={vi.fn()}
      onSaveBudgets={vi.fn()}
      onSaveDeadline={vi.fn()}
      onSaveItems={onSaveItems}
      onOpenFile={onOpenFile}
      onOpenSource={vi.fn()}
    />
  );
  const view = render(panel(data));
  const row = (label: string) => screen.getByText(label).closest(".checklist-row")!;
  const rerender = (change: Partial<ManuscriptChecklistData>) => view.rerender(panel({ ...data, ...change }));
  return { container: view.container, row, rerender, onSaveItems, onOpenFile };
}

describe("ManuscriptChecklistPanel budgets", () => {
  beforeEach(() => activateAppLocale("en"));
  afterEach(cleanup);

  it("draws no meter and claims nothing without a budget", () => {
    const { container, row } = renderChecklist({});
    expect(container.querySelector(".checklist-meter")).toBeNull();
    expect(row("Body words").textContent).toBe("Body words5,080");
    expect(row("Body words")).not.toHaveClass("ok");
  });

  it.each([
    [5_500, "420 words remaining", "ok"],
    [5_081, "1 word remaining", "ok"],
    [5_080, "At the limit", "ok"],
    [5_079, "1 word over", "warn"],
    [5_000, "80 words over", "warn"],
    [0, "5,080 words over", "warn"],
  ])("says how far the words are from a %i budget", (wordBudget, distance, tone) => {
    const { container, row } = renderChecklist({ wordBudget });
    expect(row("Body words")).toHaveTextContent(distance);
    expect(row("Body words")).not.toHaveTextContent("texcount");
    expect(row("Body words")).toHaveClass(tone);
    expect(container.querySelector(".checklist-meter")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps an overshoot proportional, past a mark at the limit", () => {
    const { container } = renderChecklist({ words: 6_000, wordBudget: 5_000 });
    const meter = container.querySelector(".checklist-meter")!;
    expect(meter).toHaveClass("over");
    expect(meter.querySelector<HTMLElement>(".checklist-meter-fill")!.style.width).toMatch(/^83\.33/);
    const over = meter.querySelector<HTMLElement>(".checklist-meter-over")!;
    expect(over.style.left).toMatch(/^83\.33/);
    expect(over.style.width).toMatch(/^16\.66/);
  });

  it("measures a root-only estimate against no budget, since the includes are uncounted", () => {
    // texcount is missing, so the backend estimated main.tex alone: 21 words
    // of a manuscript whose included chapter alone holds 120.
    const { container, row } = renderChecklist({ words: 21, wordSource: "estimate", wordBudget: 100 });
    expect(row("Body words")).toHaveTextContent("Body words≈21Root document only, estimated without texcount · Limit 100 words");
    expect(row("Body words")).not.toHaveClass("ok");
    expect(row("Body words")).not.toHaveClass("warn");
    expect(container.querySelector(".checklist-meter")).toBeNull();
    expect(row("Body words")).not.toHaveTextContent("remaining");
  });

  it("counts the whole PDF against the page budget when there is no appendix", () => {
    const { row } = renderChecklist({ pages: 9, pageBudget: 10 });
    expect(row("PDF pages")).toHaveTextContent("PDF pages9 / 101 page remaining");
    expect(row("PDF pages")).not.toHaveTextContent("appendix");
    expect(row("PDF pages")).toHaveClass("ok");
  });

  it("counts main pages against the page budget and shows the total beside it", () => {
    const { row } = renderChecklist({ pages: 12, body: { kind: "resolved", mainPages: 8 }, pageBudget: 9 });
    expect(row("Main pages")).toHaveTextContent("Main pages8 / 91 page remaining · 12 total · body ends on p.8");
    expect(row("Main pages")).toHaveClass("ok");
  });

  it.each([10, 20])("leaves main pages unmeasured, not the PDF's total, when the appendix was not located (%i-page budget)", (pageBudget) => {
    const { container, row } = renderChecklist({ pages: 12, body: { kind: "unresolved" }, pageBudget });
    expect(row("Main pages")).toHaveTextContent(`Main pagesUnavailable12 total · end of the body not located in the PDF · Limit ${pageBudget} pages`);
    expect(row("Main pages")).not.toHaveClass("ok");
    expect(row("Main pages")).not.toHaveClass("warn");
    expect(container.querySelector(".checklist-meter")).toBeNull();
  });

  it("leaves main pages unmeasured, not the PDF's total, until the included files show whether there is an appendix", () => {
    // 12 pages against a 10-page budget would be a false "2 pages over" if
    // an appendix still unread were taken for none.
    const { container, row } = renderChecklist({ pages: 12, body: { kind: "unread" }, pageBudget: 10 });
    expect(row("Main pages")).toHaveTextContent("Main pagesUnavailable12 total · included files not read · Limit 10 pages");
    expect(row("Main pages")).not.toHaveClass("ok");
    expect(row("Main pages")).not.toHaveClass("warn");
    expect(container.querySelector(".checklist-meter")).toBeNull();
  });

  it("never passes a budget it cannot measure", () => {
    const { container, row } = renderChecklist({ words: null, wordBudget: 5_500, pages: null, body: { kind: "unresolved" }, pageBudget: 9 });
    expect(container.querySelector(".checklist-meter")).toBeNull();
    expect(row("Body words")).toHaveTextContent("Body wordsUnavailableNeeds a root document to count from · Limit 5,500 words");
    expect(row("PDF pages")).toHaveTextContent("PDF pagesBuild to countLimit 9 pages");
    for (const label of ["Body words", "PDF pages"]) expect(row(label)).not.toHaveClass("ok");
  });
});

describe("ManuscriptChecklistPanel materials and sign-offs", () => {
  beforeEach(() => {
    activateAppLocale("en");
    localStorage.clear();
  });
  afterEach(cleanup);

  const supplement: SubmissionItem = { id: "s", title: "supplementary.pdf checked", status: "confirmed", file: "supplementary.pdf", confirmedMtimeMs: 100 };
  const authors: SubmissionItem = { id: "a", title: "All authors confirmed", status: "todo", owner: "Ada Lovelace" };
  // Every automatic check passes.
  const ready = { wordBudget: 6_000, pageBudget: 12 };

  it("adds an item as still to do, which keeps passing automatic checks from reading as ready", () => {
    const { onSaveItems } = renderChecklist(ready);
    expect(screen.getByText("Ready to submit")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("New item"), { target: { value: "  All authors confirmed " } });
    fireEvent.submit(screen.getByLabelText("New item").closest("form")!);
    expect(onSaveItems).toHaveBeenCalledWith([expect.objectContaining({ title: "All authors confirmed", status: "todo" })]);
    cleanup();
    renderChecklist({ ...ready, items: [authors] });
    expect(screen.getByText("1 check needs attention")).toBeInTheDocument();
    expect(screen.getByText("5 of 6 checks pass")).toBeInTheDocument();
    expect(screen.getByText("To do")).toBeInTheDocument();
  });

  it("passes a confirmation only while its file is the one that was confirmed", () => {
    const { row } = renderChecklist({ ...ready, items: [supplement, { ...authors, status: "confirmed" }], fileStats: { "supplementary.pdf": { exists: true, mtimeMs: 100 } } });
    expect(screen.getByText("Ready to submit")).toBeInTheDocument();
    expect(row("supplementary.pdf checked")).toHaveClass("ok");
    cleanup();

    const changed = renderChecklist({ items: [supplement], fileStats: { "supplementary.pdf": { exists: true, mtimeMs: 200 } } });
    expect(changed.row("supplementary.pdf checked")).toHaveClass("warn");
    expect(changed.row("supplementary.pdf checked")).toHaveTextContent("Changed since confirmed");
    // Ticking it again confirms the file as it is now: the backend stamps an item sent without a stamp.
    fireEvent.click(screen.getByRole("button", { name: "Confirm “supplementary.pdf checked”" }));
    expect(changed.onSaveItems).toHaveBeenCalledWith([{ ...supplement, confirmedMtimeMs: undefined }]);
    cleanup();

    const missing = renderChecklist({ items: [supplement], fileStats: { "supplementary.pdf": { exists: false, mtimeMs: 0 } } });
    expect(missing.row("supplementary.pdf checked")).toHaveTextContent("File missing");
    expect(screen.getByText("1 check needs attention")).toBeInTheDocument();
  });

  it("settles nothing for a confirmed file not read yet, and unticks it rather than restamping", () => {
    const { onSaveItems } = renderChecklist({ ...ready, items: [supplement] });
    expect(screen.getByText("Nothing blocks submission")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark “supplementary.pdf checked” not confirmed" }));
    expect(onSaveItems).toHaveBeenCalledWith([{ ...supplement, status: "todo", confirmedMtimeMs: undefined }]);
  });

  it("builds each edit on the last list sent, so quick edits before an answer all land", () => {
    const { onSaveItems } = renderChecklist({ items: [authors, { ...authors, id: "b", title: "Ethics form signed" }] });
    fireEvent.click(screen.getByRole("button", { name: "Confirm “All authors confirmed”" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm “Ethics form signed”" }));
    fireEvent.change(screen.getByLabelText("New item"), { target: { value: "Cover letter" } });
    fireEvent.submit(screen.getByLabelText("New item").closest("form")!);
    expect(onSaveItems).toHaveBeenLastCalledWith([
      { ...authors, status: "confirmed", confirmedMtimeMs: undefined },
      { ...authors, id: "b", title: "Ethics form signed", status: "confirmed", confirmedMtimeMs: undefined },
      expect.objectContaining({ title: "Cover letter", status: "todo" }),
    ]);
  });

  it("builds the next edit on the saved list, not on one whose write failed", async () => {
    const { onSaveItems } = renderChecklist({ items: [authors, { ...authors, id: "b", title: "Ethics form signed" }] });
    onSaveItems.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm “All authors confirmed”" }));
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Confirm “Ethics form signed”" }));
    expect(onSaveItems).toHaveBeenLastCalledWith([
      authors,
      { ...authors, id: "b", title: "Ethics form signed", status: "confirmed", confirmedMtimeMs: undefined },
    ]);
  });

  it("keeps a saved tick when the write after it fails", async () => {
    const ethics: SubmissionItem = { ...authors, id: "b", title: "Ethics form signed" };
    const cover: SubmissionItem = { ...authors, id: "c", title: "Cover letter" };
    let landFirst: (saved: boolean) => void = () => undefined;
    let landSecond: (saved: boolean) => void = () => undefined;
    const first = new Promise<boolean>((done) => { landFirst = done; });
    const second = new Promise<boolean>((done) => { landSecond = done; });
    const { rerender, onSaveItems } = renderChecklist({ items: [authors, ethics, cover] });
    onSaveItems.mockReturnValueOnce(first).mockReturnValueOnce(second);
    fireEvent.click(screen.getByRole("button", { name: "Confirm “All authors confirmed”" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm “Ethics form signed”" }));
    const authorsConfirmed = { ...authors, status: "confirmed", confirmedMtimeMs: undefined } as const;
    // The first write lands and its answer is installed; the second fails.
    rerender({ items: [authorsConfirmed, ethics, cover] });
    await act(async () => {
      landFirst(true);
      landSecond(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm “Cover letter”" }));
    expect(onSaveItems).toHaveBeenLastCalledWith([
      authorsConfirmed,
      ethics,
      { ...cover, status: "confirmed", confirmedMtimeMs: undefined },
    ]);
  });

  it("shows who, which file and where the requirement came from, and opens the file", () => {
    const item: SubmissionItem = { ...authors, file: "letters/cover.pdf", source: "https://neurips.cc/Conferences/2027/CallForPapers", sourceChecked: "2027-04-02" };
    const { row, onOpenFile } = renderChecklist({ items: [item], fileStats: { "letters/cover.pdf": { exists: true, mtimeMs: 1 } } });
    expect(row("All authors confirmed")).toHaveTextContent("Ada Lovelacecover.pdfneurips.ccchecked Apr 2, 2027");
    fireEvent.click(within(row("All authors confirmed") as HTMLElement).getByText("cover.pdf"));
    expect(onOpenFile).toHaveBeenCalledWith("letters/cover.pdf");
  });

  it("edits an item in place and restamps it when its file changes", () => {
    const { onSaveItems } = renderChecklist({ items: [supplement] });
    fireEvent.click(screen.getByText("supplementary.pdf checked"));
    fireEvent.change(screen.getByLabelText("Material file"), { target: { value: "supplement-v2.pdf" } });
    fireEvent.change(screen.getByLabelText("Who"), { target: { value: "Grace" } });
    fireEvent.click(screen.getByRole("button", { name: "Save item" }));
    expect(onSaveItems).toHaveBeenCalledWith([{ ...supplement, file: "supplement-v2.pdf", owner: "Grace", confirmedMtimeMs: undefined }]);
  });

  it("saves the list as a template on this Mac and adds it to another paper without its status", async () => {
    renderChecklist({ items: [supplement, authors] });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Checklist templates" }), { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Save these items as a template…" }));
    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: " Camera-ready " } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    const lines = [{ title: "supplementary.pdf checked", file: "supplementary.pdf" }, { title: "All authors confirmed" }];
    expect(loadSubmissionTemplates()).toEqual([{ name: "Camera-ready", items: lines }]);
    cleanup();

    // Another paper already holds one of the lines; only the other is added, still to do.
    const other = renderChecklist({ items: [{ ...authors, status: "confirmed" }] });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Checklist templates" }), { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Camera-ready/ }));
    expect(other.onSaveItems).toHaveBeenCalledWith([
      { ...authors, status: "confirmed" },
      { id: expect.any(String), title: "supplementary.pdf checked", file: "supplementary.pdf", source: undefined, status: "todo" },
    ]);
    localStorage.setItem("lattice.submission-templates.v1", "{not json");
    expect(loadSubmissionTemplates()).toEqual([]);
  });
});
