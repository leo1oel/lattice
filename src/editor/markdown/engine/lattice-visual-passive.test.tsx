/**
 * The passive view of a large read-only document (spec R-PERF-1–4, R-BLK-14).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VisualMarkdownEditorProps } from "../visual-editor-props";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";

const opener = vi.hoisted(() => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => opener);

type Props = VisualMarkdownEditorProps;

const blocks = (count: number) => Array.from({ length: count }, (_, index) => `Block ${index}: ${"content ".repeat(14)}`);
const passive = () => screen.queryByRole("document", { name: "Visual Markdown editor" });

function renderEditor(given: Partial<Props>) {
  const onChange = vi.fn<Props["onChangeMarkdown"]>(() => true);
  render(<LatticeVisualMarkdownEditor text="" activePath="large.md" onChangeMarkdown={onChange} onUndo={() => true} onRedo={() => true} editable={false} {...given} />);
  return { onChange };
}

/** An IntersectionObserver under which only the first chunk is near the viewport. */
function onlyFirstChunkVisible() {
  class FirstChunkObserver {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      const isIntersecting = target.getAttribute("data-visual-chunk-id") === "chunk-0";
      queueMicrotask(() => this.callback([{ target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
    }
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  vi.stubGlobal("IntersectionObserver", FirstChunkObserver);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the passive view (R-PERF-1–4)", () => {
  it("keeps a large read-only document passive, with working links, until the complete editor is asked for", async () => {
    const onOpenProjectPath = vi.fn();
    const { onChange } = renderEditor({ text: [`[Open](other.md) ${"content ".repeat(14)}`, ...blocks(180).slice(1)].join("\n\n"), onOpenProjectPath });
    const view = passive()!;
    expect(view).toHaveAttribute("data-virtualized", "true");
    await waitFor(() => expect(view).toHaveTextContent("Open"));
    const chunks = view.querySelectorAll("[data-visual-chunk-id]").length;
    expect(chunks).toBeGreaterThan(0);
    expect(chunks).toBeLessThan(10);
    fireEvent.click(screen.getByRole("link", { name: "Open" }));
    expect(onOpenProjectPath).toHaveBeenCalledWith("other.md");
    fireEvent.click(screen.getByRole("button", { name: "Edit document" }));
    const complete = await screen.findByRole("textbox", { name: "Markdown document editor" });
    expect(complete).toHaveAttribute("contenteditable", "false");
    expect(passive()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("follows a link into the paper once the complete editor shows it", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
    renderEditor({
      text: [`[Figure 10(a)](https://arxiv.org/html/2407.06438v3#S7.F10.sf1) ${"content ".repeat(14)}`, ...blocks(179).slice(1), '<a id="S7.F10"></a>\n\nFinal figure.'].join("\n\n"),
      activePath: ".research/papers/2407.06438/paper.md",
    });
    expect(passive()).toHaveAttribute("data-virtualized", "true");
    fireEvent.click(await screen.findByRole("link", { name: "Figure 10(a)" }));
    await screen.findByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    expect(opener.openUrl).not.toHaveBeenCalled();
  });

  it("opens arXiv for a link whose target the paper does not have", async () => {
    renderEditor({ text: [`Table [8](#A0.T8) ${"content ".repeat(14)}`, ...blocks(180).slice(1)].join("\n\n"), activePath: ".research/papers/2606.11033/paper.md" });
    fireEvent.click(await screen.findByRole("link", { name: "8" }));
    await waitFor(() => expect(opener.openUrl).toHaveBeenCalledWith("https://arxiv.org/html/2606.11033#A0.T8"));
  });

  it("centers a line jump on the block that holds the line", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
    const onRevealHandled = vi.fn();
    const text = blocks(180).join("\n\n");
    const props = { text, synchronizeSourceScroll: true, onRevealHandled };
    const view = render(<LatticeVisualMarkdownEditor activePath="large.md" onChangeMarkdown={() => true} onUndo={() => true} onRedo={() => true} editable={false} {...props} />);
    await waitFor(() => expect(passive()).toHaveTextContent("Block 1:"));
    view.rerender(<LatticeVisualMarkdownEditor activePath="large.md" onChangeMarkdown={() => true} onUndo={() => true} onRedo={() => true} editable={false} {...props} revealRequest={{ id: "jump", target: { line: 4 } }} />);
    await waitFor(() => expect(onRevealHandled).toHaveBeenCalledWith("jump"));
    const centered = scrollIntoView.mock.contexts.at(-1) as HTMLElement;
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "center" });
    expect(centered).toHaveAttribute("data-source-line", "3");
    expect(centered).toHaveTextContent("Block 1:");
  });

  it("draws a far chunk a line jump lands in, then centers the line's block there", async () => {
    const observers: Array<{ target: Element; callback: IntersectionObserverCallback; observer: IntersectionObserver }> = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        observers.push({ target, callback: this.callback, observer: this as unknown as IntersectionObserver });
        if (target.getAttribute("data-visual-chunk-id") !== "chunk-0") return;
        queueMicrotask(() => this.callback([{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
      }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    });
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      for (const { target, callback, observer } of observers) {
        if (target === this) callback([{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], observer);
      }
    });
    const onRevealHandled = vi.fn();
    const props = { text: blocks(180).join("\n\n"), synchronizeSourceScroll: true, onRevealHandled };
    const view = render(<LatticeVisualMarkdownEditor activePath="large.md" onChangeMarkdown={() => true} onUndo={() => true} onRedo={() => true} editable={false} {...props} />);
    await waitFor(() => expect(passive()).toHaveTextContent("Block 1:"));
    expect(passive()).not.toHaveTextContent("Block 150:");
    // Block 150 starts on line 301.
    view.rerender(<LatticeVisualMarkdownEditor activePath="large.md" onChangeMarkdown={() => true} onUndo={() => true} onRedo={() => true} editable={false} {...props} revealRequest={{ id: "far", target: { line: 302 } }} />);
    await waitFor(() => expect(onRevealHandled).toHaveBeenCalledWith("far"));
    const centered = scrollIntoView.mock.contexts.at(-1) as HTMLElement;
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "center" });
    expect(centered).toHaveAttribute("data-source-line", "301");
    expect(centered).toHaveTextContent("Block 150:");
  });

  it("never makes an editable document passive", () => {
    renderEditor({ text: blocks(180).join("\n\n"), editable: true });
    expect(passive()).toBeNull();
    expect(screen.getByRole("textbox", { name: "Markdown document editor" })).toHaveAttribute("contenteditable", "true");
  });

  it("draws formulas at once and reads no image that is not near the viewport", async () => {
    onlyFirstChunkVisible();
    const onLoadAsset = vi.fn(async () => "data:image/png;base64,AA==");
    renderEditor({
      text: ["Inline $x^2$ before any scroll.", "$$\n\\sum_{i=1}^{n} x_i\n$$", "![Deferred](images/deferred.png)", ...blocks(180)].join("\n\n"),
      onLoadAsset,
    });
    await waitFor(() => expect(passive()!.querySelectorAll(".katex").length).toBe(2));
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(onLoadAsset).not.toHaveBeenCalled();
    // Chunks away from the viewport are not drawn.
    expect(passive()!.querySelector("[data-visual-chunk-id='chunk-24'] .lx-md-surface")).toBeNull();
  });
});

describe("generated paper Contents in the passive view (R-BLK-14)", () => {
  it("stays hidden when its heading and its list fall in different chunks", async () => {
    renderEditor({
      activePath: ".research/papers/2401.00001/paper.md",
      optimizeForReading: true,
      text: [
        ...Array.from({ length: 23 }, (_, index) => `Preface ${index}.`),
        "## Contents", "- [Introduction](#introduction)\n- [Method](#method)",
        "## Introduction", "Opening context.", "## Method",
        ...Array.from({ length: 160 }, (_, index) => `Method detail ${index}: ${"content ".repeat(18)}`),
      ].join("\n\n"),
    });
    expect(passive()).toHaveAttribute("data-virtualized", "true");
    await waitFor(() => expect(passive()!.querySelectorAll(".lx-md-generated-contents")).toHaveLength(2));
    const [heading, list] = passive()!.querySelectorAll(".lx-md-generated-contents");
    expect(heading!.closest("[data-visual-chunk-id]")).not.toBe(list!.closest("[data-visual-chunk-id]"));
    expect(document.getElementById("introduction")).not.toBeNull();
  });
});
