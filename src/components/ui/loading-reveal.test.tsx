import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LOADING_REVEAL_DELAY_MS, useLoadingReveal } from "./loading-reveal";

function Indicator({ scope }: { scope: string }) {
  return <div data-testid="indicator" style={useLoadingReveal(scope)} />;
}

const delayOf = (view: ReturnType<typeof render>) => view.container.querySelector<HTMLElement>("[data-testid=indicator]")!.style.animationDelay;
let now = 1000;
vi.spyOn(performance, "now").mockImplementation(() => now);
afterEach(() => { now += 10_000; });

it("reveals a fresh load's indicator after the shared delay", () => {
  const view = render(<Indicator scope="fresh" />);
  expect(delayOf(view)).toBe(`${LOADING_REVEAL_DELAY_MS}ms`);
});

it("continues one load's reveal across a remount, so the hand-off neither flickers nor waits again", () => {
  const first = render(<Indicator scope="handoff" />);
  now += 400;
  first.unmount();
  // The component's own skeleton replaces its Suspense fallback a frame later.
  now += 16;
  const second = render(<Indicator scope="handoff" />);
  expect(delayOf(second)).toBe(`${LOADING_REVEAL_DELAY_MS - 416}ms`);
});

it("starts a later load of the same scope on a fresh clock", () => {
  const first = render(<Indicator scope="later" />);
  now += 400;
  first.unmount();
  now += 2000;
  const second = render(<Indicator scope="later" />);
  expect(delayOf(second)).toBe(`${LOADING_REVEAL_DELAY_MS}ms`);
});
