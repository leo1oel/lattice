import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@ok-app/components/ui/tooltip";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({
      svg: '<svg viewBox="0 0 100 100"><g><text>Graph</text></g></svg>',
    })),
  },
}));

const reducedMotion = vi.hoisted(() => ({ value: false }));
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => reducedMotion.value,
}));

const panzoom = vi.hoisted(() => {
  const instances: Array<{
    pan: ReturnType<typeof vi.fn>;
    zoomIn: ReturnType<typeof vi.fn>;
    zoomOut: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];
  const create = vi.fn(() => {
    const instance = {
      pan: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      reset: vi.fn(),
      destroy: vi.fn(),
    };
    instances.push(instance);
    return instance;
  });
  return { create, instances };
});

vi.mock("@panzoom/panzoom", () => ({ default: panzoom.create }));

import { MermaidView } from "@ok-app/editor/components/Mermaid";

function renderDiagram() {
  return render(
    <TooltipProvider>
      <MermaidView chart="graph TD; A-->B;" />
    </TooltipProvider>,
  );
}

async function waitForPanzoom() {
  await waitFor(() => expect(panzoom.instances).toHaveLength(1));
  return panzoom.instances[0]!;
}

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
    renderDiagram();
    const instance = await waitForPanzoom();

    for (const name of ["Pan up", "Pan down", "Pan left", "Pan right"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }

    const options = {
      animate: true,
      duration: 200,
      easing: "ease-out",
      relative: true,
    };
    expect(instance.pan.mock.calls).toEqual([
      [0, 48, options],
      [0, -48, options],
      [48, 0, options],
      [-48, 0, options],
    ]);
  });

  it("disables control animation when reduced motion is preferred", async () => {
    reducedMotion.value = true;

    renderDiagram();
    const instance = await waitForPanzoom();
    fireEvent.click(screen.getByRole("button", { name: "Pan up" }));

    expect(instance.pan).toHaveBeenCalledWith(0, 48, {
      animate: false,
      duration: 200,
      easing: "ease-out",
      relative: true,
    });
  });
});
