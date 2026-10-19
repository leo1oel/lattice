import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PdfPageLayerProps } from "../pdf/pdf-viewer";
import { LivePreviewSessionContext } from "./live-preview-context";
import { LivePreviewLayer } from "./live-preview-layer";
import type { LivePreviewSession } from "./live-preview-session";

vi.mock("../pdf/pdfjs-runtime", () => ({ getDocument: vi.fn() }));
vi.mock("../pdf/pdf-slick", () => ({ pdfPageView: vi.fn() }));
afterEach(cleanup);

describe("the live preview layer", () => {
  it("tells the session a rebuild is on screen when its pages were swapped into the open viewer", () => {
    const basePromoted = vi.fn();
    const session = { basePromoted, subscribePages: () => () => {} } as unknown as LivePreviewSession;
    const record = { bytes: new ArrayBuffer(1), slick: { viewer: { pagesCount: 0 } } };
    const recordRef = { current: record } as unknown as PdfPageLayerProps["recordRef"];
    const listeners = new Set<() => void>();
    const renderCount = {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as PdfPageLayerProps["renderCount"];
    const rendered = () => { for (const listener of listeners) listener(); };
    render(
      <LivePreviewSessionContext value={session}>
        <LivePreviewLayer recordRef={recordRef} generation={1} renderCount={renderCount} />
      </LivePreviewSessionContext>,
    );
    // The viewer it mounted with.
    expect(basePromoted).toHaveBeenCalledTimes(1);
    // A page drawn again of the same document is not a new build.
    rendered();
    expect(basePromoted).toHaveBeenCalledTimes(1);
    // The same viewer, now holding the next build's bytes (pdf-page-swap.ts).
    record.bytes = new ArrayBuffer(2);
    rendered();
    expect(basePromoted).toHaveBeenCalledTimes(2);
  });
});
