import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnnotationRounds } from "../app/annotation-rounds";
import { createEditorComment, type EditorComment } from "../editor/comments/editor-comment-data";
import PdfAnnotationLayer from "./pdf-annotations";
import type { PdfRenderCount } from "./use-pdf-document";
import type { ActiveViewerRef } from "./use-pdf-view";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("./pdf-slick", () => ({
  pdfPageView: (_slick: unknown, page: number) => ({
    viewport: { width: 612, height: 792, scale: 1 },
    div: document.querySelector(`[data-page-number="${page}"]`),
  }),
}));

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.mocked(invoke).mockReset();
});

const renderCount: PdfRenderCount = { subscribe: () => () => {}, pages: () => 1, textLayers: () => 1 };

const SOURCE = [
  "\\section{Attention}",
  "Scaled dot-product attention divides the scores",
  "by a constant before the softmax.",
].join("\n");

/** A one-page PDF whose text reads SOURCE's prose, as PDF.js gives it. */
function compiledDocument() {
  const items = [
    { str: "Scaled dot-product attention divides the scores by", transform: [10, 0, 0, 10, 72, 700], width: 250, height: 10 },
    { str: "a constant before the softmax.", transform: [10, 0, 0, 10, 72, 688], width: 150, height: 10 },
  ];
  return { numPages: 1, getPage: vi.fn(async () => ({ view: [0, 0, 612, 792], getTextContent: async () => ({ items }) })) };
}

/**
 * The PDF preview as the viewer lays it out: the scroll area `width` wide
 * holding the pages' scroller, its one page 792px tall from the scroller's top.
 */
function preview(width: number) {
  const element = document.createElement("div");
  element.className = "pdf-preview";
  element.innerHTML = `<div class="pdf-scroll-area"><div class="pdf-viewer-host"><div class="pdf-pages"><div data-page-number="1"></div></div></div></div>`;
  document.body.append(element);
  const area = element.querySelector<HTMLElement>(".pdf-scroll-area")!;
  Object.defineProperty(area, "clientWidth", { configurable: true, get: () => width });
  const root = element.querySelector<HTMLElement>(".pdf-pages")!;
  const page = element.querySelector<HTMLElement>("[data-page-number]")!;
  page.getBoundingClientRect = () => ({ top: -root.scrollTop, bottom: 792 - root.scrollTop, left: 0, right: 612, width: 612, height: 792 }) as DOMRect;
  const previewRef = createRef<HTMLDivElement>() as { current: HTMLDivElement | null };
  previewRef.current = element;
  const recordRef = { current: { root, slick: { document: compiledDocument() } } } as unknown as ActiveViewerRef;
  return { area, root, previewRef, recordRef };
}

/** A note made on the PDF over a line at `y` (a fraction of the page). */
function pdfNote(number: number, y: number, body: string, quote = "Scaled dot-product") {
  const from = SOURCE.indexOf(quote);
  return createEditorComment({
    path: "main.tex", source: SOURCE, from, to: from + quote.length, number, body, authorId: "me", authorName: "Ada",
    pdf: { page: 1, rects: [{ x: 0.12, y, width: 0.3, height: 0.02 }], text: quote },
  })!;
}

function roundsDouble() {
  return {
    canAnnotatePdf: () => false,
    readSource: async () => SOURCE,
    author: () => ({ id: "me", name: "Ada" }),
    resolve: vi.fn(),
    reply: vi.fn(),
    open: vi.fn(),
  };
}

function renderLayer(
  pdf: ReturnType<typeof preview>, rounds: ReturnType<typeof roundsDouble>, annotations: EditorComment[], count = renderCount,
) {
  const layer = (list: EditorComment[]) => (
    <PdfAnnotationLayer
      recordRef={pdf.recordRef} previewRef={pdf.previewRef} rounds={rounds as unknown as AnnotationRounds}
      annotations={list} generation={1} renderCount={count} scale={1}
    />
  );
  const view = render(layer(annotations));
  return { rerender: (list: EditorComment[]) => view.rerender(layer(list)) };
}

const column = () => screen.getByRole("complementary", { name: "Comments" });
const slotOf = (id: string) => column().querySelector<HTMLElement>(`.pdf-comment-slot[data-comment-id="${id}"]`);

