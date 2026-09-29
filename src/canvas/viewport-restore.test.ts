/**
 * Keeping the preview still around an added block (spec R-CHR-5).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreViewportAround } from "./viewport-restore";

const rect = (top: number, bottom: number) => new DOMRect(0, top, 100, bottom - top);

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("restoreViewportAround", () => {
  function setup() {
    const viewport = document.createElement("div");
    const anchor = document.createElement("p");
    const reveal = document.createElement("p");
    viewport.append(anchor, reveal);
    document.body.append(viewport);
    viewport.scrollTop = 480;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(rect(100, 600));
    return { viewport, anchor, reveal };
  }

  it("keeps the anchor in place and reveals a block below the pane with room under it", () => {
    const { viewport, anchor, reveal } = setup();
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect(400, 450));
    const revealRect = vi.spyOn(reveal, "getBoundingClientRect").mockReturnValue(rect(520, 580));
    restoreViewportAround(viewport, 480, anchor, 400, reveal);
    expect(viewport.scrollTop).toBe(480);
    revealRect.mockReturnValue(rect(590, 645));
    restoreViewportAround(viewport, 480, anchor, 400, reveal);
    expect(viewport.scrollTop).toBe(565);
  });

  it("follows the anchor when content above it moved it", () => {
    const { viewport, anchor } = setup();
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect(436, 486));
    restoreViewportAround(viewport, 480, anchor, 400, null);
    expect(viewport.scrollTop).toBe(516);
  });
});
