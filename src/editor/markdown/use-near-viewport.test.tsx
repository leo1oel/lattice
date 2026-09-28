import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNearViewport } from "./use-near-viewport";

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly elements = new Set<Element>();
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds = [0];
  disconnectCount = 0;

  constructor(private readonly callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? "0px";
    FakeIntersectionObserver.instances.push(this);
  }

  observe = (element: Element) => this.elements.add(element);
  unobserve = (element: Element) => this.elements.delete(element);
  disconnect = () => {
    this.disconnectCount += 1;
    this.elements.clear();
  };
  takeRecords = () => [];
  emit(element: Element, isIntersecting: boolean) {
    this.callback([{ target: element, isIntersecting } as IntersectionObserverEntry], this as never);
  }
}

function Probe({ name }: { name: string }) {
  const { nearViewport, viewportRef } = useNearViewport<HTMLDivElement>();
  return <div ref={viewportRef} data-testid={name}>{String(nearViewport)}</div>;
}

const Scroll = ({ children }: { children: ReactNode }) => <div className="editor-doc-scroll">{children}</div>;
const probes = (...names: string[]) => names.map((name) => <Probe key={name} name={name} />);
const byId = (id: string) => screen.getByTestId(id);
/** Instance 0 is the shared preload (buffered) observer; instance 1 tracks actual visibility. */
const preload = () => FakeIntersectionObserver.instances[0]!;
const emit = (id: string, visible: boolean, observer = preload()) => act(() => observer.emit(byId(id), visible));
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("useNearViewport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeIntersectionObserver.instances = [];
  });

  it("shares one observer, stages intersecting content together, and briefly retains content outside the buffer", () => {
    render(<Scroll>{probes("first", "second")}</Scroll>);

    expect(FakeIntersectionObserver.instances).toHaveLength(2);
    expect(preload().root).toBe(byId("first").parentElement);
    expect(preload().elements.size).toBe(2);
    emit("first", true);
    emit("second", true);
    expect(byId("first")).toHaveTextContent("false");
    advance(32);
    expect(byId("first")).toHaveTextContent("true");
    expect(byId("second")).toHaveTextContent("true");
    // Re-entering the buffer cancels a delayed release.
    emit("first", false);
    advance(2_000);
    emit("first", true);
    advance(2_000);
    expect(byId("first")).toHaveTextContent("true");
    emit("first", false);
    expect(byId("first")).toHaveTextContent("true");
    advance(2_999);
    expect(byId("first")).toHaveTextContent("true");
    advance(1);
    expect(byId("first")).toHaveTextContent("false");
  });

  it("preloads all media inside a contained list item from the item boundary, not a nearer JSX wrapper", () => {
    const item = (...names: string[]) => (
      <Scroll>
        <li data-testid="item">
          {probes(...names)}
          <div className="jsx-component-wrapper"><Probe name="media" /></div>
        </li>
      </Scroll>
    );
    const view = render(item("first", "second"));

    expect(preload().elements).toEqual(new Set([byId("item")]));
    emit("item", true);
    // The shared target stays observed when one queued listener unmounts.
    view.rerender(item("first"));
    advance(32);

    expect(preload().elements).toEqual(new Set([byId("item")]));
    expect(byId("first")).toHaveTextContent("true");
    expect(byId("media")).toHaveTextContent("true");
  });

  it("materializes visible content immediately even when buffered work is queued", () => {
    render(<Scroll>{probes("buffered", "visible")}</Scroll>);
    act(() => {
      preload().emit(byId("buffered"), true);
      FakeIntersectionObserver.instances[1]!.emit(byId("visible"), true);
    });
    expect(byId("buffered")).toHaveTextContent("false");
    expect(byId("visible")).toHaveTextContent("true");
  });

  it("does not materialize content that exits or unmounts while queued", () => {
    const view = render(<Scroll>{probes("first", "second")}</Scroll>);
    const second = byId("second");
    act(() => {
      preload().emit(byId("first"), true);
      preload().emit(second, true);
      preload().emit(byId("first"), false);
    });
    view.rerender(<Scroll>{probes("first")}</Scroll>);
    act(() => vi.runAllTimers());

    expect(byId("first")).toHaveTextContent("false");
    expect(preload().elements.has(second)).toBe(false);
  });

  it("keeps content visible when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<Probe name="fallback" />);
    expect(byId("fallback")).toHaveTextContent("true");
  });

  it("uses separate observers for separate scroll roots and disconnects both", () => {
    const view = render(<><Scroll>{probes("first")}</Scroll><Scroll>{probes("second")}</Scroll></>);

    const observers = FakeIntersectionObserver.instances;
    expect(observers).toHaveLength(4);
    expect(observers[0]!.root).not.toBe(observers[2]!.root);
    view.unmount();
    expect(observers.map((observer) => observer.disconnectCount)).toEqual([1, 1, 1, 1]);
  });
});
