import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcalidrawProps } from "@excalidraw/excalidraw/types";
import { BoardEditor } from "./board-editor";

// Excalidraw probes canvas filter support at import time, and the shared jsdom
// setup returns no 2D context at all; give it one that answers the probe.
vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true, writable: true, value: () => ({ filter: "none" }),
  });
});

// The real canvas needs layout jsdom cannot provide; these tests pin what
// BoardEditor hands Excalidraw and what it does with Excalidraw's callbacks.
const excalidraw = vi.hoisted(() => ({ props: null as ExcalidrawProps | null }));
vi.mock("@excalidraw/excalidraw", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@excalidraw/excalidraw")>()),
  Excalidraw: (props: ExcalidrawProps) => {
    excalidraw.props = props;
    return null;
  },
}));

const SCENE = JSON.stringify({
  type: "excalidraw", version: 2, source: "lattice",
  elements: [{ type: "rectangle", id: "box", x: 0, y: 0, width: 10, height: 10, version: 3, versionNonce: 1 }],
  appState: { gridSize: 20, viewBackgroundColor: "#ffffff" }, files: {},
});

function fakeApi(elements: unknown[]) {
  const api = {
    elements,
    getSceneElementsIncludingDeleted: () => api.elements,
    getAppState: () => ({ gridSize: 20 }),
    getFiles: () => ({}),
    addFiles: vi.fn(),
    updateScene: vi.fn((scene: { elements: unknown[] }) => { api.elements = scene.elements; }),
  };
  act(() => excalidraw.props!.excalidrawAPI!(api as never));
  return api;
}

const view = { scrollX: 0, scrollY: 0, zoom: { value: 1 } };

describe("BoardEditor", () => {
  beforeEach(() => {
    excalidraw.props = null;
    vi.useRealTimers();
  });

  it("keeps the board local and in Lattice's look: no collaboration, file menu, theme toggle or AI", () => {
    render(<BoardEditor path="board.excalidraw" source={SCENE} onChange={() => {}} theme="dark" />);
    const props = excalidraw.props!;
    expect(props.theme).toBe("dark");
    expect(props.langCode).toBe("en");
    expect(props.isCollaborating).toBeUndefined();
    expect(props.aiEnabled).toBe(false);
    expect(props.UIOptions?.canvasActions).toMatchObject({
      export: false, loadScene: false, saveToActiveFile: false, changeViewBackgroundColor: false, toggleTheme: null,
    });
    const initial = props.initialData as { appState: Record<string, unknown>; scrollToContent: boolean };
    expect(initial.appState).toMatchObject({ currentItemRoughness: 0, currentItemFontFamily: 6, viewBackgroundColor: "transparent" });
    expect(initial.scrollToContent).toBe(true);
  });

  it("follows the Lattice theme when it changes", () => {
    const view = render(<BoardEditor path="board.excalidraw" source="" onChange={() => {}} theme="light" />);
    expect(excalidraw.props!.theme).toBe("light");
    view.rerender(<BoardEditor path="board.excalidraw" source="" onChange={() => {}} theme="dark" />);
    expect(excalidraw.props!.theme).toBe("dark");
  });

  it("restores the per-user view instead of fitting the content", () => {
    render(<BoardEditor path="board.excalidraw" source={SCENE} onChange={() => {}} theme="light" initialViewState={{ scrollX: 40, scrollY: -8, zoom: 2 }} />);
    const initial = excalidraw.props!.initialData as { appState: Record<string, unknown>; scrollToContent: boolean };
    expect(initial.appState).toMatchObject({ scrollX: 40, scrollY: -8, zoom: { value: 2 } });
    expect(initial.scrollToContent).toBe(false);
  });

  it("writes an edit after a pause, but not a selection or a view change", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const onViewState = vi.fn();
    render(<BoardEditor path="board.excalidraw" source={SCENE} onChange={onChange} onViewState={onViewState} theme="light" />);
    const initial = (excalidraw.props!.initialData as unknown as { elements: { version: number }[] }).elements;
    const api = fakeApi([...initial]);
    act(() => excalidraw.props!.onChange!(initial as never, { ...view, scrollX: 30 } as never, {}));
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(onChange).not.toHaveBeenCalled();
    expect(onViewState).toHaveBeenCalledWith({ scrollX: 30, scrollY: 0, zoom: 1 });

    const edited = [{ ...initial[0], x: 50, version: initial[0].version + 1 }];
    api.elements = edited;
    act(() => excalidraw.props!.onChange!(edited as never, view as never, {}));
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(JSON.parse(onChange.mock.calls[0][0]).elements[0].x).toBe(50);
  });

  it("hands ⌘P to the app's Quick open instead of Excalidraw", () => {
    const seen = vi.fn();
    const view = render(<BoardEditor path="board.excalidraw" source="" onChange={() => {}} theme="light" />);
    const root = view.container.querySelector(".board-editor-root")!;
    const inner = root.appendChild(document.createElement("div"));
    const excalidrawKeys = vi.fn();
    inner.addEventListener("keydown", excalidrawKeys);
    window.addEventListener("keydown", seen);
    inner.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true }));
    inner.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true, cancelable: true }));
    window.removeEventListener("keydown", seen);
    expect(excalidrawKeys).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen.mock.calls.map(([event]) => [event.metaKey, event.defaultPrevented])).toEqual([[true, false], [false, false]]);
  });

  it("merges a change made to the file outside the board, and ignores its own echo", () => {
    const onChange = vi.fn();
    const board = (source: string) => <BoardEditor path="board.excalidraw" source={source} onChange={onChange} theme="light" />;
    const view = render(board(SCENE));
    const api = fakeApi([...(excalidraw.props!.initialData as { elements: unknown[] }).elements]);
    const moved = JSON.stringify({ ...JSON.parse(SCENE), elements: [{ ...JSON.parse(SCENE).elements[0], x: 300, version: 7 }] });
    view.rerender(board(moved));
    expect(api.updateScene).toHaveBeenCalledTimes(1);
    expect((api.elements[0] as { x: number }).x).toBe(300);
    view.rerender(board(moved));
    expect(api.updateScene).toHaveBeenCalledTimes(1);
  });
});
