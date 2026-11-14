import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MenuRequest } from "@danfessler/trellis-react";
import { afterEach, expect, it, vi } from "vitest";
import { PanelMenu } from "@/trellis/trellis-panel-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "./context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";

afterEach(cleanup);

/**
 * The menu's rows scroll in a list of their own with the native bar hidden,
 * and the ScrollArea's track (scroll-area.css) is a sibling of that list on
 * the non-scrolling surface, so it stays put while the rows scroll.
 */
function expectAppScrollbar(menu: HTMLElement, lastRow: string) {
  expect(menu).toHaveClass("relative", "flex", "flex-col", "overflow-hidden");
  expect(menu).not.toHaveClass("overflow-y-auto", "fluid-hover-surface");

  const list = menu.querySelector(':scope > [data-slot="menu-viewport"]');
  expect(list).toHaveClass("overflow-y-auto", "fluid-hover-surface", "[scrollbar-width:none]");
  expect(list).toContainElement(screen.getByRole("menuitem", { name: lastRow }));

  const track = menu.querySelector(":scope > .lattice-scrollbar.external-scrollbar");
  expect(track).toHaveAttribute("data-orientation", "vertical");
  expect(track?.querySelector('[data-slot="scroll-area-thumb"]')).toBeInTheDocument();
}

it("scrolls a dropdown menu's rows under the app's scrollbar on the non-scrolling surface", async () => {
  render(
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger asChild><button type="button">Open</button></DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>First</DropdownMenuItem>
        <DropdownMenuItem>Second</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  expectAppScrollbar(await screen.findByRole("menu"), "Second");
});

it("scrolls a context menu's rows under the app's scrollbar on the non-scrolling surface", async () => {
  render(
    <ContextMenu modal={false}>
      <ContextMenuTrigger>Row</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Rename</ContextMenuItem>
        <ContextMenuItem>Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByText("Row"), { clientX: 20, clientY: 20 });
  expectAppScrollbar(await screen.findByRole("menu"), "Delete");
});

it("scrolls a panel's ⋯ menu rows under the app's scrollbar on the non-scrolling surface", async () => {
  const request: MenuRequest = {
    entries: [{ id: "float", label: "Float" }, "separator", { id: "close", label: "Close" }],
    x: 20,
    y: 20,
    align: "start",
    anchor: null,
    panelId: "editor",
    close: vi.fn(),
  };
  render(<PanelMenu request={request} open onDismiss={vi.fn()} onClose={vi.fn()} />);
  expectAppScrollbar(await screen.findByRole("menu"), "Close");
});
