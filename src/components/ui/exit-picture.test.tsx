import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useExitPicture } from "./exit-picture";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Overlay({ label, children }: { label: string; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useExitPicture([ref]);
  return <div ref={ref} role="dialog" aria-label={label} className="overlay">{label}{children}</div>;
}

function Harness({ next = false, withFrame = false }: { next?: boolean; withFrame?: boolean }) {
  const [open, setOpen] = useState(true);
  return <>
    <button onClick={() => setOpen(false)}>Close</button>
    {open ? <Overlay key="first" label="First">{withFrame && <iframe title="frame" />}</Overlay> : next && <Overlay key="second" label="Second" />}
  </>;
}

/** An exit animation the test finishes by hand. */
function animate() {
  let finish = () => {};
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  vi.spyOn(Element.prototype, "getAnimations").mockImplementation(function (this: Element) {
    return this.hasAttribute("data-leaving") ? [{ finished } as unknown as Animation] : [];
  });
  return () => act(async () => { finish(); await finished; });
}

it("puts the closed overlay back, inert and without its role, until its exit ends", async () => {
  const finish = animate();
  render(<Harness />);
  const overlay = screen.getByRole("dialog", { name: "First" });
  await act(async () => { fireEvent.click(screen.getByText("Close")); });
  expect(overlay).toBeInTheDocument();
  expect(overlay).toHaveAttribute("data-leaving");
  expect(overlay.inert).toBe(true);
  expect(overlay).not.toHaveAttribute("role");
  expect(screen.queryByRole("dialog")).toBeNull();
  await finish();
  expect(overlay).not.toBeInTheDocument();
});

it("leaves at once when another overlay takes its place or it holds a frame", async () => {
  animate();
  const replaced = render(<Harness next />);
  const first = screen.getByText("First");
  await act(async () => { fireEvent.click(screen.getByText("Close")); });
  expect(first).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Second" })).toBeInTheDocument();
  replaced.unmount();

  render(<Harness withFrame />);
  const framed = screen.getByText("First");
  await act(async () => { fireEvent.click(screen.getByText("Close")); });
  expect(framed).not.toBeInTheDocument();
});
