import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Popover } from "radix-ui";
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
          windowDragTop={props.onWindowDrag ? { onMouseDown: props.onWindowDrag, onDoubleClick: vi.fn() } : undefined}
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

/** A complete mouse press, as Radix's outside-interaction detection sees one. */
function press(target: Element) {
  fireEvent.pointerDown(target, { button: 0, buttons: 1, pointerType: "mouse" });
  fireEvent.mouseDown(target, { button: 0, buttons: 1, detail: 1 });
  fireEvent.pointerUp(target, { button: 0, buttons: 0, pointerType: "mouse" });
  fireEvent.mouseUp(target, { button: 0, buttons: 0, detail: 1 });
  fireEvent.click(target, { button: 0, detail: 1 });
}

const backdrops = () => [...document.querySelectorAll(".modal-backdrop")];

describe("ModalDialog", () => {
  it("opens without touching the rest of the document", async () => {
    render(<Harness />);
    const app = screen.getByRole("button", { name: "Outside control" });
    const styleSheets = document.querySelectorAll("style").length;
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));

    const dialog = screen.getByRole("dialog", { name: "Example dialog" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "First field" })).toHaveFocus());
    // Radix's modal mode restyles the whole document on open (pointer-events
    // on body, a scroll-lock stylesheet, aria-hidden on every sibling), which
    // WebKit takes over a second to apply with a long document open.
    expect(document.body.getAttribute("style") ?? "").toBe("");
    expect(document.body).not.toHaveAttribute("data-scroll-locked");
    expect(document.querySelectorAll("style")).toHaveLength(styleSheets);
    expect(document.querySelectorAll("[aria-hidden='true'], [data-aria-hidden]")).toHaveLength(0);
    expect(app.closest("[aria-hidden]")).toBeNull();
  });

  it("closes on a backdrop press but not on a press of anything above it", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    const first = screen.getByRole("textbox", { name: "First field" });
    await waitFor(() => expect(first).toHaveFocus());

    // A toast floats above the backdrop; pressing it must keep the dialog.
    const toast = document.createElement("button");
    toast.setAttribute("data-app-toast", "");
    document.body.append(toast);
    press(toast);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onClose).not.toHaveBeenCalled();
    toast.remove();

    press(backdrops()[0]);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("lets a popover inside the dialog take focus", async () => {
    render(
      <ModalDialog label="Example dialog" onClose={vi.fn()}>
        <Popover.Root>
          <Popover.Trigger>Options</Popover.Trigger>
          <Popover.Portal>
            <Popover.Content>
              <input aria-label="Popover field" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </ModalDialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    const field = await screen.findByRole("textbox", { name: "Popover field" });
    expect(screen.getByRole("dialog", { name: "Example dialog" })).not.toContainElement(field);
    // The dialog's trap shares Radix's focus-scope stack, so the popover's
    // scope pauses it instead of the trap pulling focus back.
    field.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(field).toHaveFocus();
  });

  it("dismisses only the top dialog of a stack", async () => {
    const onCloseLower = vi.fn();
    const onCloseUpper = vi.fn();
    function Stack() {
      const [upper, setUpper] = useState(true);
      return (
        <>
          <ModalDialog label="Lower" onClose={onCloseLower}>
            <button type="button">Lower action</button>
          </ModalDialog>
          {upper && (
            <ModalDialog label="Upper" onClose={() => { onCloseUpper(); setUpper(false); }}>
              <button type="button">Upper action</button>
            </ModalDialog>
          )}
        </>
      );
    }
    render(<Stack />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upper action" })).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onCloseUpper).toHaveBeenCalledOnce());
    expect(onCloseLower).not.toHaveBeenCalled();
    expect(backdrops()).toHaveLength(1);
  });

  it("closes only the upper dialog on its backdrop press", async () => {
    const onCloseLower = vi.fn();
    const onCloseUpper = vi.fn();
    render(
      <>
        <ModalDialog label="Lower" onClose={onCloseLower}>
          <button type="button">Lower action</button>
        </ModalDialog>
        <ModalDialog label="Upper" onClose={onCloseUpper}>
          <button type="button">Upper action</button>
        </ModalDialog>
      </>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Upper action" })).toHaveFocus());
    press(backdrops()[1]);
    await waitFor(() => expect(onCloseUpper).toHaveBeenCalledOnce());
    expect(onCloseLower).not.toHaveBeenCalled();
  });

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
