import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Copy, FilePlus, Pencil } from "lucide-react";
import type { ContextMenuOpenContext } from "@pierre/trees";
import { ProjectTreeItemMenu } from "./project-tree-context-menu";

afterEach(cleanup);

function renderMenu() {
  const context = {
    anchorElement: document.body,
    anchorRect: { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0 },
    close: vi.fn(),
    restoreFocus: vi.fn(),
  } as unknown as ContextMenuOpenContext;
  render(<>
    <button>Row</button>
    <ProjectTreeItemMenu
      context={context}
      actions={[
        { icon: FilePlus, label: "New file", run: vi.fn() },
        { icon: Copy, label: "Copy path", run: vi.fn(), disabled: true },
        { icon: Pencil, label: "Rename", run: vi.fn(), group: true },
      ]}
      destructive={{ label: "Delete", run: vi.fn() }}
    />
  </>);
}

it("lets the arrows, Home and End reach the enabled items from the row that opened it", () => {
  renderMenu();
  screen.getByRole("button", { name: "Row" }).focus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(screen.getByRole("menuitem", { name: "New file" })).toHaveFocus();
  // The disabled item is passed over.
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(screen.getByRole("menuitem", { name: "New file" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
  // Tab stays in the menu rather than walking away from it while it is open.
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(screen.getByRole("menuitem", { name: "New file" })).toHaveFocus();
});
