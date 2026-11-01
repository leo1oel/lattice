import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateProjectDialog, RenameDialog } from "./project-dialogs";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

// Pinyin typed into the field, with Enter putting the letters down as they are:
// WebKit reports that Enter as keyCode 229 while the composition is open.
const composingEnter = { key: "Enter", keyCode: 229, isComposing: true };

describe("project dialogs under an input method", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("creates no project while the name is being composed", () => {
    const onCreate = vi.fn();
    render(
      <CreateProjectDialog
        projectName="transformer"
        setProjectName={vi.fn()}
        projectVenue="blank"
        setProjectVenue={vi.fn()}
        error={null}
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Project name" });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, composingEnter);
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    // WebKit sends compositionend just before the Enter that accepted the
    // candidate, so that Enter still belongs to the input method.
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("creates the project on a plain Enter", () => {
    const onCreate = vi.fn();
    render(
      <CreateProjectDialog
        projectName="transformer"
        setProjectName={vi.fn()}
        projectVenue="blank"
        setProjectVenue={vi.fn()}
        error={null}
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Project name" }), { key: "Enter", keyCode: 13 });
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("renames nothing while the new name is being composed, then renames on the next Enter", async () => {
    vi.useFakeTimers();
    const onRename = vi.fn(async () => {});
    render(<RenameDialog target={{ kind: "label", label: "sec:intro" }} error={null} onRename={onRename} onClose={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "New name" });
    fireEvent.change(input, { target: { value: "sec:shiyan" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, composingEnter);
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    expect(onRename).not.toHaveBeenCalled();

    act(() => vi.runAllTimers());
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    });
    expect(onRename).toHaveBeenCalledWith("sec:shiyan");
  });
});
