import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { lazy, Suspense, useCallback, useMemo, useState, type ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppOverleafCollabDrawer } from "./app-overleaf-drawer";
import { useToolDrawers } from "./use-tool-drawers";

// The Overleaf drawer's chunk, fresh for each test: a lazy component, once
// loaded, stays loaded for the rest of the file.
const overleafChunk = vi.hoisted(() => ({
  release: () => {},
  Drawer: (() => null) as import("react").ComponentType,
}));

vi.mock("../overleaf/overleaf-collab", () => ({
  OverleafCollabDrawer: () => <overleafChunk.Drawer />,
}));

let releaseHistory = () => {};
const HistoryDrawer = lazy(() => new Promise<{ default: ComponentType }>((resolve) => {
  releaseHistory = () => resolve({ default: () => <p>history drawer</p> });
}));
const CommentsPanel = lazy(() => new Promise<{ default: ComponentType<{ onClose: () => void }> }>((resolve) => {
  setTimeout(() => resolve({
    default: ({ onClose }) => <button type="button" onClick={onClose}>comments panel</button>,
  }), 170);
}));

const trellis = { revealOpenTool: () => {} } as never;
const synara = { requestRuntime: () => {}, origin: null, sourceControlFrameRef: { current: null } } as never;
const references = { setLiteratureOpen: () => {} };
const refresh = async () => {};

function Harness({ linked }: { linked: boolean }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const closePanel = useCallback(() => {
    setPanelOpen(false);
    setCollabOpen(false);
  }, []);
  const comments = useMemo(() => ({
    openPanel: () => (linked ? setCollabOpen(true) : setPanelOpen(true)),
    openReply: () => {},
    closePanel,
  }), [closePanel, linked]);
  const tools = useToolDrawers({
    trellis, synara, comments, references, refreshTodos: refresh, refreshWordCount: refresh,
    commentsKind: linked ? "overleaf" : "comments",
    commentsOpen: panelOpen || collabOpen,
  });
  const { loading } = tools;
  return (
    <>
      <button type="button" onClick={() => tools.open("history")}>open history</button>
      <button type="button" onClick={() => tools.open("comments")}>open comments</button>
      {/* Panels → Overleaf, and an Overleaf panel restored from a saved layout. */}
      <button type="button" onClick={() => tools.open("overleaf")}>open overleaf</button>
      {loading && <button type="button" onClick={() => tools.close(loading)}>{`${loading} shell`}</button>}
      <Suspense fallback={null}>{tools.isOpen.history && <HistoryDrawer />}</Suspense>
      <Suspense fallback={null}>
        {linked ? (
          <AppOverleafCollabDrawer
            overleaf={{ overleafCollabOpen: collabOpen, overleafLink: {}, overleafDocPaths: new Map() } as never}
            onClose={closePanel}
            localComments={null}
            localCommentCount={0}
            hasLocalComments={false}
            focusLocalComments={false}
            focusThreadId={null}
            activeFileRef={{ current: "" }}
            openProjectFile={vi.fn()}
            setViewRestore={vi.fn()}
            source=""
          />
        ) : panelOpen && <CommentsPanel onClose={closePanel} />}
      </Suspense>
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  overleafChunk.Drawer = lazy(() => new Promise<{ default: ComponentType }>((resolve) => {
    overleafChunk.release = () => resolve({ default: () => <p>overleaf drawer</p> });
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("closes a loading shell at once while its drawer is still loading", async () => {
  render(<Harness linked={false} />);
  fireEvent.click(screen.getByText("open history"));
  await act(() => vi.advanceTimersByTimeAsync(150));
  fireEvent.click(screen.getByText("history shell"));
  expect(screen.queryByText("history shell")).toBeNull();
  releaseHistory();
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(screen.queryByText("history drawer")).toBeNull();
  expect(screen.queryByText("history shell")).toBeNull();
});

it("takes the shell away with a tool closed inside the shell's minimum time", async () => {
  render(<Harness linked={false} />);
  fireEvent.click(screen.getByText("open comments"));
  await act(() => vi.advanceTimersByTimeAsync(180));
  expect(screen.queryByText("comments shell")).not.toBeNull();
  fireEvent.click(screen.getByText("comments panel"));
  expect(screen.queryByText("comments panel")).toBeNull();
  expect(screen.queryByText("comments shell")).toBeNull();
  fireEvent.click(screen.getByText("open comments"));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.queryByText("comments panel")).not.toBeNull();
  expect(screen.queryByText("comments shell")).toBeNull();
});

it.each(["open comments", "open overleaf"])("shows the comments shell on a slow first open of Overleaf's comments: %s", async (entry) => {
  render(<Harness linked />);
  fireEvent.click(screen.getByText(entry));
  await act(() => vi.advanceTimersByTimeAsync(149));
  expect(screen.queryByText("comments shell")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByText("comments shell")).not.toBeNull();
  await act(async () => overleafChunk.release());
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.queryByText("overleaf drawer")).not.toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(screen.queryByText("comments shell")).toBeNull();
});

it("withdraws a slow Overleaf open from Panels when its shell is closed", async () => {
  render(<Harness linked />);
  fireEvent.click(screen.getByText("open overleaf"));
  await act(() => vi.advanceTimersByTimeAsync(150));
  fireEvent.click(screen.getByText("comments shell"));
  expect(screen.queryByText("comments shell")).toBeNull();
  await act(async () => overleafChunk.release());
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(screen.queryByText("overleaf drawer")).toBeNull();
  expect(screen.queryByText("comments shell")).toBeNull();
});
