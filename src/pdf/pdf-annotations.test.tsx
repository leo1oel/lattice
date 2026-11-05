import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnnotationRounds } from "../app/annotation-rounds";
import { createEditorComment } from "../editor/comments/editor-comment-data";
import PdfAnnotationLayer from "./pdf-annotations";
import type { PdfRenderCount } from "./use-pdf-document";
import type { ActiveViewerRef } from "./use-pdf-view";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("./pdf-slick", () => ({
  pdfPageView: (_slick: unknown, page: number) => ({
    viewport: { width: 600, height: 800, scale: 1 },
    div: document.querySelector(`[data-page-number="${page}"]`),
  }),
}));
vi.mock("./pdf-text-layer-selection", async (original) => ({
  ...await original<typeof import("./pdf-text-layer-selection")>(),
  pdfSelectedPlainTextWithin: () => "attention weights",
}));

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.mocked(invoke).mockReset();
});

const renderCount: PdfRenderCount = { subscribe: () => () => {}, pages: () => 1, textLayers: () => 1 };

/** A page of the PDF with a word selected on it, the way its text layer draws the selection. */
function selectedPage() {
  const root = document.createElement("div");
  root.innerHTML = `<div data-page-number="1"><div class="textLayer">
    <div class="pdf-sel-rect" style="left: 10%; top: 20%; width: 15%; height: 2%"></div>
  </div></div>`;
  document.body.append(root);
  return root;
}

describe("the PDF's Annotate offer", () => {
  // A double-click jumps to the source with SyncTeX and selects the word; the
  // offer stood over the PDF through typing, builds and History until a press
  // inside the PDF.
  it("goes away once the writer works anywhere else, and stays for the PDF's own copy field", async () => {
    const root = selectedPage();
    const preview = document.createElement("div");
    document.body.append(preview);
    const recordRef = { current: { root, slick: {} } } as unknown as ActiveViewerRef;
    const previewRef = createRef<HTMLDivElement>() as { current: HTMLDivElement | null };
    previewRef.current = preview;
    const rounds = { canAnnotatePdf: () => true } as unknown as AnnotationRounds;
    render(
      <PdfAnnotationLayer
        recordRef={recordRef} previewRef={previewRef} rounds={rounds} annotations={[]}
        generation={1} renderCount={renderCount} scale={1}
      />,
    );
    await screen.findByRole("button", { name: "Annotate" });

    // WebKit parks a finished drag's text in a hidden field, which takes focus.
    const copyField = document.createElement("textarea");
    copyField.className = "pdf-copy-field";
    document.body.append(copyField);
    act(() => copyField.focus());
    expect(screen.getByRole("button", { name: "Annotate" })).toBeTruthy();

    const source = document.createElement("textarea");
    document.body.append(source);
    act(() => source.focus());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Annotate" })).toBeNull());
  });
});

const SOURCE = [
  "\\section{Attention}",
  "Scaled dot-product attention divides the scores",
  "by a constant before the softmax.",
].join("\n");

/** A one-page PDF reading SOURCE's prose, its text as PDF.js gives it. */
function compiledPage() {
  const root = document.createElement("div");
  root.innerHTML = `<div data-page-number="1"></div>`;
  document.body.append(root);
  const items = [
    { str: "Scaled dot-product attention divides the scores by", transform: [10, 0, 0, 10, 72, 700], width: 250, height: 10 },
    { str: "a constant before the softmax.", transform: [10, 0, 0, 10, 72, 688], width: 150, height: 10 },
  ];
  const getPage = vi.fn(async () => ({ view: [0, 0, 612, 792], getTextContent: async () => ({ items }) }));
  return { root, slick: { document: { numPages: 1, getPage } } };
}

describe("annotations made in the source, on the PDF", () => {
  it("draws a .tex note on the line SyncTeX puts it, numbered as in the source, and opens its card from the PDF", async () => {
    const from = SOURCE.indexOf("divides the scores");
    const sourceNote = createEditorComment({
      path: "main.tex", source: SOURCE, from, to: from + "divides the scores".length, number: 4, body: "Say by what.", authorId: "me", authorName: "Ada",
    })!;
    vi.mocked(invoke).mockImplementation(async (command, args) => (
      command === "synctex_view" && (args as { line: number }).line === 2 ? { page: 1, x: 72, y: 84, width: 400, height: 10 } : null
    ));
    const record = compiledPage();
    const openById = vi.fn();
    const rounds = {
      canAnnotatePdf: () => false,
      readSource: async () => SOURCE,
      author: () => ({ id: "me", name: "Ada" }),
      resolve: vi.fn(),
      reply: vi.fn(),
      openById,
    } as unknown as AnnotationRounds;
    render(
      <PdfAnnotationLayer
        recordRef={{ current: record } as unknown as ActiveViewerRef} previewRef={createRef()} rounds={rounds}
        annotations={[sourceNote]} generation={1} renderCount={renderCount} scale={1}
      />,
    );

    const pin = await screen.findByRole("button", { name: "Annotation 4" });
    expect(invoke).toHaveBeenCalledWith("synctex_view", { path: "main.tex", line: 2, column: 30 });
    const highlight = record.root.querySelector<HTMLElement>(`[data-annotation-id="${sourceNote.id}"] .pdf-annotation-highlight`)!;
    // Over "divides the scores", 29 characters into the first line's run.
    expect(Number.parseFloat(highlight.style.left)).toBeGreaterThan(72 / 612 * 100 + 15);
    expect(Number.parseFloat(highlight.style.top)).toBeCloseTo((792 - 700 - 7.8) / 792 * 100, 0);

    fireEvent.click(pin);
    // The card stands hidden until it is measured beside its passage, which jsdom never lays out.
    fireEvent.click(await screen.findByText("Show in the source"));
    expect(openById).toHaveBeenCalledWith(sourceNote.id);
  });

  it("draws no mark for a .tex note SyncTeX cannot place, and never waits on it to draw a PDF note", async () => {
    const lost = createEditorComment({ path: "main.tex", source: SOURCE, from: 0, to: 18, number: 1, body: "Rename", authorId: "me", authorName: "Ada" })!;
    const onPdf = createEditorComment({
      path: "main.tex", source: SOURCE, from: SOURCE.indexOf("a constant"), to: SOURCE.indexOf(" before"), number: 2, body: "Which?", authorId: "me", authorName: "Ada",
      pdf: { page: 1, rects: [{ x: 0.1176, y: 0.12, width: 0.1, height: 0.013 }], text: "a constant" },
    })!;
    let answer: (box: null) => void = () => {};
    vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const record = compiledPage();
    const rounds = { canAnnotatePdf: () => false, readSource: async () => SOURCE } as unknown as AnnotationRounds;
    render(
      <PdfAnnotationLayer
        recordRef={{ current: record } as unknown as ActiveViewerRef} previewRef={createRef()} rounds={rounds}
        annotations={[lost, onPdf]} generation={1} renderCount={renderCount} scale={1}
      />,
    );
    await screen.findByRole("button", { name: "Annotation 2" });
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await act(async () => answer(null));
    expect(screen.queryByRole("button", { name: "Annotation 1" })).toBeNull();
  });
});
