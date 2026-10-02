import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { EmptyIllustration, type EmptyIllustrationKind } from "./empty-illustration";
import { EmptyState } from "./empty-state";

afterEach(cleanup);

const KINDS: EmptyIllustrationKind[] = ["papers", "comments", "search", "history", "preview", "done"];

it.each(KINDS)("draws the %s illustration as decoration that draws itself in", (kind) => {
  const { container } = render(<EmptyIllustration kind={kind} />);
  const svg = container.querySelector("svg.empty-illustration")!;
  expect(svg).toHaveAttribute("aria-hidden", "true");
  expect(svg).toHaveAttribute("data-kind", kind);
  // Every drawn line is normalised to a length of 1, which is what the
  // draw-in animation's dash offsets assume.
  const lines = [...svg.querySelectorAll(".empty-illustration-line")];
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line).toHaveAttribute("pathLength", "1");
});

it("sits in an empty state without adding to what it announces", () => {
  const { container } = render(<EmptyState icon={<EmptyIllustration kind="comments" size="compact" />} description="No comments yet" />);
  expect(container.querySelector(".ui-empty-state-icon svg")).toHaveAttribute("data-size", "compact");
  expect(container.querySelector(".ui-empty-state")).toHaveTextContent(/^No comments yet$/);
});
