import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@ok-app/components/ui/tooltip";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 100 100"><g><text>Graph</text></g></svg>' })),
  },
}));

const reducedMotion = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => reducedMotion.value,
}));

const panzoom = vi.hoisted(() => {
  const instances: Array<Record<"pan" | "zoomIn" | "zoomOut" | "reset" | "destroy", ReturnType<typeof vi.fn>>> = [];
  const create = vi.fn(() => {
    const instance = { pan: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), reset: vi.fn(), destroy: vi.fn() };
    instances.push(instance);
    return instance;
  });
  return { create, instances };
});
vi.mock("@panzoom/panzoom", () => ({ default: panzoom.create }));

import { MermaidView } from "@ok-app/editor/components/Mermaid";

async function renderDiagram() {
  render(<TooltipProvider><MermaidView chart="graph TD; A-->B;" /></TooltipProvider>);
  await waitFor(() => expect(panzoom.instances).toHaveLength(1));
  return panzoom.instances[0]!;
}

const panOptions = (animate: boolean) => ({ animate, duration: 200, easing: "ease-out", relative: true });

describe("Mermaid controls", () => {
  beforeEach(() => {
    panzoom.create.mockClear();
    panzoom.instances.length = 0;
    reducedMotion.value = false;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("pans the viewport in the labeled direction with ease-out motion", async () => {
    const instance = await renderDiagram();
    for (const name of ["Pan up", "Pan down", "Pan left", "Pan right"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    expect(instance.pan.mock.calls).toEqual([
      [0, 48, panOptions(true)],
      [0, -48, panOptions(true)],
      [48, 0, panOptions(true)],
      [-48, 0, panOptions(true)],
    ]);
  });

  it("disables control animation when reduced motion is preferred", async () => {
    reducedMotion.value = true;
    const instance = await renderDiagram();
    fireEvent.click(screen.getByRole("button", { name: "Pan up" }));
    expect(instance.pan).toHaveBeenCalledWith(0, 48, panOptions(false));
  });
});
