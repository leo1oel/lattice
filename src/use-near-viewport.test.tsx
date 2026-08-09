import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNearViewport } from "./use-near-viewport";

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly elements = new Set<Element>();
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds = [0];
  disconnectCount = 0;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
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

describe("useNearViewport", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeIntersectionObserver.instances = [];
  });

  it("shares one observer and releases expensive content outside the buffer", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    render(<div className="editor-doc-scroll"><Probe name="first" /><Probe name="second" /></div>);

    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    const observer = FakeIntersectionObserver.instances[0];
    const first = screen.getByTestId("first");
    expect(observer.root).toBe(first.parentElement);
    expect(observer.elements.size).toBe(2);
    act(() => observer.emit(first, true));
    expect(first).toHaveTextContent("false");
    act(() => vi.advanceTimersByTime(32));
    expect(first).toHaveTextContent("true");
    act(() => observer.emit(first, false));
    expect(first).toHaveTextContent("false");
  });

  it("stages intersecting content one item per idle slice", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    render(<div className="editor-doc-scroll"><Probe name="first" /><Probe name="second" /></div>);

    const observer = FakeIntersectionObserver.instances[0];
    const first = screen.getByTestId("first");
    const second = screen.getByTestId("second");
    act(() => {
      observer.emit(first, true);
      observer.emit(second, true);
    });

    act(() => vi.advanceTimersByTime(32));
    expect(first).toHaveTextContent("true");
    expect(second).toHaveTextContent("false");
    act(() => vi.advanceTimersByTime(32));
    expect(second).toHaveTextContent("true");
  });

  it("does not materialize content that exits or unmounts while queued", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const view = render(<div className="editor-doc-scroll"><Probe name="first" /><Probe name="second" /></div>);

    const observer = FakeIntersectionObserver.instances[0];
    const first = screen.getByTestId("first");
    const second = screen.getByTestId("second");
    act(() => {
      observer.emit(first, true);
      observer.emit(second, true);
      observer.emit(first, false);
    });
    view.rerender(<div className="editor-doc-scroll"><Probe name="first" /></div>);
    act(() => vi.runAllTimers());

    expect(first).toHaveTextContent("false");
    expect(observer.elements.has(second)).toBe(false);
  });

  it("keeps content visible when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<Probe name="fallback" />);
    expect(screen.getByTestId("fallback")).toHaveTextContent("true");
  });

  it("uses separate observers for separate scroll roots and disconnects both", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const view = render(
      <>
        <div className="editor-doc-scroll"><Probe name="first" /></div>
        <div className="editor-doc-scroll"><Probe name="second" /></div>
      </>,
    );

    expect(FakeIntersectionObserver.instances).toHaveLength(2);
    expect(FakeIntersectionObserver.instances[0].root).not.toBe(FakeIntersectionObserver.instances[1].root);
    view.unmount();
    expect(FakeIntersectionObserver.instances.map((observer) => observer.disconnectCount)).toEqual([1, 1]);
  });
});
