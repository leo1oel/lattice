import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@tauri-apps/plugin-dialog";
import { chooseAction, confirmAction } from "../../app-utils";
import { ConfirmActionProvider } from "./confirm-action-dialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A button that asks, and an output that shows the answer it got. */
function Harness(props: { request: () => Promise<unknown> }) {
  const [answer, setAnswer] = useState("none");
  return (
    <ConfirmActionProvider>
      <button type="button" onClick={() => void props.request().then((value) => setAnswer(String(value)))}>
        Request
      </button>
      <output>{answer}</output>
    </ConfirmActionProvider>
  );
}

const requestDeletion = () => confirmAction("Delete “notes.tex” from this project?");

describe("ConfirmActionProvider", () => {
  it("uses the styled in-app dialog, cancels destructive actions by default, and confirms only on Delete", async () => {
    render(<Harness request={requestDeletion} />);
    const trigger = screen.getByRole("button", { name: "Request" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Delete “notes.tex” from this project?" });
    expect(dialog).toHaveAccessibleDescription("This action cannot be undone");
    expect(document.querySelector(".modal-backdrop"))
      .toHaveClass("confirm-action-backdrop");
    expect(screen.getByText("This action cannot be undone")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByText("false")).toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    // True only after the destructive button is explicitly pressed.
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.getByText("true")).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("returns an explicit alternative without treating dialog dismissal as that choice", async () => {
    render(<Harness request={() => chooseAction({
      title: "Remove this bibliography entry?",
      message: "It is cited in two places.",
      confirmLabel: "Remove citations too",
      alternativeLabel: "Keep citations",
      alternativeDestructive: true,
      destructive: true,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Request" }));

    const dialog = await screen.findByRole("dialog", { name: "Remove this bibliography entry?" });
    expect(dialog).toHaveAccessibleDescription("It is cited in two places");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    // The destructive answer leads the row; a destructive alternative stays quiet beside it.
    expect(screen.getByRole("button", { name: "Remove citations too" })).toHaveClass("ui-button--danger");
    expect(screen.getByRole("button", { name: "Keep citations" })).toHaveClass("ui-button--ghost", "confirm-action-danger");
    expect(dialog.querySelector(".modal-icon")).toHaveAttribute("data-tone", "danger");
    fireEvent.click(screen.getByRole("button", { name: "Keep citations" }));

    await waitFor(() => expect(screen.getByText("alternative")).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
