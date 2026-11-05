import { act, cleanup, render, screen } from "@testing-library/react";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyInfo } from "../telemetry/app-notify";
import { createProofreadBridge } from "./proofread-bridge";
import { ProofreadLayer } from "./proofread-layer";

vi.mock("../telemetry/app-notify", () => ({ notifyInfo: vi.fn() }));
vi.mock("../agent/agent-proofread", async (original) => ({
  ...await original<typeof import("../agent/agent-proofread")>(),
  // The agent is still working: the card stays loading.
  proofreadWithAgent: () => new Promise(() => {}),
}));

const DOC = Array.from({ length: 40 }, (_, line) => `Line ${line + 1} of the paper.`).join("\n");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function mount(selection: EditorSelection) {
  const bridge = createProofreadBridge();
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: DOC, selection, extensions: bridge.extension }) });
  const viewRef = createRef<EditorView>() as { current: EditorView | null };
  viewRef.current = view;
  render(<ProofreadLayer bridge={bridge} projectRoot="/paper" activeFile="main.tex" editorKey="main.tex" editable viewRef={viewRef} />);
  return { bridge, view };
}

const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

describe("ProofreadLayer", () => {
  // ⌘⌥P with nothing selected did nothing at all.
  it("says what it needs when nothing is selected", () => {
    const { bridge, view } = mount(EditorSelection.single(5));
    expect(bridge.start(view)).toBe(true);
    expect(notifyInfo).toHaveBeenCalledWith("Proofread", "Select the text to proofread first.", expect.anything());
    expect(document.querySelector(".proofread-card-host")).toBeNull();
  });

  // A selection at the editor's bottom opened its card below the fold, and
  // only the greyed source showed anything had happened.
  it("scrolls the editor to show the card it opens under the selection", async () => {
    const line = (number: number) => DOC.split("\n").slice(0, number - 1).join("\n").length + 1;
    const { bridge, view } = mount(EditorSelection.single(line(38), line(40) - 1));
    const scrolled: number[] = [];
    Object.defineProperty(view.scrollDOM, "scrollTop", { get: () => 0, set: (value: number) => scrolled.push(value) });
    const box = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 600, width: 600, x: 0, y: top, toJSON: () => ({}) });
    const measured = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this === view.scrollDOM) return box(0, 400) as DOMRect;
      if (this.classList.contains("proofread-card-host")) return box(380, 500) as DOMRect;
      return measured.call(this);
    });
    act(() => {
      expect(bridge.start(view)).toBe(true);
    });
    await screen.findByRole("group", { name: "Proofread suggestion" });
    await nextFrame();
    await nextFrame();
    // The card's bottom, 500px, and a 12px margin, into a 400px editor.
    expect(scrolled.at(-1)).toBe(112);
  });
});
