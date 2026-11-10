import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SmallStore } from "../trellis/trellis-small-store";
import type { CompiledPdfTabs, RootPdfTab } from "../trellis/compiled-pdf-tabs";
import { RootPdfTabs, type RootPdfs } from "./root-pdf-tabs";
import type { ShownVersions } from "../app/use-pdf-preview";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => { throw new Error("not built here"); }) }));
// The viewer, reduced to the PDF it is handed.
vi.mock("./canvas-lazy-editors", () => ({
  PdfPreview: ({ url }: { url: string | null }) => <div data-testid="root-pdf" data-url={url ?? ""} />,
  PdfPreviewLoading: () => null,
}));
vi.mock("../components/chunk-gate", () => ({ ChunkGate: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../pdf/pdf-figure-source-open", () => ({ PdfFigureSourceOpen: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.5 ${text}`).buffer as ArrayBuffer;

/** The supplement's tab mounted and on screen, beside a live PDF. */
function renderTabs() {
  let made = 0;
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = (blob: Blob) => `blob:${++made}:${blob.size}`;
    static revokeObjectURL = () => {};
  });
  const host = document.createElement("div");
  document.body.append(host);
  const tabs = {
    mounted: new SmallStore<{ tabs: readonly RootPdfTab[] }>({ tabs: [{ document: "SI.tex", visible: true }] }),
    host: () => host,
    shown: vi.fn(),
    build: vi.fn(),
  } as unknown as CompiledPdfTabs;
  const shownBytes = new Map<string, ArrayBuffer>();
  // Everything but the versions stays the same object from render to render, as App's memoized inputs do.
  const base = {
    tabs, shown: null, shownBytes, syncTarget: null, canForwardSync: false, onForwardSync: () => {}, onSource: () => {},
    switchState: { subscribe: () => () => {}, switching: () => false } as unknown as RootPdfs["switchState"],
  };
  const shared = {
    projectRoot: "/p", citations: {} as never, review: {} as never, viewState: {}, onLeaveEditor: () => {},
    selection: { onPdfTextSelect: () => {}, onContextSurfaceActivate: () => {} } as never,
  };
  const props = (shownVersions: ShownVersions): ComponentProps<typeof RootPdfTabs> => ({ ...shared, rootPdfs: { ...base, shownVersions } });
  return { shownBytes, props };
}

describe("a compiled document's own PDF tab", () => {
  // With the PDF in its own window, the supplement's tab stays open while the supplement is built again.
  it("shows its document's newest build as soon as that build is shown", async () => {
    const { shownBytes, props } = renderTabs();
    shownBytes.set("SI.tex", pdf("first"));
    const view = render(<RootPdfTabs {...props({ "SI.tex": 1 })} />);
    const first = (await screen.findByTestId("root-pdf")).getAttribute("data-url");
    expect(first).toBeTruthy();

    shownBytes.set("SI.tex", pdf("second, longer"));
    act(() => view.rerender(<RootPdfTabs {...props({ "SI.tex": 2 })} />));
    const second = screen.getByTestId("root-pdf").getAttribute("data-url");
    expect(second).not.toBe(first);
    expect(invoke).not.toHaveBeenCalled();

    // Another document's build shown: this tab keeps its PDF, without loading it again.
    act(() => view.rerender(<RootPdfTabs {...props({ "SI.tex": 2, "main.tex": 3 })} />));
    expect(screen.getByTestId("root-pdf").getAttribute("data-url")).toBe(second);
  });
});
