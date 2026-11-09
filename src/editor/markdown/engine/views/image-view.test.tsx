/**
 * An image keeps its box (spec R-BLK-3, R-PERF-4): once it has decoded, a
 * view of it that has no bytes yet (released after a while out of view, or
 * drawn again by the long-document window) is laid out at the image's size,
 * so nothing around it moves when the bytes come and go.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { VisualMarkdownEditorProps } from "../../visual-editor-props";
import { LatticeVisualMarkdownEditor } from "../lattice-visual-editor";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

const PNG = "data:image/png;base64,cGxvdA==";

afterEach(cleanup);

function renderImage(text: string, onLoadAsset: VisualMarkdownEditorProps["onLoadAsset"], assetRevision = 0) {
  return render(
    <LatticeVisualMarkdownEditor
      text={text}
      activePath="notes.md"
      onChangeMarkdown={() => true}
      onUndo={() => true}
      onRedo={() => true}
      onLoadAsset={onLoadAsset}
      assetRevision={assetRevision}
    />,
  );
}

/** jsdom decodes nothing: give the image the size a browser reads from its bytes. */
async function decode(name: string, width: number, height: number) {
  const image = await screen.findByRole("img", { name });
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: height });
  fireEvent.load(image);
  return image;
}

it.each([
  ["at its own width", "![Plot](figures/plot.png)", "1200px"],
  ["in its authored frame", "<img src=\"figures/framed.png\" alt=\"Plot\" width={400} />", "100%"],
])("reserves a decoded image's box %s while its bytes are away", async (_label, text, width) => {
  let reads = 0;
  // The first read answers; a later one (a newer revision) is still on its way.
  const onLoadAsset = vi.fn(() => (reads++ === 0 ? Promise.resolve(PNG) : new Promise<string | null>(() => undefined)));
  const view = renderImage(text, onLoadAsset);
  const image = await decode("Plot", 1200, 900);
  // The decoded size is kept on the image, so a redraw lays it out before it decodes.
  await waitFor(() => expect(image.style.aspectRatio).toBe("1200 / 900"));
  expect(image.style.width).toBe(width);
  view.unmount();

  // Drawn again with nothing to show yet: the loading box is the image's box, not a 16:9 stand-in.
  const { container } = renderImage(text, onLoadAsset, 1);
  const loading = await waitFor(() => {
    const element = container.querySelector<HTMLElement>(".lx-md-image-loading");
    expect(element).not.toBeNull();
    return element!;
  });
  expect(loading.style.aspectRatio).toBe("1200 / 900");
  expect(loading.style.width).toBe(width);
});

it("shows the usual loading box for an image never decoded", async () => {
  const { container } = renderImage("![Plot](figures/new.png)", () => new Promise<string | null>(() => undefined));
  const loading = await waitFor(() => {
    const element = container.querySelector<HTMLElement>(".lx-md-image-loading");
    expect(element).not.toBeNull();
    return element!;
  });
  expect(loading.getAttribute("style")).toBeNull();
});
