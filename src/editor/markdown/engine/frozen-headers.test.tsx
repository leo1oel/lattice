/**
 * Frozen table headers (spec R-CHR-9): the header row follows the scroll
 * inside its table, by a scroll timeline where there is one and by scroll
 * events otherwise, and stops moving once the table is gone.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";

type Recorded = { target: Element; frames: Keyframe[]; options: KeyframeAnimationOptions; animation: Animation & { cancelled: boolean } };

const TABLE = "| Left | Right |\n| --- | --- |\n| A | B |\n| C | D |";

function stubAnimations() {
  const recorded: Recorded[] = [];
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value(this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
      const state = { cancelled: false, currentTime: null as CSSNumberish | null, timeline: options.timeline ?? document.timeline };
      const animation = Object.assign(state, {
        cancel() { state.cancelled = true; },
        pause() {},
      }) as unknown as Animation & { cancelled: boolean };
      recorded.push({ target: this, frames, options, animation });
      return animation;
    },
  });
  return recorded;
}

/** The editor inside a scrolling pane, with a laid-out table 400px down a 2000px document. */
function mountInScroller(text: string) {
  const view = render(
    <div className="editor-doc-scroll" style={{ overflowY: "auto" }}>
      <LatticeVisualMarkdownEditor text={text} activePath="notes.md" onChangeMarkdown={() => true} onUndo={() => true} onRedo={() => true} />
    </div>,
  );
  const scroller = view.container.querySelector<HTMLElement>(".editor-doc-scroll")!;
  Object.defineProperties(scroller, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 500, configurable: true } });
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 500));
  const layout = () => {
    const table = scroller.querySelector("table");
    if (!table) return;
    vi.spyOn(table, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 400 - scroller.scrollTop, 600, 400));
    for (const row of table.rows) vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 40));
  };
  layout();
  return { ...view, scroller, layout, editor: (screen.getByRole("textbox") as HTMLElement & { editor: Editor }).editor };
}

const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(Element.prototype, "animate");
  Reflect.deleteProperty(globalThis, "ScrollTimeline");
});

describe("frozen table headers (R-CHR-9)", () => {
  it("drives the header cells from a scroll timeline, pinned from the table's top to its last row", async () => {
    class ScrollTimeline {
      constructor(readonly options: unknown) {}
    }
    Object.defineProperty(globalThis, "ScrollTimeline", { configurable: true, value: ScrollTimeline });
    const recorded = stubAnimations();
    mountInScroller(TABLE);
    await frame();
    const headers = recorded.filter((entry) => entry.target.tagName === "TH");
    expect(headers.map((entry) => entry.target.textContent)).toEqual(["Left", "Right"]);
    for (const { frames, options } of headers) {
      expect(options.timeline).toBeInstanceOf(ScrollTimeline);
      // 1500px of scroll: pinned from 400px, and moved at most 400 - 40 - 40 = 320px.
      expect(frames.map((keyframe) => [keyframe.offset, keyframe.transform])).toEqual([
        [0, "translateY(0px)"], [400 / 1500, "translateY(0px)"], [720 / 1500, "translateY(320px)"], [1, "translateY(320px)"],
      ]);
    }
  });

  it("follows scroll events where there is no scroll timeline", async () => {
    const recorded = stubAnimations();
    const { scroller } = mountInScroller(TABLE);
    await frame();
    const header = recorded.find((entry) => entry.target.tagName === "TH")!;
    scroller.scrollTop = 750;
    scroller.dispatchEvent(new Event("scroll"));
    expect(header.animation.currentTime).toBe(500);
  });

  it("stops the animations of a table the document no longer has", async () => {
    const recorded = stubAnimations();
    const { rerender } = mountInScroller(TABLE);
    await frame();
    const first = recorded.filter((entry) => entry.target.tagName === "TH");
    expect(first).toHaveLength(2);
    rerender(
      <div className="editor-doc-scroll" style={{ overflowY: "auto" }}>
        <LatticeVisualMarkdownEditor text="No table any more." activePath="notes.md" onChangeMarkdown={() => true} onUndo={() => true} onRedo={() => true} />
      </div>,
    );
    await act(() => Promise.resolve());
    await frame();
    for (const { animation } of first) expect(animation.cancelled).toBe(true);
  });
});
