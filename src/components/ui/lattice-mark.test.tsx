import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { LatticeMark } from "./lattice-mark";

afterEach(cleanup);

it("draws the icon's weave as decoration, with gradients of its own per instance", () => {
  const { container } = render(<><LatticeMark /><LatticeMark /></>);
  const marks = [...container.querySelectorAll("svg.lattice-mark")];
  expect(marks).toHaveLength(2);
  for (const mark of marks) {
    expect(mark).toHaveAttribute("aria-hidden", "true");
    // Three weft threads, seven warp segments and six knots, as in app-icon.svg.
    expect(mark.querySelectorAll(".lattice-mark-thread")).toHaveLength(10);
    expect(mark.querySelectorAll(".lattice-mark-node")).toHaveLength(6);
  }
  // Two marks on one page must not paint each other's gradients.
  const ids = [...container.querySelectorAll("linearGradient")].map((gradient) => gradient.id);
  expect(new Set(ids).size).toBe(4);
  for (const id of ids) expect(id).toMatch(/^[\w-]+$/);
});

it("adds the travelling glint only when the mark weaves", () => {
  const still = render(<LatticeMark />);
  expect(still.container.querySelector(".lattice-mark")).toHaveAttribute("data-motion", "none");
  expect(still.container.querySelector(".lattice-mark-glint")).toBeNull();
  cleanup();
  const weaving = render(<LatticeMark motion="weave" />);
  expect(weaving.container.querySelector(".lattice-mark")).toHaveAttribute("data-motion", "weave");
  expect(weaving.container.querySelectorAll(".lattice-mark-glint")).toHaveLength(3);
});
