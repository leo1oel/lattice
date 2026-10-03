import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManuscriptChecklistPanel, type ManuscriptChecklistData } from "./manuscript-checklist";
import { activateAppLocale } from "../i18n";

const base: ManuscriptChecklistData = {
  words: 5_080, wordSource: "texcount", wordBudget: null, pages: 12, appendix: { kind: "none" }, pageBudget: null,
  todos: 0, unusedLabels: 0, unusedCitations: 0, buildOk: true, buildMessage: "",
};

function renderChecklist(data: Partial<ManuscriptChecklistData>) {
  const { container } = render(
    <ManuscriptChecklistPanel data={{ ...base, ...data }} onClose={vi.fn()} onOpenTodos={vi.fn()} onSaveBudgets={vi.fn()} />,
  );
  const row = (label: string) => screen.getByText(label).closest(".checklist-row")!;
  return { container, row };
}

describe("ManuscriptChecklistPanel budgets", () => {
  beforeEach(() => activateAppLocale("en"));
  afterEach(cleanup);

  it("draws no meter and claims nothing without a budget", () => {
    const { container, row } = renderChecklist({});
    expect(container.querySelector(".checklist-meter")).toBeNull();
    expect(row("Body words")).toHaveTextContent("Body words5,080via texcount -inc");
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
    expect(row("Body words")).toHaveTextContent(`${distance} · via texcount -inc`);
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
    const { row } = renderChecklist({ pages: 12, appendix: { kind: "resolved", mainPages: 8 }, pageBudget: 9 });
    expect(row("Main pages")).toHaveTextContent("Main pages8 / 91 page remaining · 12 total · appendix after p.8");
    expect(row("Main pages")).toHaveClass("ok");
  });

  it.each([10, 20])("leaves main pages unmeasured, not the PDF's total, when the appendix was not located (%i-page budget)", (pageBudget) => {
    const { container, row } = renderChecklist({ pages: 12, appendix: { kind: "unresolved" }, pageBudget });
    expect(row("Main pages")).toHaveTextContent(`Main pagesUnavailable12 total · appendix not located in the PDF · Limit ${pageBudget} pages`);
    expect(row("Main pages")).not.toHaveClass("ok");
    expect(row("Main pages")).not.toHaveClass("warn");
    expect(container.querySelector(".checklist-meter")).toBeNull();
  });

  it("never passes a budget it cannot measure", () => {
    const { container, row } = renderChecklist({ words: null, wordBudget: 5_500, pages: null, appendix: { kind: "unresolved" }, pageBudget: 9 });
    expect(container.querySelector(".checklist-meter")).toBeNull();
    expect(row("Body words")).toHaveTextContent("Body wordsUnavailableNeeds a root document to count from · Limit 5,500 words");
    expect(row("PDF pages")).toHaveTextContent("PDF pagesBuild to countLimit 9 pages");
    for (const label of ["Body words", "PDF pages"]) expect(row(label)).not.toHaveClass("ok");
  });
});
