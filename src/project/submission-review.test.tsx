import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ManuscriptChecklistPanel, type ManuscriptChecklistData } from "./manuscript-checklist";
import { reviewRowsChunk, type ReviewFinding, type SubmissionReview } from "./submission-review-state";
import { activateAppLocale } from "../i18n";

// Every automatic check above the review passes, so the verdict is the review's.
const base: ManuscriptChecklistData = {
  words: 5_080, wordSource: "texcount", wordBudget: 6_000, pages: 9, body: { kind: "none" }, pageBudget: 9,
  deadline: null, venue: "NeurIPS",
  todos: 0, unusedLabels: 0, unusedCitations: 0, buildOk: true, buildMessage: "",
  items: [], fileStats: {}, filePaths: [], review: null,
};

const clean: SubmissionReview = { venue: "NeurIPS", mode: "anonymous", pdf: true, fontsRead: true, findings: [] };

const at = (check: ReviewFinding["check"], text: string, file: string | null = null, line: number | null = null): ReviewFinding => ({
  check, file, line, text,
});

function renderReview(review: SubmissionReview | null) {
  const onOpenAt = vi.fn();
  render(
    <ManuscriptChecklistPanel
      data={{ ...base, review }}
      onClose={vi.fn()}
      onOpenTodos={vi.fn()}
      onSaveBudgets={vi.fn()}
      onSaveDeadline={vi.fn()}
      onSaveItems={vi.fn().mockResolvedValue(true)}
      onOpenFile={vi.fn()}
      onOpenAt={onOpenAt}
      onOpenSource={vi.fn()}
    />,
  );
  const row = (label: string) => screen.getByText(label).closest<HTMLElement>(".checklist-row")!;
  return { row, onOpenAt };
}

describe("submission checklist review", () => {
  // The rows render from their own chunk; loaded first, they render at once.
  beforeAll(() => reviewRowsChunk());
  beforeEach(() => activateAppLocale("en"));
  afterEach(cleanup);

  it("passes an anonymous NeurIPS paper with clean fonts", () => {
    const { row } = renderReview(clean);
    expect(screen.getByRole("heading", { name: "Double-blind review · NeurIPS" })).toBeInTheDocument();
    expect(row("Author names")).toHaveClass("ok");
    expect(row("Author names")).toHaveTextContent("Hidden");
    for (const label of ["Acknowledgements and thanks", "Links to your accounts", "Self-citing wording", "Author in PDF metadata", "Type 3 fonts", "Fonts not embedded"]) {
      expect(row(label)).toHaveClass("ok");
      expect(row(label)).toHaveTextContent("None");
    }
    expect(screen.getByText("Ready to submit")).toBeInTheDocument();
  });

  it("lists each finding under its check, with a way to its source line", () => {
    const { row, onOpenAt } = renderReview({
      ...clean,
      mode: "authors-shown",
      findings: [
        at("authors-shown", "\\usepackage[preprint]{neurips_2026}", "main.tex", 4),
        at("acknowledgements", "\\section*{Acknowledgments}", "sections/end.tex", 12),
        at("thanks", "\\title{Attention\\thanks{At Acme.}}", "main.tex", 9),
        at("type3-font", "DejaVuSans"),
      ],
    });
    expect(row("Author names")).toHaveClass("warn");
    expect(row("Author names")).toHaveTextContent("Shown");
    expect(row("Acknowledgements and thanks")).toHaveTextContent("2");
    fireEvent.click(within(row("Acknowledgements and thanks")).getByRole("button", { name: "sections/end.tex:12" }));
    expect(onOpenAt).toHaveBeenCalledWith("sections/end.tex", 12);
    // A font is in the PDF, not at a line: named, with nowhere to go.
    expect(within(row("Type 3 fonts")).getByText("DejaVuSans")).toBeInTheDocument();
    expect(within(row("Type 3 fonts")).queryByRole("button")).toBeNull();
    expect(screen.getByText("3 checks need attention")).toBeInTheDocument();
  });

  it("counts the findings past the first five rather than listing them", () => {
    const links = Array.from({ length: 7 }, (_, index) => at("identifying-link", `github.com/jdoe/repo${index}`, "main.tex", index + 1));
    const { row } = renderReview({ ...clean, findings: links });
    expect(within(row("Links to your accounts")).getAllByRole("button")).toHaveLength(5);
    expect(row("Links to your accounts")).toHaveTextContent("2 more");
  });

  it("keeps only a note for a camera-ready copy, and font checks for any paper", () => {
    renderReview({ ...clean, mode: "camera-ready" });
    expect(screen.getByText("NeurIPS camera-ready copy: anonymity is not checked.")).toBeInTheDocument();
    expect(screen.queryByText("Author names")).toBeNull();
    cleanup();
    renderReview({ ...clean, venue: null, mode: null });
    expect(screen.queryByText(/Double-blind/)).toBeNull();
    expect(screen.getByText("Type 3 fonts")).toBeInTheDocument();
  });

  it("settles nothing about the PDF before one is built", () => {
    const { row } = renderReview({ ...clean, pdf: false, fontsRead: false });
    for (const label of ["Author in PDF metadata", "Type 3 fonts", "Fonts not embedded"]) {
      expect(row(label)).not.toHaveClass("ok");
      expect(row(label)).not.toHaveClass("warn");
      expect(row(label)).toHaveTextContent("Build to check");
    }
    expect(screen.getByText("Nothing blocks submission")).toBeInTheDocument();
  });
});
