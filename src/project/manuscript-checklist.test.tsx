import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManuscriptChecklistPanel, type ManuscriptChecklistData } from "./manuscript-checklist";
import { activateAppLocale } from "../i18n";

const base: ManuscriptChecklistData = {
  words: 5_080, wordSource: "texcount", wordBudget: null, pages: 12, mainPages: null, pageBudget: null,
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

  it("counts main pages against the page budget and shows the total beside it", () => {
    const { row } = renderChecklist({ pages: 12, mainPages: 8, pageBudget: 9 });
    expect(row("Main pages")).toHaveTextContent("Main pages8 / 91 page remaining · 12 total · appendix after p.8");
    expect(row("Main pages")).toHaveClass("ok");
  });

  it("never passes a budget it cannot measure", () => {
    const { container, row } = renderChecklist({ words: null, wordBudget: 5_500, pages: null, mainPages: null, pageBudget: 9 });
    expect(container.querySelector(".checklist-meter")).toBeNull();
    expect(row("Body words")).toHaveTextContent("Body wordsUnavailableNeeds a root document to count from");
    expect(row("PDF pages")).toHaveTextContent("PDF pagesBuild to countLimit 9 pages");
    for (const label of ["Body words", "PDF pages"]) expect(row(label)).not.toHaveClass("ok");
  });
});
