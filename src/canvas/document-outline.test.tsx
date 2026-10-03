import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { focusWhenShown } from "../editor/focus-when-shown";
import type { OutlineNode } from "../editor/latex/latex-outline";
import { DocumentOutline } from "./document-outline";

afterEach(cleanup);

const nodes: OutlineNode[] = [
  { id: "intro", title: "Introduction", level: 1, line: 3, path: "main.tex", children: [] },
  { id: "eff", title: "Efficiency", level: 1, line: 1, path: "sections/efficiency.tex", children: [] },
] as OutlineNode[];

/**
 * A jump into a file whose editor is not shown yet (the first one into it
 * after a load): its first focus is refused, and it keeps asking as a jump does.
 */
function landWhenShown(editor: HTMLElement) {
  let shown = false;
  setTimeout(() => { shown = true; }, 40);
  focusWhenShown({
    dom: editor,
    focus: () => { if (shown) editor.focus(); },
    hasFocus: () => document.activeElement === editor,
    alive: () => editor.isConnected,
  });
}

/** The outline beside a stand-in editor, wired the way App wires a jump: close, then land. */
function Harness({ land }: { land: (editor: HTMLElement) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DocumentOutline
        nodes={nodes}
        available
        open={open}
        onOpenChange={setOpen}
        onSelect={() => {
          setOpen(false);
          land(screen.getByLabelText("Editor"));
        }}
      />
      <textarea aria-label="Editor" />
    </>
  );
}

const trigger = () => screen.getByRole("button", { name: "Show document outline" });

describe("DocumentOutline focus", () => {
  it("lets a jump whose editor is not shown yet take focus once it is", async () => {
    // Radix handed focus back to the trigger as the popover closed, and the
    // jump's retry took that as the writer moving focus and stopped asking.
    render(<Harness land={landWhenShown} />);
    fireEvent.click(trigger());
    fireEvent.click(await screen.findByRole("button", { name: "Efficiency" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Editor")));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.activeElement).toBe(screen.getByLabelText("Editor"));
  });

  it("leaves focus in an editor the jump focused at once", async () => {
    render(<Harness land={(editor) => editor.focus()} />);
    fireEvent.click(trigger());
    fireEvent.click(await screen.findByRole("button", { name: "Efficiency" }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.activeElement).toBe(screen.getByLabelText("Editor"));
  });

  it("still hands focus back to the trigger when it closes without a choice", async () => {
    render(<Harness land={(editor) => editor.focus()} />);
    fireEvent.click(trigger());
    const entry = await screen.findByRole("button", { name: "Efficiency" });
    fireEvent.keyDown(entry, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });
});
