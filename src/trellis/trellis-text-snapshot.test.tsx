import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceHandle } from "@danfessler/trellis-react";
import { TrellisController, type TrellisViewMode } from "./trellis-controller";
import { TextSnapshot } from "./trellis-text-snapshot";

afterEach(cleanup);

/** `key` open in panel "editor", active, with the view it opens in remembered as `mode`. */
function renderSnapshot(key: string, mode: TrellisViewMode, panelId: string) {
  const controller = new TrellisController();
  controller.setBridge({
    documentMode: () => mode,
    tabLabel: (path: string) => path.split("/").at(-1),
    readText: async () => "\\section{One}\n\nText.",
    viewState: () => undefined,
  } as unknown as Parameters<TrellisController["setBridge"]>[0]);
  controller.ws = { views: () => [{ params: { key }, panelId: "editor" }] } as unknown as WorkspaceHandle;
  controller.app.set({ activeKey: key });
  return render(<div style={{ position: "relative" }}><TextSnapshot controller={controller} fileKey={key} panelId={panelId} /></div>);
}

describe("a document's snapshot", () => {
  // The live document replaces it a moment later: anything but the skeleton
  // of the view it opens in (its source where the page will be, a source
  // without the live editor's rail) is seen turning into something else.
  it.each([
    ["notes/idea.md", "pdf", "page"],
    ["notes/idea.md", "split", "split"],
    ["site/index.html", "pdf", "page"],
    ["chapters/ch01.tex", "source", "source"],
  ] as const)("draws %s, on its way to becoming active in %s, as its %s skeleton", (key, mode, shape) => {
    const { container } = renderSnapshot(key, mode, "editor");
    expect(container.querySelector(".document-skeleton")?.getAttribute("data-shape")).toBe(shape);
    expect(container.querySelector(".trellis-snapshot")).toBeNull();
  });

  it("draws a document beside the active one as itself", () => {
    const { container } = renderSnapshot("chapters/ch01.tex", "source", "beside");
    expect(container.querySelector(".trellis-snapshot")).not.toBeNull();
    expect(container.querySelector(".document-skeleton")).toBeNull();
  });
});
