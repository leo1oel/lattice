import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { EditorStatusBar } from "./editor-status-bar";
import { createEditorComment } from "../editor/comments/editor-comment-data";
import { activateAppLocale } from "../i18n";

type StatusProps = ComponentProps<typeof EditorStatusBar>;

const comment = (resolved = false) => ({
  ...createEditorComment({ path: "main.tex", source: "Hello bold world", from: 6, to: 10, body: "Note", authorId: "ada", authorName: "Ada" })!,
  resolved,
});

function renderStatus(overrides: Partial<StatusProps>) {
  const props: StatusProps = {
    position: { line: 1, column: 0 }, onGotoLine: vi.fn(), keymap: "default", vimMode: "", breadcrumb: [],
    breadcrumbPath: "main.tex", onNavigate: vi.fn(), hasDiagnostics: false, comments: [], onOpenComments: vi.fn(),
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
});
