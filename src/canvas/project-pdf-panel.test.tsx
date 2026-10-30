import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { FileViewState } from "../app-types";
import { AnnotationRounds } from "../app/annotation-rounds";
import { createEditorComment } from "../editor/comments/editor-comment-data";
import type { PdfPreview as RealPdfPreview } from "../pdf/pdf-viewer";
import { ProjectPdfPanel } from "./project-pdf-panel";

/**
 * The panel decides what the compiled PDF is handed and where it renders; the
 * viewer has its own suite. The stub reports what the panel wires as DOM
 * attributes and offers each callback as a button, and keeps pdf.js out of jsdom.
 */
vi.mock("./canvas-lazy-modules", async () => {
  const { chunk } = await import("../lib/lazy-chunk");
  const PdfPreview = (props: ComponentProps<typeof RealPdfPreview>) => (
    <div
      data-testid="pdf-preview"
      data-url={props.url ?? ""}
      data-building={String(Boolean(props.building))}
      data-annotations={String(props.annotations?.length ?? 0)}
      data-restored-page={String(props.initialViewState?.page ?? "")}
    >
      <button data-testid="pdf-view-state" onClick={() => props.onViewState?.({ page: 7, scale: 1, fitMode: null, scrollTop: 0, scrollLeft: 0 })} />
      <button data-testid="pdf-read" onClick={() => { props.onNumPages?.(22); props.onPageChange?.(7); }} />
      <button data-testid="pdf-select" onClick={() => props.onTextSelect?.("Selected passage")} />
      <button data-testid="pdf-source" onClick={() => props.onSource?.(4, 120, 300, null)} />
      <button data-testid="pdf-forward" onClick={() => props.onForwardSync?.()} />
      <button data-testid="pdf-cite" onClick={() => { if (props.canOpenCitation?.("lee2026")) props.onOpenCitation?.("lee2026"); }} />
      {props.outline}
    </div>
  );
  const missing = chunk(async () => { throw new Error("not under test"); });
  return {
    loadPdfPreviewModule: chunk(async () => ({ PdfPreview })),
    loadVisualMarkdownEditorModule: missing,
    loadBoardEditorModule: missing,
    loadSpreadsheetEditorModule: missing,
    loadOpenSlideWorkspaceModule: missing,
    loadBibVisualEditorModule: missing,
    isVisualMarkdownEditorWarmed: () => true,
    markVisualMarkdownEditorWarmed: () => {},
  };
});

type PanelProps = ComponentProps<typeof ProjectPdfPanel>;
type PanelOverrides = Partial<Omit<PanelProps, "pdf">> & { pdf?: Partial<PanelProps["pdf"]> };

/** The PDF panel's Trellis host: App hands the element Trellis adopted; here a plain div in the body. */
let pdfHost: HTMLElement;

const pdfViewState = (page: number) => ({ page, scale: 1, fitMode: null, scrollTop: 0, scrollLeft: 0 });

/** A view-state store over `states` that records every update filed into it. */
function viewStates(states: Record<string, FileViewState>) {
  const updates: { path: string; update: Partial<FileViewState> }[] = [];
  return {
    updates,
    getFileViewState: (path: string) => states[path],
    onFileViewState: (path: string, update: Partial<FileViewState>) => void updates.push({ path, update }),
  };
}

/** Every callback is a spy; the ones that must answer something answer it. */
function baseProps(): PanelProps {
  return {
    host: pdfHost,
    projectRoot: "/tmp/project",
    activeFile: "main.tex",
    pdf: {
      pdfUrl: "blob:project.pdf", pdfSyncTarget: null, canForwardSync: true, locatingPdf: false,
      onForwardSync: vi.fn(), onPdfSource: vi.fn(), onPdfPageCount: vi.fn(), onPdfPageChange: vi.fn(),
    },
    citations: { citations: [], canOpenCitation: () => true, onOpenCitation: vi.fn() },
    outline: { nodes: [], activeId: null, open: false, onOpenChange: vi.fn(), onNavigate: vi.fn() },
    review: { annotations: [], annotationRounds: new AnnotationRounds() },
    selection: { onPdfTextSelect: vi.fn(), onContextSurfaceActivate: vi.fn() },
    viewState: {},
    onLeaveEditor: vi.fn(),
  };
}

function renderPanel(overrides: PanelOverrides = {}) {
  const base = baseProps();
  const props: PanelProps = { ...base, ...overrides, pdf: { ...base.pdf, ...overrides.pdf } };
  const view = render(<ProjectPdfPanel {...props} />);
  return {
    ...view,
    props,
    rerenderWith: (next: PanelOverrides) => view.rerender(
      <ProjectPdfPanel {...props} {...next} pdf={{ ...props.pdf, ...next.pdf }} />,
    ),
  };
}

beforeEach(() => {
  pdfHost = document.body.appendChild(document.createElement("div"));
});

afterEach(() => {
  cleanup();
  pdfHost.remove();
});

