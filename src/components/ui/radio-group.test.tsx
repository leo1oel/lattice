import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { RadioGroup, RadioItem } from "./radio-group";
import { SizeProvider } from "../../lib/size-provider";
import { ShapeProvider } from "../../lib/shape-provider";
import { useSizeContext } from "../../lib/size-context";
import { useFluidHover } from "../../hooks/use-fluid-hover";

afterEach(cleanup);

it("keeps the initially selected dot visible and follows keyboard selection with provider styles", () => {
  function Example() {
    const [index, setIndex] = useState(1);
    return <ShapeProvider defaultShape="pill"><SizeProvider size="compact">
      <RadioGroup selectedIndex={index}>
        <RadioItem index={0} label="First" onSelect={() => setIndex(0)} />
        <RadioItem index={1} label="Second" onSelect={() => setIndex(1)} />
      </RadioGroup>
    </SizeProvider></ShapeProvider>;
  }
  render(<Example />);
  const selected = screen.getByRole("radio", { name: "Second" });
  expect(selected).toHaveAttribute("aria-checked", "true");
  expect(selected).toHaveClass("h-7", "rounded-[20px]");
  expect(selected.querySelector('.bg-foreground')?.parentElement).toHaveStyle({ opacity: "1", transform: "none" });
  fireEvent.keyDown(selected, { key: "ArrowUp" });
  expect(screen.getByRole("radio", { name: "First" })).toHaveAttribute("aria-checked", "true");
  expect(selected).toHaveAttribute("aria-checked", "false");
});

it("does not leak ignored size writes when a controlled provider becomes uncontrolled", () => {
  function Consumer() {
    const { size, setSize } = useSizeContext();
    return <button onClick={() => setSize("compact")}>{size}</button>;
  }
  const view = render(<SizeProvider size="compact"><Consumer /></SizeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "compact" }));
  view.rerender(<SizeProvider><Consumer /></SizeProvider>);
  expect(screen.getByRole("button", { name: "default" })).toBeInTheDocument();
});

it("routes a gap click to the committed active row and clears marks on replacement rows", () => {
  const container = document.createElement("div");
  const row = document.createElement("button");
  const replacement = document.createElement("button");
  container.append(row, replacement);
  document.body.append(container);
  const click = vi.fn();
  row.addEventListener("click", click);
  const hook = renderHook(() => useFluidHover(useRef(container)));
  act(() => hook.result.current.registerItem(1, row));
  act(() => hook.result.current.setActiveIndex(1));
  act(() => hook.result.current.handlers.onClick({ target: container } as unknown as React.MouseEvent));
  expect(click).toHaveBeenCalledOnce();
  act(() => hook.result.current.registerItem(1, replacement));
  expect(replacement).toHaveAttribute("data-fluid-hover-active");
  act(() => hook.result.current.setActiveIndex(null));
  expect(row).not.toHaveAttribute("data-fluid-hover-active");
  expect(replacement).not.toHaveAttribute("data-fluid-hover-active");
  hook.unmount();
  container.remove();
});
