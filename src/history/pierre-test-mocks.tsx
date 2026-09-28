/* eslint-disable react-refresh/only-export-components -- a test-only mock module, never hot-reloaded */
/**
 * Stand-ins for Pierre's diff modules, for tests of the multi-file review
 * surfaces. Wire them up from the test file with async `vi.mock` factories:
 *
 *   vi.mock("@pierre/diffs", async () => (await import("…/pierre-test-mocks")).pierreDiffsMock);
 */
import { forwardRef, useImperativeHandle, type ReactNode } from "react";
import { vi } from "vitest";

/** What the mock CodeView reports for scroll position, and records for scrolling. */
export const pierreView = {
  itemTops: new Map<string, number>(),
  scrollTo: vi.fn(),
  scrollTop: 0,
  reset() {
    this.itemTops.clear();
    this.scrollTop = 0;
  },
};

type Side = { name: string; contents: string; lang: string; cacheKey?: string };

export const pierreDiffsMock = {
  registerCustomLanguage: vi.fn(),
  registerCustomTheme: vi.fn(),
  getFiletypeFromFileName: (path: string) => (path.endsWith(".tex") ? "tex" : "text"),
  parseDiffFromFile: (before: Side, after: Side) => ({
    name: before.name,
    lang: before.lang,
    type: "change",
    hunks: [],
    before: before.contents,
    after: after.contents,
    cacheKey: `${before.cacheKey}:${after.cacheKey}`,
  }),
};

/** `usePierreResources` with everything already loaded. */
export const readyPierreResources = () => ({
  error: undefined,
  language: "tex",
  preloadKey: "github-light:tex",
  ready: true,
  theme: "light" as const,
  themeName: "github-light",
});

type MockItem = { id: string; version: number; fileDiff: { name: string; after: string; cacheKey: string } };

export const MockCodeView = forwardRef(function MockCodeView(props: {
  items: MockItem[];
  onScroll?: (scrollTop: number, viewer: { getTopForItem: (id: string) => number | undefined }) => void;
  options: { onLineClick?: (line: { lineNumber: number }, context: { item: MockItem & { type: "diff" } }) => void };
  renderHeaderPrefix?: (item: MockItem) => ReactNode;
  renderHeaderMetadata?: (item: MockItem) => ReactNode;
}, ref) {
  useImperativeHandle(ref, () => ({ scrollTo: pierreView.scrollTo }));
  return (
    <div
      data-testid="code-view"
      onScroll={() => props.onScroll?.(pierreView.scrollTop, { getTopForItem: (id) => pierreView.itemTops.get(id) })}
    >
      {props.items.map((item) => (
        <section
          key={item.id}
          data-testid="code-view-item"
          data-path={item.fileDiff.name}
          data-after={item.fileDiff.after}
          data-cache-key={item.fileDiff.cacheKey}
          data-version={item.version}
          onClick={() => props.options.onLineClick?.({ lineNumber: 7 }, { item: { ...item, type: "diff" } })}
        >
          {props.renderHeaderPrefix?.(item)}
          {props.renderHeaderMetadata?.(item)} {item.fileDiff.name}
        </section>
      ))}
    </div>
  );
});
