import { useLayoutEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addAppLog } from "./app-log-store";
import { registerCrashEdits } from "./crash-save";
import { PanelErrorBoundary } from "./panel-error-boundary";

vi.mock("./app-log-store", () => ({ addAppLog: vi.fn() }));

const crash = { on: true };
let unregister: (() => void) | null = null;

afterEach(() => {
  cleanup();
  unregister?.();
  unregister = null;
  crash.on = true;
  vi.mocked(addAppLog).mockClear();
  // React reports every caught render error on the console; these tests cause them on purpose.
  vi.restoreAllMocks();
});

function quietConsole() {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

/** A panel whose render throws while `crash.on`. */
function Flaky({ label = "panel content" }: { label?: string }) {
  if (crash.on) throw new Error("panel render failed");
  return <p>{label}</p>;
}

/**
 * An editor holding an edit it has not handed to the document yet: it
 * registers its flush in a layout effect and unregisters in the cleanup, as
 * the visual Markdown editor does (useRegistration in document-canvas.tsx).
 */
function EditorWithPendingEdit({ flushes, explode }: { flushes: string[]; explode: { on: boolean } }) {
  useLayoutEffect(() => {
    let flush: (() => boolean) | null = () => {
      flushes.push("Last words.");
      return true;
    };
    unregister = registerCrashEdits({ flush: () => flush?.() ?? false, save: async () => flushes.length > 0 });
    return () => { flush = null; };
  }, [flushes]);
  if (explode.on) throw new Error("editor render failed");
  return <p>editor</p>;
}

describe("PanelErrorBoundary", () => {
  it("replaces only the crashed panel with a card, and reloads it on request", async () => {
    quietConsole();
    render(
      <>
        <p>title bar</p>
        <PanelErrorBoundary name="project"><Flaky /></PanelErrorBoundary>
      </>,
    );
    // Before the boundary, the error reached the root and the whole window became the crash page.
    expect(screen.getByRole("alert")).toHaveTextContent("This panel stopped working");
    expect(screen.getByText("title bar")).toBeInTheDocument();
    expect(addAppLog).toHaveBeenCalledWith(expect.objectContaining({
      level: "error", title: "A panel crashed", detail: expect.stringMatching(/^project\n.*panel render failed/s), toast: false,
    }));

    crash.on = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload panel" }));
    expect(await screen.findByText("panel content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("puts the card in the panel's host when its content portals there", () => {
    quietConsole();
    const host = document.createElement("div");
    document.body.append(host);
    render(<div data-testid="in-place"><PanelErrorBoundary name="editor" host={host}><Flaky /></PanelErrorBoundary></div>);
    expect(host).toHaveTextContent("This panel stopped working");
    expect(screen.getByTestId("in-place")).toBeEmptyDOMElement();
    host.remove();
  });

  it("tries again when its reset key changes", () => {
    quietConsole();
    const { rerender } = render(<PanelErrorBoundary name="editor" resetKey="a.tex"><Flaky label="b.tex" /></PanelErrorBoundary>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    crash.on = false;
    rerender(<PanelErrorBoundary name="editor" resetKey="b.tex"><Flaky label="b.tex" /></PanelErrorBoundary>);
    expect(screen.getByText("b.tex")).toBeInTheDocument();
  });

  it("flushes the crashed editor's pending edit before React unregisters it", () => {
    quietConsole();
    const flushes: string[] = [];
    const explode = { on: false };
    const { rerender } = render(<PanelErrorBoundary name="editor"><EditorWithPendingEdit flushes={flushes} explode={explode} /></PanelErrorBoundary>);
    explode.on = true;
    rerender(<PanelErrorBoundary name="editor"><EditorWithPendingEdit flushes={flushes} explode={explode} /></PanelErrorBoundary>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    // A save started from componentDidCatch found the flush already unregistered, and the edit was lost.
    expect(flushes).toEqual(["Last words."]);
  });
});

