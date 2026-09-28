import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TldrawProps } from "tldraw";
import { BoardEditor } from "./board-editor";
import { boardAssetUrls } from "./board-asset-urls";

// The real canvas needs layout jsdom cannot provide; these tests only pin what
// BoardEditor hands tldraw and which preferences it keeps in sync.
const tldraw = vi.hoisted(() => ({ props: null as TldrawProps | null }));
vi.mock("tldraw", async (importOriginal) => ({
  ...(await importOriginal<typeof import("tldraw")>()),
  Tldraw: (props: TldrawProps) => {
    tldraw.props = props;
    return null;
  },
}));

function mountEditor() {
  const updateUserPreferences = vi.fn();
  const editor = {
    user: { updateUserPreferences },
    isDisposed: false,
    getPage: () => undefined,
    getCurrentPageShapes: () => [],
    getCurrentPageId: () => "page:page",
    getCamera: () => ({ x: 0, y: 0, z: 1 }),
    store: { listen: () => () => {} },
  };
  act(() => tldraw.props!.onMount!(editor as never));
  return updateUserPreferences;
}

describe("BoardEditor", () => {
  beforeEach(() => {
    tldraw.props = null;
  });

  it("serves tldraw's assets locally instead of from its CDN", () => {
    render(<BoardEditor path="board.tldr" source="" onChange={() => {}} theme="light" />);
    expect(tldraw.props?.assetUrls).toBe(boardAssetUrls);
  });

  it("follows the Lattice theme on mount and when it changes", () => {
    const board = (theme: "light" | "dark") => (
      <BoardEditor path="board.tldr" source="" onChange={() => {}} theme={theme} />
    );
    const view = render(board("dark"));
    const updateUserPreferences = mountEditor();
    expect(updateUserPreferences).toHaveBeenLastCalledWith(expect.objectContaining({ colorScheme: "dark" }));

    view.rerender(board("light"));
    expect(updateUserPreferences).toHaveBeenLastCalledWith(expect.objectContaining({ colorScheme: "light" }));
  });
});
