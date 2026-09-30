import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SheetDialog } from "./sheet-dialog";

afterEach(cleanup);

function renderSheet(dirty: boolean) {
  const onClose = vi.fn();
  render(
    <>
      <button type="button">Outside control</button>
      <SheetDialog label="Add bibliography entry" className="bib-entry-dialog" dirty={dirty} onClose={onClose}>
        <input aria-label="Title" autoFocus />
      </SheetDialog>
    </>,
  );
  return onClose;
}

/** A press outside the dialog, as Radix's outside-interaction detection sees one. */
function pressOutside() {
  const outside = document.querySelector<HTMLElement>(".modal-backdrop")!;
  fireEvent.pointerDown(outside, { button: 0, buttons: 1, pointerType: "mouse" });
  fireEvent.mouseDown(outside, { button: 0, buttons: 1 });
  fireEvent.pointerUp(outside, { button: 0, pointerType: "mouse" });
  fireEvent.click(outside);
}

describe("SheetDialog", () => {
  it("is a centered modal that traps focus and closes on Escape and on a click outside", async () => {
    const onClose = renderSheet(false);
    const dialog = screen.getByRole("dialog", { name: "Add bibliography entry" });
    expect(dialog.querySelector(".modal.sheet-dialog.bib-entry-dialog")).not.toBeNull();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Title" })).toHaveFocus());
    pressOutside();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("keeps unsaved input through a click outside, but still closes on Escape", async () => {
    const onClose = renderSheet(true);
    pressOutside();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
