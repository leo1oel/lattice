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

  it("shares one observer and briefly retains content outside the buffer", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    render(<div className="editor-doc-scroll"><Probe name="first" /><Probe name="second" /></div>);

    expect(FakeIntersectionObserver.instances).toHaveLength(2);
    const observer = FakeIntersectionObserver.instances[0];
    const first = screen.getByTestId("first");
    expect(observer.root).toBe(first.parentElement);
    expect(observer.elements.size).toBe(2);
    act(() => observer.emit(first, true));
    expect(first).toHaveTextContent("false");
    act(() => vi.advanceTimersByTime(32));
    expect(first).toHaveTextContent("true");
    act(() => observer.emit(first, false));
    expect(first).toHaveTextContent("true");
    act(() => vi.advanceTimersByTime(2_999));
    expect(first).toHaveTextContent("true");
    act(() => vi.advanceTimersByTime(1));
    expect(first).toHaveTextContent("false");
  });

  it("preloads all media inside a contained list item from the item boundary", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    render(
      <div className="editor-doc-scroll">
        <li data-testid="item">
          <Probe name="first" />
          <Probe name="second" />
        </li>
      </div>,
    );

    const observer = FakeIntersectionObserver.instances[0];
    const item = screen.getByTestId("item");
    expect(observer.elements).toEqual(new Set([item]));
    act(() => observer.emit(item, true));
    act(() => vi.advanceTimersByTime(32));
    expect(screen.getByTestId("first")).toHaveTextContent("true");
    expect(screen.getByTestId("second")).toHaveTextContent("true");
  });

  it("prefers the list item over a nearer JSX wrapper", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    render(
      <div className="editor-doc-scroll">
        <li data-testid="item">
          <div className="jsx-component-wrapper"><Probe name="media" /></div>
        </li>
      </div>,
    );

    expect(FakeIntersectionObserver.instances[0].elements).toEqual(
      new Set([screen.getByTestId("item")]),
    );
  });

  it("keeps a shared target observed when one queued listener unmounts", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const view = render(
      <div className="editor-doc-scroll">
        <li data-testid="item"><Probe name="first" /><Probe name="second" /></li>
      </div>,
    );
    const observer = FakeIntersectionObserver.instances[0];
    const item = screen.getByTestId("item");
    act(() => observer.emit(item, true));
    view.rerender(
      <div className="editor-doc-scroll">
        <li data-testid="item"><Probe name="first" /></li>
      </div>,
    );
    act(() => vi.advanceTimersByTime(32));

    expect(observer.elements).toEqual(new Set([screen.getByTestId("item")]));
    expect(screen.getByTestId("first")).toHaveTextContent("true");
  });

  it("cancels delayed release when content re-enters the buffer", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    render(<div className="editor-doc-scroll"><Probe name="first" /></div>);
    const observer = FakeIntersectionObserver.instances[0];
    const first = screen.getByTestId("first");
    act(() => observer.emit(first, true));
    act(() => vi.advanceTimersByTime(32));
    act(() => observer.emit(first, false));
    act(() => vi.advanceTimersByTime(2_000));
    act(() => observer.emit(first, true));
    act(() => vi.advanceTimersByTime(2_000));
    expect(first).toHaveTextContent("true");
  });

  it("stages a bounded batch of intersecting content per idle slice", () => {
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
    expect(second).toHaveTextContent("true");
  });

  it("materializes visible content immediately even when buffered work is queued", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    render(<div className="editor-doc-scroll"><Probe name="buffered" /><Probe name="visible" /></div>);

    const observer = FakeIntersectionObserver.instances[0];
    const buffered = screen.getByTestId("buffered");
    const visible = screen.getByTestId("visible");
    act(() => {
      observer.emit(buffered, true);
      FakeIntersectionObserver.instances[1].emit(visible, true);
    });

    expect(buffered).toHaveTextContent("false");
    expect(visible).toHaveTextContent("true");
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

    expect(FakeIntersectionObserver.instances).toHaveLength(4);
    expect(FakeIntersectionObserver.instances[0].root).not.toBe(FakeIntersectionObserver.instances[2].root);
    view.unmount();
    expect(FakeIntersectionObserver.instances.map((observer) => observer.disconnectCount)).toEqual([1, 1, 1, 1]);
  });
});
