/**
 * Where the block controls sit and which block the gutter targets (spec
 * R-CHR-5): centred on a rule's line, a short display formula's box and a
 * table's first row, and the nearer block from the margin between two.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({ ...(await importOriginal<typeof import("@tauri-apps/api/core")>()), invoke }));

const surface = () => screen.getByRole("textbox", { name: "Markdown document editor" }) as HTMLElement & { editor: Editor };
const setRect = (element: Element, rect: DOMRect) => vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
const pressGrip = (grip: HTMLElement) => {
  fireEvent.pointerDown(grip, { button: 0, clientY: 0 });
  fireEvent.pointerUp(window, { clientY: 0 });
};

function renderEditor(text: string) {
  render(<LatticeVisualMarkdownEditor text={text} activePath="notes.md" onChangeMarkdown={() => true} onUndo={() => true} onRedo={() => true} />);
  return { get editor() { return surface().editor; } };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("block controls placement (R-CHR-5)", () => {
  it("centres the controls on a rule's line and reaches the rule from the margin below it", async () => {
    const { editor } = renderEditor("Above\n\n---\n\nBelow");
    const blocks = [...surface().children];
    setRect(blocks[0]!, new DOMRect(100, 100, 400, 28));
    setRect(blocks[1]!, new DOMRect(100, 160, 400, 1));
    setRect(blocks[2]!, new DOMRect(100, 195, 400, 28));
    // In the rule's lower margin: nearer the rule than the paragraph below,
    // where "the block just above" used to leave it reachable from nowhere.
    fireEvent.mouseMove(surface(), { clientX: 150, clientY: 175 });
    const grip = await screen.findByRole("button", { name: "Select block" });
    // The 24px controls straddle the 1px line, not hang below it.
    expect(grip.parentElement!.style.top).toBe("148.5px");
    pressGrip(grip);
    expect((editor.state.selection as NodeSelection).node?.type.name).toBe("horizontalRule");
  });

  it("centres the controls on a table's first row and a line of display math", async () => {
    renderEditor("| A | B |\n| - | - |\n| 1 | 2 |\n\n$$\nE = mc^2\n$$");
    const [table, math] = [...surface().children] as HTMLElement[];
    setRect(table!, new DOMRect(100, 100, 400, 80));
    setRect(table!.querySelector("tr")!, new DOMRect(100, 100, 400, 40));
    setRect(math!, new DOMRect(100, 200, 400, 36));
    fireEvent.mouseMove(table!, { clientX: 150, clientY: 160 });
    const controls = (await screen.findByRole("button", { name: "Select block" })).parentElement!;
    expect(controls.style.top).toBe("108px");
    fireEvent.mouseMove(math!, { clientX: 150, clientY: 210 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Select block" }).parentElement!.style.top).toBe("206px"));
  });
});
