import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";

afterEach(cleanup);

it("scrolls a menu's rows in a list of their own, under the app's scrollbar on the non-scrolling surface", async () => {
  render(
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger asChild><button type="button">Open</button></DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>First</DropdownMenuItem>
        <DropdownMenuItem>Second</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  const menu = await screen.findByRole("menu");
  expect(menu).toHaveClass("relative", "flex", "flex-col", "overflow-hidden");
  expect(menu).not.toHaveClass("overflow-y-auto", "fluid-hover-surface");

  const list = menu.querySelector(':scope > [data-slot="menu-viewport"]');
  expect(list).toHaveClass("overflow-y-auto", "fluid-hover-surface", "[scrollbar-width:none]");
  expect(list).toContainElement(screen.getByRole("menuitem", { name: "Second" }));

  // The ScrollArea's track (scroll-area.css), a sibling of the list, so it
  // stays put while the rows scroll.
  const track = menu.querySelector(":scope > .lattice-scrollbar.external-scrollbar");
  expect(track).toHaveAttribute("data-orientation", "vertical");
  expect(track?.querySelector('[data-slot="scroll-area-thumb"]')).toBeInTheDocument();
});
