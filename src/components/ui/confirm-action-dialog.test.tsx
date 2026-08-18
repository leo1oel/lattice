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

function Harness() {
  const [answer, setAnswer] = useState("none");
  return (
    <ConfirmActionProvider>
      <button
        type="button"
        onClick={() => {
          void confirmAction("Delete “notes.tex” from this project?")
            .then((confirmed) => setAnswer(String(confirmed)));
        }}
      >
        Request deletion
      </button>
      <output>{answer}</output>
    </ConfirmActionProvider>
  );
}

function ChoiceHarness() {
  const [answer, setAnswer] = useState("none");
  return (
    <ConfirmActionProvider>
      <button
        type="button"
        onClick={() => {
          void chooseAction({
            title: "Remove this bibliography entry?",
            message: "It is cited in two places.",
            confirmLabel: "Remove citations too",
            alternativeLabel: "Keep citations",
            alternativeDestructive: true,
            destructive: true,
          }).then(setAnswer);
        }}
      >
        Request choice
      </button>
      <output>{answer}</output>
    </ConfirmActionProvider>
  );
}

describe("ConfirmActionProvider", () => {
  it("uses the styled in-app dialog and keeps destructive actions cancelled by default", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Request deletion" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Delete “notes.tex” from this project?" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription("This action cannot be undone.");
    expect(document.querySelector(".modal-backdrop"))
      .toHaveClass("confirm-action-backdrop");
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByText("false")).toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("returns true only after the destructive button is explicitly pressed", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Request deletion" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.getByText("true")).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("returns an explicit alternative without treating dialog dismissal as that choice", async () => {
    render(<ChoiceHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Request choice" }));

    const dialog = await screen.findByRole("dialog", { name: "Remove this bibliography entry?" });
    expect(dialog).toHaveAccessibleDescription("It is cited in two places.");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep citations" }));

    await waitFor(() => expect(screen.getByText("alternative")).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
