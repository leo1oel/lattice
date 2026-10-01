import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { ProjectReplaceDialog, type ReplacePreviewResult } from "./project-replace-dialog";
import { activateAppLocale } from "../i18n";

type ReplaceProps = ComponentProps<typeof ProjectReplaceDialog>;

const twoMatches: ReplacePreviewResult = {
  matches: [
    { path: "main.tex", line: 3, column: 1, preview: "alpha token" },
    { path: "sections/a.tex", line: 9, column: 4, preview: "the token" },
  ],
  files: 2,
  replacements: 2,
};

function renderReplace(overrides: Partial<ReplaceProps> = {}) {
  const props: ReplaceProps = {
    open: true,
    busy: false,
    error: null,
    preview: null,
    onClose: vi.fn(),
    onPreview: vi.fn(),
    onReplace: vi.fn(),
    ...overrides,
  };
  const view = render(<ProjectReplaceDialog {...props} />);
  return {
    props,
    rerenderWith: (next: Partial<ReplaceProps>) => view.rerender(<ProjectReplaceDialog {...Object.assign(props, next)} />),
    find: () => screen.getByRole("searchbox", { name: "Find text to replace" }),
    replaceButton: () => screen.getByRole("button", { name: /^Replace/ }),
  };
}

describe("ProjectReplaceDialog", () => {
  beforeEach(() => activateAppLocale("en"));
  afterEach(cleanup);

  it("replaces only what the shown preview was asked for", () => {
    const view = renderReplace();
    fireEvent.change(view.find(), { target: { value: "token" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(view.props.onPreview).toHaveBeenCalledWith("token", { matchCase: true, useRegex: false });
    view.rerenderWith({ preview: twoMatches });
    expect(view.replaceButton()).toHaveTextContent("Replace 2");
    expect(view.replaceButton()).toBeEnabled();

    // Editing the query after previewing disarms the stale "Replace 2".
    fireEvent.change(view.find(), { target: { value: "tok" } });
    expect(screen.queryByText("main.tex:3")).toBeNull();
    expect(view.replaceButton()).toBeDisabled();
    fireEvent.click(view.replaceButton());
    expect(view.props.onReplace).not.toHaveBeenCalled();

    // So does switching an option.
    fireEvent.change(view.find(), { target: { value: "token" } });
    expect(view.replaceButton()).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Regex" }));
    expect(view.replaceButton()).toBeDisabled();

    // Previewing the current search arms it again.
    fireEvent.keyDown(view.find(), { key: "Enter" });
    expect(view.props.onPreview).toHaveBeenLastCalledWith("token", { matchCase: true, useRegex: true });
    fireEvent.click(view.replaceButton());
    expect(view.props.onReplace).toHaveBeenCalledWith("token", "", { matchCase: true, useRegex: true });
  });
});
