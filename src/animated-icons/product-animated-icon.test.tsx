import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnimatedProductIcon } from "./product-animated-icon";

afterEach(cleanup);

describe("AnimatedProductIcon", () => {
  it.each(["git-branch", "receipt", "package"] as const)("replays %s from its containing control on hover without snapping on exit", (kind) => {
    const { container } = render(
      <button type="button"><AnimatedProductIcon kind={kind} /></button>,
    );
    const button = container.querySelector("button")!;
    expect(container.querySelector(".bakai-icon.is-playing")).toBeNull();

    fireEvent.pointerEnter(button);
    expect(container.querySelector(".bakai-icon.is-playing")).not.toBeNull();

    fireEvent.pointerLeave(button);
    expect(container.querySelector(".bakai-icon.is-playing")).not.toBeNull();
  });

  it("replays when the containing control receives keyboard focus", () => {
    const { container } = render(
      <button type="button"><AnimatedProductIcon kind="faders" /></button>,
    );

    fireEvent.focus(container.querySelector("button")!);
    expect(container.querySelector(".bakai-icon.is-playing")).not.toBeNull();
  });

  it("keeps its containing control as the pointer target while replaying", () => {
    const { container } = render(
      <button type="button"><AnimatedProductIcon kind="git-branch" /></button>,
    );

    expect(container.querySelector(".animated-product-icon"))
      .toHaveStyle({ pointerEvents: "none" });
  });

  it("exposes the icon kind for product-specific optical sizing", () => {
    const { container } = render(
      <button type="button"><AnimatedProductIcon kind="clock-back" /></button>,
    );

    expect(container.querySelector(".animated-product-icon--clock-back")).not.toBeNull();
  });
});