describe("the PDF's comment column", () => {
  it("stands each comment's card level with its numbered mark, and follows the pages as they scroll", async () => {
    const pdf = preview(900);
    const lower = pdfNote(2, 0.5, "Cite the paper.", "a constant");
    const upper = pdfNote(1, 0.1, "Say by what.");
    renderLayer(pdf, roundsDouble(), [lower, upper]);

    await screen.findByRole("button", { name: "Annotation 2" });
    await waitFor(() => expect(slotOf(upper.id)).toBeTruthy());
    // Docked beside the pages, which give it their width.
    expect(pdf.area.hasAttribute("data-comment-column")).toBe(true);
    // Down the column in the order of their marks down the page.
    expect([...column().querySelectorAll<HTMLElement>(".pdf-comment-slot")].map((slot) => slot.dataset.commentId)).toEqual([upper.id, lower.id]);
    for (const note of [upper, lower]) {
      const pin = pdf.root.querySelector<HTMLElement>(`[data-annotation-id="${note.id}"] .pdf-annotation-pin`)!;
      const pinTop = Number.parseFloat(pin.style.top) / 100 * 792;
      expect(Number.parseFloat(slotOf(note.id)!.style.top)).toBeCloseTo(pinTop, 3);
    }

    const track = column().querySelector<HTMLElement>(".pdf-comment-column-track")!;
    pdf.root.scrollTop = 240;
    fireEvent.scroll(pdf.root);
    expect(track.style.transform).toBe("translateY(-240px)");
  });

  it("opens a comment's card in the column from its pin, and answers, resolves and shows the source from there", async () => {
    const pdf = preview(900);
    const note = pdfNote(1, 0.1, "Say by what.");
    const rounds = roundsDouble();
    const { rerender } = renderLayer(pdf, rounds, [note]);

    fireEvent.click(await screen.findByRole("button", { name: "Annotation 1" }));
    // The card opens in the column, not over the page.
    const card = await within(column()).findByRole("dialog", { name: "Comment" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(pdf.root.querySelector(`[data-annotation-id="${note.id}"]`)?.hasAttribute("data-active")).toBe(true);

    fireEvent.click(within(card).getByRole("button", { name: "Reply…" }));
    fireEvent.change(within(card).getByRole("textbox", { name: "Reply" }), { target: { value: "By the square root of d." } });
    fireEvent.keyDown(within(card).getByRole("textbox", { name: "Reply" }), { key: "Enter" });
    expect(rounds.reply).toHaveBeenCalledWith(note.id, "By the square root of d.");

    fireEvent.click(within(card).getByRole("button", { name: "Show in the source" }));
    expect(rounds.open).toHaveBeenCalledWith(note, true);

    fireEvent.click(within(card).getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(rounds.resolve).toHaveBeenCalledWith(note.id));
    rerender([{ ...note, resolved: true }]);
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Comments" })).toBeNull());
    expect(pdf.root.querySelector(`[data-annotation-id="${note.id}"]`)).toBeNull();
  });

  it("shows what the source side writes: a reply, a new note and a resolve", async () => {
    const pdf = preview(900);
    const note = pdfNote(1, 0.1, "Say by what.");
    const { rerender } = renderLayer(pdf, roundsDouble(), [note]);
    await waitFor(() => expect(slotOf(note.id)).toBeTruthy());

    const replied = { ...note, replies: [{ id: "r1", authorId: "you", authorName: "Grace", body: "Fixed in the source.", createdAt: new Date().toISOString() }] };
    const added = pdfNote(2, 0.5, "Cite the paper.", "a constant");
    rerender([replied, added]);
    expect(await within(column()).findByText("Fixed in the source.")).toBeTruthy();
    await waitFor(() => expect(slotOf(added.id)).toBeTruthy());
    expect(within(column()).getByText("Cite the paper.")).toBeTruthy();

    rerender([{ ...replied, resolved: true }, added]);
    await waitFor(() => expect(slotOf(note.id)).toBeNull());
    expect(slotOf(added.id)).toBeTruthy();
  });

  it("folds away on a narrow PDF and opens over the pages when asked for", async () => {
    const pdf = preview(480);
    const note = pdfNote(1, 0.1, "Say by what.");
    renderLayer(pdf, roundsDouble(), [note]);

    fireEvent.click(await screen.findByRole("button", { name: "Show comments" }));
    await waitFor(() => expect(slotOf(note.id)).toBeTruthy());
    // Over the pages: they keep their width.
    expect(pdf.area.hasAttribute("data-comment-column")).toBe(false);

    fireEvent.click(within(column()).getByRole("button", { name: "Hide comments" }));
    expect(screen.queryByRole("complementary", { name: "Comments" })).toBeNull();
    // Folded, a pin opens the card over its passage again.
    fireEvent.click(screen.getByRole("button", { name: "Annotation 1" }));
    // It stands hidden until measured beside its passage, which jsdom never lays out.
    expect(await screen.findByText("Show in the source")).toBeTruthy();
  });

  it("hides the open card with the column, rather than opening it over the page", async () => {
    const pdf = preview(900);
    const note = pdfNote(1, 0.1, "Say by what.");
    renderLayer(pdf, roundsDouble(), [note]);

    fireEvent.click(await screen.findByRole("button", { name: "Annotation 1" }));
    await within(column()).findByRole("dialog", { name: "Comment" });
    fireEvent.click(within(column()).getByRole("button", { name: "Hide comments" }));
    expect(screen.queryByRole("complementary", { name: "Comments" })).toBeNull();
    expect(screen.queryByText("Show in the source")).toBeNull();
    expect(pdf.area.hasAttribute("data-comment-column")).toBe(false);
  });

  it("counts and docks for only the comments drawn on the pages", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const quote = "by a constant";
    const from = SOURCE.indexOf(quote);
    // SyncTeX finds no place for it in the PDF, as for a file the build never reads.
    const unplaced = createEditorComment({
      path: "main.tex", source: SOURCE, from, to: from + quote.length, number: 2, body: "Which constant?", authorId: "me", authorName: "Ada",
    })!;
    const unplacedOnly = preview(900);
    renderLayer(unplacedOnly, roundsDouble(), [unplaced]);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("synctex_view", expect.anything()));
    await act(async () => {});
    expect(screen.queryByRole("complementary", { name: "Comments" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show comments" })).toBeNull();
    expect(unplacedOnly.area.hasAttribute("data-comment-column")).toBe(false);
    cleanup();
    document.body.replaceChildren();

    const pdf = preview(480);
    const note = pdfNote(1, 0.1, "Say by what.");
    renderLayer(pdf, roundsDouble(), [note, unplaced]);
    const toggle = await screen.findByRole("button", { name: "Show comments" });
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(1));
    await act(async () => {});
    expect(toggle.textContent).toBe("1");
    fireEvent.click(toggle);
    expect(column().querySelector(".pdf-comment-column-count")?.textContent).toBe("1");
  });

  it("stays docked through a rebuild that places its source comments again", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => (
      command === "synctex_view" ? { page: 1, x: 72, y: 84, width: 400, height: 10 } : null
    ));
    const quote = "divides the scores";
    const from = SOURCE.indexOf(quote);
    const note = createEditorComment({
      path: "main.tex", source: SOURCE, from, to: from + quote.length, number: 1, body: "Why?", authorId: "me", authorName: "Ada",
    })!;
    let pages = 1;
    const listeners = new Set<() => void>();
    const count: PdfRenderCount = {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      pages: () => pages,
      textLayers: () => 1,
    };
    const pdf = preview(900);
    renderLayer(pdf, roundsDouble(), [note], count);
    await waitFor(() => expect(slotOf(note.id)).toBeTruthy());
    expect(pdf.area.hasAttribute("data-comment-column")).toBe(true);

    const changes: MutationRecord[] = [];
    const watch = new MutationObserver((records) => changes.push(...records));
    watch.observe(pdf.area, { attributes: true, attributeFilter: ["data-comment-column"] });
    const lookups = vi.mocked(invoke).mock.calls.length;
    // A rebuild swaps a new document into the open viewer and redraws its pages (pdf-page-swap.ts).
    (pdf.recordRef.current!.slick as { document: unknown }).document = compiledDocument();
    act(() => {
      pages += 1;
      for (const listener of listeners) listener();
    });
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(lookups));
    await act(async () => {});
    changes.push(...watch.takeRecords());
    watch.disconnect();
    expect(changes).toEqual([]);
    expect(pdf.area.hasAttribute("data-comment-column")).toBe(true);
    expect(slotOf(note.id)).toBeTruthy();
  });

  it("holds an Overleaf thread on a .tex file beside its passage, its pin a dot", async () => {
    const quote = "divides the scores";
    const from = SOURCE.indexOf(quote);
    const thread: EditorComment = {
      id: "overleaf:t1", number: 0, path: "main.tex", from, to: from + quote.length, quote, prefix: "", suffix: "",
      body: "Is this the right word?", resolved: false, replies: [], authorId: "grace@example.com", authorName: "Grace (Overleaf)",
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    vi.mocked(invoke).mockImplementation(async (command) => (
      command === "synctex_view" ? { page: 1, x: 72, y: 84, width: 400, height: 10 } : null
    ));
    const pdf = preview(900);
    const rounds = roundsDouble();
    renderLayer(pdf, rounds, [thread]);

    const pin = await screen.findByRole("button", { name: "Comment by Grace (Overleaf)" });
    expect(pin.dataset.kind).toBe("thread");
    expect(pin.textContent).toBe("");
    await waitFor(() => expect(slotOf(thread.id)).toBeTruthy());
    fireEvent.click(within(column()).getByText("Is this the right word?"));
    fireEvent.click(await within(column()).findByRole("button", { name: "Show in the source" }));
    expect(rounds.open).toHaveBeenCalledWith(thread, true);
  });

  it("opens a card from the keyboard with focus inside it", async () => {
    const pdf = preview(900);
    const note = pdfNote(1, 0.1, "Say by what.");
    renderLayer(pdf, roundsDouble(), [note]);
    await waitFor(() => expect(slotOf(note.id)).toBeTruthy());
    const card = within(slotOf(note.id)!).getByRole("button");
    act(() => card.focus());
    fireEvent.keyDown(card, { key: "Enter" });
    const opened = await within(column()).findByRole("dialog", { name: "Comment" });
    await waitFor(() => expect(opened.contains(document.activeElement)).toBe(true));

    // Esc in the card, or anywhere else, gives focus back to the card's preview in the column.
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(within(column()).queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(slotOf(note.id)!.querySelector(".pdf-comment-slot-preview"));

    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await within(column()).findByRole("dialog", { name: "Comment" });
    act(() => (document.activeElement as HTMLElement).blur());
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(within(column()).queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(slotOf(note.id)!.querySelector(".pdf-comment-slot-preview"));
  });
});
