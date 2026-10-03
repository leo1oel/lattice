import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { EditorStatusBar } from "./editor-status-bar";
import { createEditorComment } from "../editor/comments/editor-comment-data";
import { activateAppLocale } from "../i18n";

type StatusProps = ComponentProps<typeof EditorStatusBar>;

const texcount = { text: 120_000, headers: 400, captions: 0, total: 120_400, source: "texcount" };

const comment = (resolved = false) => ({
  ...createEditorComment({ path: "main.tex", source: "Hello bold world", from: 6, to: 10, body: "Note", authorId: "ada", authorName: "Ada" })!,
  resolved,
});

function renderStatus(overrides: Partial<StatusProps>) {
  const props: StatusProps = {
    position: { line: 1, column: 0 }, onGotoLine: vi.fn(), keymap: "default", vimMode: "", breadcrumb: [],
    path: "main.tex", onNavigate: vi.fn(), hasDiagnostics: false, comments: [], onOpenComments: vi.fn(),
    todoCount: 0, onOpenTodos: vi.fn(), projectWordCount: null, selectedText: "", source: "",
    ...overrides,
  };
  return render(<EditorStatusBar {...props} />);
}

describe("EditorStatusBar", () => {
  beforeEach(() => activateAppLocale("en"));
  afterEach(cleanup);

  it.each([
    [[], 0, "Comments", "TODOs"],
    [[comment(), comment(true)], 1, "1 comment", "1 TODO"],
    [[comment(), comment()], 3, "2 comments", "3 TODOs"],
  ])("counts open comments and TODOs in words that agree with the number", (comments, todoCount, commentLabel, todoLabel) => {
    renderStatus({ comments, todoCount });
    expect(screen.getByTitle("Editor comments")).toHaveTextContent(new RegExp(`^${commentLabel}$`));
    expect(screen.getByTitle("Manuscript TODOs")).toHaveTextContent(new RegExp(`^${todoLabel}$`));
  });

  it.each([
    [{ selectedText: "Hello big\nworld", projectWordCount: texcount }, "Word count: Selection, 3 words"],
    [{ projectWordCount: texcount }, "Word count: Manuscript, 120,400 words"],
    [{ projectWordCount: { ...texcount, source: "estimate" } }, "Word count: Manuscript, ≈120,400 words"],
    [{ source: "A" }, "Word count: This file, 1 word"],
    [{ source: "Two words" }, "Word count: This file, 2 words"],
  ])("names the scope of the one count the footer shows", (overrides, name) => {
    renderStatus(overrides);
    expect(screen.getByRole("button", { name })).toBeInTheDocument();
  });

  function openDetails() {
    fireEvent.click(screen.getByRole("button", { name: /^Word count:/ }));
    return screen.getByRole("dialog", { name: "Word count" });
  }

  it("lays out every count by scope, keeping the manuscript first and texcount's breakdown", () => {
    renderStatus({ projectWordCount: texcount, path: "chapters/intro.tex", source: "Two words", selectedText: "Hello big\nworld" });
    const details = openDetails();
    expect(within(details).getAllByRole("term").map((term) => term.textContent)).toEqual(["Manuscript", "This file", "Selection"]);
    expect(details).toHaveTextContent("Manuscript120,400 wordsRoot document and its includes, via texcountText 120,000 · headings 400 · captions 0");
    expect(details).toHaveTextContent("This file2 wordsintro.tex, markup included · 9 characters");
    expect(details).toHaveTextContent("Selection3 words15 characters · 2 lines");
  });

  it("marks an estimated manuscript count as one, and says when there is none", () => {
    renderStatus({ projectWordCount: { ...texcount, source: "estimate" } });
    let details = openDetails();
    expect(details).toHaveTextContent("Manuscript≈120,400 wordsRoot document only, estimated without texcount");
    expect(details).not.toHaveTextContent("headings");
    expect(within(details).queryByText("Selection")).toBeNull();
    cleanup();

    renderStatus({ projectWordCount: null, source: "One" });
    details = openDetails();
    expect(details).toHaveTextContent("ManuscriptUnavailableNeeds a root document to count from");
    expect(details).toHaveTextContent("This file1 word");
  });
});
