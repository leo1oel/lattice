import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BakaiIconKind } from "./bakai-icons";
import { AnimatedProductIcon } from "./product-animated-icon";

afterEach(cleanup);

function renderInButton(kind: BakaiIconKind, wrapped = false) {
  const icon = <AnimatedProductIcon kind={kind} />;
  const { container } = render(<button type="button">{wrapped ? <span>{icon}</span> : icon}</button>);
  return {
    container,
    button: container.querySelector("button")!,
    playing: () => container.querySelector(".bakai-icon.is-playing"),
  };
}

describe("AnimatedProductIcon", () => {
  it.each(["git-branch", "receipt", "package"] as const)("replays %s from its containing control on hover without snapping on exit", (kind) => {
    const { button, playing } = renderInButton(kind);
    expect(playing()).toBeNull();

    fireEvent.pointerEnter(button);
    expect(playing()).not.toBeNull();

    fireEvent.pointerLeave(button);
    expect(playing()).not.toBeNull();
  });

  it.each([false, true])("replays on keyboard focus of the containing control (status wrapper: %s)", (wrapped) => {
    const { button, playing } = renderInButton("faders", wrapped);
    expect(playing()).toBeNull();
    fireEvent.focus(button);
    expect(playing()).not.toBeNull();
  });

  it("exposes the icon kind for optical sizing and leaves the control as the pointer target", () => {
    const { container } = renderInButton("clock-back");
    expect(container.querySelector(".animated-product-icon--clock-back")).toHaveStyle({ pointerEvents: "none" });
  });
});
