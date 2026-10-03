import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Tip } from "./icon-tip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

afterEach(cleanup);

const hover = (target: Element) => {
  fireEvent.pointerMove(target, { pointerType: "mouse" });
};
const leave = (target: Element) => {
  fireEvent.pointerLeave(target, { pointerType: "mouse" });
};
/** Longer than Tip's 280 ms open delay. */
const pastOpenDelay = () => act(() => new Promise((resolve) => setTimeout(resolve, 400)));

function MenuWithTip({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <Tip label="More actions">
        <DropdownMenuTrigger asChild>
          <button type="button">…</button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent>
        <DropdownMenuItem>Zoom in</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

it("describes its trigger on hover", async () => {
  const view = render(<Tip label="Zoom in"><button type="button">+</button></Tip>);
  hover(view.getByRole("button", { name: "+" }));
  expect(await view.findByRole("tooltip")).toHaveTextContent("Zoom in");
});

it("stays shut over its trigger's open menu, and closes when the menu opens under it", async () => {
  const onOpenChange = (open: boolean) => view.rerender(<MenuWithTip open={open} onOpenChange={onOpenChange} />);
  const view = render(<MenuWithTip open={false} onOpenChange={onOpenChange} />);
  const trigger = view.getByRole("button", { name: "More actions" });

  // A shortcut can open the menu while the pointer rests on its described
  // trigger; the tooltip must give way instead of covering the first items.
  hover(trigger);
  expect(await view.findByRole("tooltip")).toBeInTheDocument();
  onOpenChange(true);
  expect(await view.findByRole("menu")).toBeInTheDocument();
  await waitFor(() => expect(view.queryByRole("tooltip")).toBeNull());

  // Returning the pointer to the trigger while the menu is open.
  leave(trigger);
  hover(trigger);
  await pastOpenDelay();
  expect(view.queryByRole("tooltip")).toBeNull();
  expect(view.getByRole("menu")).toBeInTheDocument();

  // Once the menu has closed, the trigger is described again.
  fireEvent.keyDown(view.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
  leave(trigger);
  hover(trigger);
  expect(await view.findByRole("tooltip")).toHaveTextContent("More actions");
});
