import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnnotationRounds } from "../app/annotation-rounds";
import PdfAnnotationLayer from "./pdf-annotations";
import type { PdfRenderCount } from "./use-pdf-document";
import type { ActiveViewerRef } from "./use-pdf-view";

vi.mock("./pdf-slick", () => ({ pdfPageView: () => ({ viewport: { width: 600, height: 800, scale: 1 } }) }));
vi.mock("./pdf-text-layer-selection", async (original) => ({
  ...await original<typeof import("./pdf-text-layer-selection")>(),
  pdfSelectedPlainTextWithin: () => "attention weights",
}));

afterEach(cleanup);

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
