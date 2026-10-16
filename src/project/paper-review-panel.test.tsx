import { cleanup, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paperReview } from "../app/paper-review";
import { activateAppLocale } from "../i18n";
import { PaperReviewPanel } from "./paper-review-panel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

const stored = (unread?: string[]) => ({
  version: 1,
  id: "2026-10-16T02-42-05Z",
  createdAt: "2026-10-16T02:42:05.000Z",
  seconds: 90,
  venue: null,
  readiness: "almost",
  verdict: "Close to ready.",
  strengths: [],
  findings: [],
  dropped: 0,
  ...unread ? { unread } : {},
});

async function show(review: ReturnType<typeof stored>) {
  invokeMock.mockImplementation(async (command) => (command === "read_paper_review" ? review : null));
  await paperReview.load();
  render(<PaperReviewPanel venue={null} annotations={[]} onClose={vi.fn()} />);
}

beforeEach(() => {
  activateAppLocale("en");
  paperReview.reset();
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

describe("PaperReviewPanel", () => {
  it("says the verdict is not about the whole paper, naming the included files it could not read", async () => {
    await show(stored(["sections/results.tex"]));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Not the whole paper: Lattice couldn’t read sections/results.tex, so this review didn’t cover it.",
    );

    cleanup();
    paperReview.reset();
    await show(stored(["sections/results.tex", "appendix.tex"]));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Not the whole paper: Lattice couldn’t read sections/results.tex and appendix.tex, so this review didn’t cover them.",
    );
  });

  it("says nothing of coverage when the review read every file", async () => {
    await show(stored());
    expect(screen.getByText("Close to ready.")).toBeInTheDocument();
    expect(screen.queryByText(/Not the whole paper/)).not.toBeInTheDocument();
  });
});
