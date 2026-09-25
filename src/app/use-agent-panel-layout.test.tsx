import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useAgentPanelLayout } from "./use-agent-panel-layout";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

function Workspace({ docked = true, visible = true, previewOnly = false, dual = false, secondaryPreview = false }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const { panelRef, resize } = useAgentPanelLayout(docked, visible, slotRef);
  return <main className="workspace">
    <section className="shared-sidebar"><div ref={slotRef} /></section>
    <div ref={panelRef} data-testid="panel" />
    <div className="canvas-body">{dual ? <div className="dual-canvas">
      {previewOnly ? <div className="dual-primary dual-pane-preview" /> : <div className="dual-primary"><div className="source-workspace" /></div>}
      <div className={`dual-secondary ${secondaryPreview ? "dual-pane-preview" : "source-workspace"}`} />
    </div> : !previewOnly && <div className="source-workspace" />}</div>
    <button onClick={() => resize(0.6)}>Resize</button>
  </main>;
}

it.each([false, true])("keeps the dock in the primary column when switching to preview and back (secondary preview: %s)", async (secondaryPreview) => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.closest(".dual-primary")
      ? new DOMRect(320, 50, 510, 700)
      : new DOMRect(830, 50, 690, 700);
  });
  const view = render(<Workspace dual secondaryPreview={secondaryPreview} />);
  const panel = screen.getByTestId("panel");
  expect(panel.style.width).toBe("510px");
  view.rerender(<Workspace dual previewOnly secondaryPreview={secondaryPreview} />);
  await waitFor(() => expect(document.querySelector(".dual-primary")).toHaveClass("agent-dock-host"));
  expect(panel.style.left).toBe("320px");
  expect(panel.style.width).toBe("510px");
  expect(document.querySelector(".dual-secondary")).not.toHaveClass("agent-dock-host");
  expect(document.querySelector(".canvas-body")).not.toHaveClass("agent-dock-host");
  view.rerender(<Workspace dual secondaryPreview={secondaryPreview} />);
  await waitFor(() => expect(document.querySelector(".dual-primary .source-workspace")).toHaveClass("agent-dock-host"));
  expect(panel.style.width).toBe("510px");
  expect(document.querySelector(".dual-primary")).not.toHaveClass("agent-dock-host");
});

it("reserves only the editor's bottom area and restores it when hidden or moved", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("source-workspace")
      ? new DOMRect(320, 50, 510, 700)
      : new DOMRect(0, 50, 320, 700);
  });
  const view = render(<Workspace />);
  const panel = screen.getByTestId("panel");
  const editor = document.querySelector<HTMLElement>(".source-workspace")!;
  expect(panel.style.left).toBe("320px");
  expect(panel.style.width).toBe("510px");
  expect(panel.style.top).toBe("505px");
  expect(Number.parseFloat(editor.style.getPropertyValue("--agent-dock-height"))).toBeCloseTo(245);
  fireEvent.click(screen.getByText("Resize"));
  expect(panel.style.top).toBe("330px");
  expect(localStorage.getItem("lattice.agent-dock-ratio.v1")).toBe("0.6");
  view.rerender(<Workspace visible={false} />);
  expect(panel.style.visibility).toBe("hidden");
  expect(editor).not.toHaveClass("agent-dock-host");
  expect(editor.style.getPropertyValue("--agent-dock-height")).toBe("");
  view.rerender(<Workspace />);
  expect(panel.style.visibility).toBe("visible");
  expect(panel.style.top).toBe("330px");
  expect(editor).toHaveClass("agent-dock-host");
  view.rerender(<Workspace docked={false} />);
  expect(panel.style.left).toBe("0px");
  expect(panel.style.width).toBe("320px");
  expect(panel.style.visibility).toBe("visible");
  expect(editor).not.toHaveClass("agent-dock-host");
});

it("clips the sidebar animation without squeezing the iframe", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 40, 180, 700));
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
  const view = render(<Workspace docked={false} />);
  const panel = screen.getByTestId("panel");
  expect(panel.style.width).toBe("320px");
  expect(panel.style.clipPath).toBe("inset(0 140px 0 0)");
  view.rerender(<Workspace />);
  expect(panel.style.width).toBe("180px");
  expect(panel.style.clipPath).toBe("none");
});

it("uses the canvas for preview-only documents and clamps a saved ratio in a short window", () => {
  localStorage.setItem("lattice.agent-dock-ratio.v1", "4");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 40, 800, 200));
  const view = render(<Workspace previewOnly />);
  const panel = screen.getByTestId("panel");
  const canvas = document.querySelector<HTMLElement>(".canvas-body")!;
  expect(panel.style.height).toBe("80px");
  expect(panel.style.top).toBe("160px");
  expect(canvas).toHaveClass("agent-dock-host");
  view.unmount();
  expect(canvas).not.toHaveClass("agent-dock-host");
});
