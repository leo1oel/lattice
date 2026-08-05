import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalDialog } from "./modal-dialog";

afterEach(cleanup);

function Harness(props: {
  closeDisabled?: boolean;
  focusDialogOnOpen?: boolean;
  onClose?: () => void;
  onWindowDrag?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
      {open && (
        <ModalDialog
          label="Example dialog"
          closeDisabled={props.closeDisabled}
          focusDialogOnOpen={props.focusDialogOnOpen}
          windowDragTop={props.onWindowDrag ? {
            onMouseDown: props.onWindowDrag,
            onDoubleClick: vi.fn(),
          } : undefined}
          onClose={() => {
            props.onClose?.();
            setOpen(false);
          }}
        >
          <div>
            <input aria-label="First field" autoFocus={!props.focusDialogOnOpen} />
            <button type="button">Last action</button>
          </div>
        </ModalDialog>
      )}
      <button type="button">Outside control</button>
    </>
  );
}

describe("ModalDialog", () => {
  it("labels the dialog, traps focus, and closes on Escape", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    trigger.focus();
    fireEvent.click(trigger);

    expect(screen.getByRole("dialog", { name: "Example dialog" })).toBeInTheDocument();
    const first = screen.getByRole("textbox", { name: "First field" });
    await waitFor(() => expect(first).toHaveFocus());

    const last = screen.getByRole("button", { name: "Last action" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    const guards = document.querySelectorAll<HTMLElement>("[data-radix-focus-guard]");
    guards[guards.length - 1].focus();
    await waitFor(() => expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("blocks dismissal while closeDisabled", () => {
    const onClose = vi.fn();
    render(<Harness closeDisabled onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByRole("dialog", { name: "Example dialog" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("can keep initial focus on the dialog surface", async () => {
    render(<Harness focusDialogOnOpen />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));

    const dialog = screen.getByRole("dialog", { name: "Example dialog" });
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(screen.getByRole("textbox", { name: "First field" })).not.toHaveFocus();
  });

  it("keeps the dialog open through a complete top-strip drag gesture", () => {
    const onClose = vi.fn();
    const onWindowDrag = vi.fn();
    render(<Harness onClose={onClose} onWindowDrag={onWindowDrag} />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    const topStrip = document.querySelector<HTMLElement>("[data-modal-window-drag]")!;

    fireEvent.pointerDown(topStrip, { button: 0, buttons: 1, pointerType: "mouse" });
    fireEvent.mouseDown(topStrip, { button: 0, buttons: 1, detail: 1 });
    fireEvent.pointerUp(topStrip, { button: 0, buttons: 0, pointerType: "mouse" });
    fireEvent.mouseUp(topStrip, { button: 0, buttons: 0, detail: 1 });
    fireEvent.click(topStrip, { button: 0, detail: 1 });

    expect(onWindowDrag).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Example dialog" })).toBeInTheDocument();
  });
});