describe("ProjectPdfPanel", () => {
  it("renders the compiled PDF into its panel's host, and nothing while that panel has none", async () => {
    const { rerenderWith } = renderPanel();
    expect(await within(pdfHost).findByTestId("pdf-preview")).toHaveAttribute("data-url", "blob:project.pdf");

    rerenderWith({ host: null });
    expect(screen.queryByTestId("pdf-preview")).toBeNull();
  });

  it("shows the build's diagnostics above the PDF", async () => {
    renderPanel({ pdf: { pdfTop: <div data-testid="diagnostics" /> } });
    const preview = await within(pdfHost).findByTestId("pdf-preview");
    const diagnostics = within(pdfHost).getByTestId("diagnostics");
    expect(diagnostics.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reopens on the page it was left at once its panel wakes", async () => {
    const states: Record<string, FileViewState> = { "main.tex": { pdf: pdfViewState(3) } };
    const { rerenderWith } = renderPanel({ viewState: { getFileViewState: (path) => states[path] } });
    expect((await within(pdfHost).findByTestId("pdf-preview")).dataset.restoredPage).toBe("3");

    states["main.tex"] = { pdf: pdfViewState(12) };
    rerenderWith({ host: null });
    expect(within(pdfHost).queryByTestId("pdf-preview")).toBeNull();
    rerenderWith({ host: pdfHost });
    expect((await within(pdfHost).findByTestId("pdf-preview")).dataset.restoredPage).toBe("12");
  });

  it("keeps the compiled PDF mounted when source navigation changes TeX files", async () => {
    const state = viewStates({
      "main.tex": { pdf: pdfViewState(3) },
      "chapters/results.tex": { pdf: pdfViewState(1) },
    });
    const { rerenderWith } = renderPanel({ viewState: state });
    const preview = await within(pdfHost).findByTestId("pdf-preview");
    preview.scrollTop = 2450;

    // SyncTeX can resolve into a different included file. The PDF is still
    // the same build, even when that file has a different saved PDF position.
    for (const activeFile of ["chapters/results.tex", "refs.bib", "main.tex"]) {
      rerenderWith({ activeFile });
      expect(await within(pdfHost).findByTestId("pdf-preview")).toBe(preview);
      expect(preview.scrollTop).toBe(2450);
    }

    // A different project must not inherit this viewer instance.
    rerenderWith({ projectRoot: "/tmp/other-project" });
    expect(await within(pdfHost).findByTestId("pdf-preview")).not.toBe(preview);
  });

  it("restores each document's own place, files updates back under it, and keeps it for files without a preview", async () => {
    const state = viewStates({ "main.tex": { pdf: pdfViewState(3) }, "refs.bib": { pdf: pdfViewState(9) } });
    const { rerenderWith } = renderPanel({ viewState: state });
    expect((await screen.findByTestId("pdf-preview")).dataset.restoredPage).toBe("3");
    fireEvent.click(screen.getByTestId("pdf-view-state"));
    expect(state.updates).toEqual([{ path: "main.tex", update: { pdf: pdfViewState(7) } }]);

    // Opening a .bib from a citation, or a .sty from a macro, must not throw
    // away the reader's page in the compiled PDF: those files have no preview
    // of their own, so the panel keeps the document it was showing, across a
    // sleep of its panel too.
    rerenderWith({ activeFile: "refs.bib" });
    expect(screen.getByTestId("pdf-preview").dataset.restoredPage).toBe("3");
    fireEvent.click(screen.getByTestId("pdf-view-state"));
    rerenderWith({ activeFile: "refs.bib", host: null });
    rerenderWith({ activeFile: "refs.bib", host: pdfHost });
    fireEvent.click(await screen.findByTestId("pdf-view-state"));
    expect(state.updates.every((update) => update.path === "main.tex")).toBe(true);
    expect(state.updates).toHaveLength(3);
  });

  it("offers the outline only for a TeX document", async () => {
    const { rerenderWith } = renderPanel({
      outline: { nodes: [], activeId: null, open: false, onOpenChange: vi.fn(), onNavigate: vi.fn() },
    });
    expect(await within(pdfHost).findByRole("button", { name: "Show document outline" })).toBeInTheDocument();

    rerenderWith({ activeFile: "notes.md" });
    expect(within(pdfHost).queryByRole("button", { name: "Show document outline" })).toBeNull();
  });

  it("wires the build, SyncTeX both ways, its pages, citations and annotations through to the viewer", async () => {
    const annotation = createEditorComment({ path: "main.tex", source: "Hello world", from: 0, to: 5, body: "Note", authorId: "ada", authorName: "Ada" })!;
    const { props } = renderPanel({ pdf: { building: true }, review: { annotations: [annotation], annotationRounds: new AnnotationRounds() } });
    const preview = await within(pdfHost).findByTestId("pdf-preview");
    expect(preview).toHaveAttribute("data-building", "true");
    expect(preview).toHaveAttribute("data-annotations", "1");

    fireEvent.click(within(preview).getByTestId("pdf-source"));
    expect(props.pdf.onPdfSource).toHaveBeenCalledWith(4, 120, 300, null);
    fireEvent.click(within(preview).getByTestId("pdf-forward"));
    expect(props.pdf.onForwardSync).toHaveBeenCalledOnce();
    fireEvent.click(within(preview).getByTestId("pdf-read"));
    expect(props.pdf.onPdfPageCount).toHaveBeenCalledWith(22);
    expect(props.pdf.onPdfPageChange).toHaveBeenCalledWith(7);
    fireEvent.click(within(preview).getByTestId("pdf-cite"));
    expect(props.citations.onOpenCitation).toHaveBeenCalledWith("lee2026");
  });

  // The compiled preview's selection reaches the Agent without a place: only a
  // project PDF open as a document is named (see DocumentCanvas).
  it("offers its selection to the Agent and, turned to, leaves the editor; a scroll only leaves it", async () => {
    const { props } = renderPanel();
    const preview = await within(pdfHost).findByTestId("pdf-preview");
    fireEvent.click(within(preview).getByTestId("pdf-select"));
    expect(props.selection.onPdfTextSelect).toHaveBeenCalledWith("Selected passage");

    fireEvent.wheel(preview);
    expect(props.onLeaveEditor).toHaveBeenCalledOnce();
    expect(props.selection.onContextSurfaceActivate).not.toHaveBeenCalled();

    fireEvent.pointerDown(preview);
    expect(props.selection.onContextSurfaceActivate).toHaveBeenCalledWith("pdf");
    expect(props.onLeaveEditor).toHaveBeenCalledTimes(2);
  });
});
