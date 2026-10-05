import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { msg } from "@lingui/core/macro";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasFinishedGuidedTour, rememberGuidedTour } from "../settings/app-settings";
import GuidedTour from "./guided-tour";
import { placeCard } from "./guided-tour-placement";
import type { TourContext, TourStep } from "./guided-tour-steps";

/** Only what the tour reads of the controller: the workspace it snapshots on entering a stop. */
const controller = {
  app: { get: () => ({ activeKey: "main.tex" }) },
  ui: { get: () => ({ preset: null, workspace: "default" }) },
} as unknown as TourContext["controller"];

function target(rect = new DOMRect(40, 60, 300, 200)) {
  return () => rect;
}

function renderTour(steps: TourStep[], props: { replay?: boolean } = {}) {
  const onClose = vi.fn();
  const view = render(
    <GuidedTour controller={controller} openFile={vi.fn()} commentCount={() => 0} onClose={onClose} steps={steps} {...props} />,
  );
  return { onClose, ...view };
}

const welcome: TourStep = { id: "welcome", title: msg`Welcome to Lattice`, body: msg`A one-minute tour.` };

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("GuidedTour", () => {
  it("walks its stops with Next, Back and the arrow keys, and finishes", async () => {
    const steps: TourStep[] = [
      welcome,
      { id: "one", title: msg`Your project`, body: msg`Files live here.`, target: target() },
      { id: "two", title: msg`Comments`, body: msg`Notes gather here.`, target: target() },
    ];
    const { onClose } = renderTour(steps);

    const card = screen.getByRole("dialog", { name: "Welcome to Lattice" });
    expect(card).toHaveAccessibleDescription("A one-minute tour.");
    await waitFor(() => expect(card).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: /start tour/i }));
    expect(await screen.findByRole("dialog", { name: "Your project" })).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Tour progress" }).querySelector('[aria-current="step"]')).toHaveTextContent("Your project");

    fireEvent.keyDown(card, { key: "ArrowRight" });
    expect(await screen.findByRole("dialog", { name: "Comments" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("dialog", { name: "Your project" })).toBeInTheDocument();
    fireEvent.keyDown(card, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("button", { name: "Finish" }));
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it("ends on Escape, but not on an Escape something else already used", () => {
    const { onClose } = renderTour([welcome]);
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    act(() => void window.dispatchEvent(handled));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith("skipped");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reveals a stop's place, and passes a stop whose place never comes on screen", async () => {
    const reveal = vi.fn();
    const steps: TourStep[] = [
      welcome,
      { id: "hidden", title: msg`The Agent`, body: msg`It is not open.`, target: () => null, reveal },
      { id: "shown", title: msg`Papers`, body: msg`They are open.`, target: target() },
    ];
    renderTour(steps);
    fireEvent.click(screen.getByRole("button", { name: /start tour/i }));
    expect(await screen.findByRole("dialog", { name: "The Agent" })).toBeInTheDocument();
    expect(reveal).toHaveBeenCalledTimes(1);
    // Asked once more after a moment, then given up on.
    expect(await screen.findByRole("dialog", { name: "Papers" }, { timeout: 4_000 })).toBeInTheDocument();
    expect(reveal).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(document.querySelector(".guided-tour[data-spotlit]")).not.toBeNull());

    // Going back passes it the other way, to the welcome.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("dialog", { name: "Welcome to Lattice" }, { timeout: 4_000 })).toBeInTheDocument();
  });

  it("checks off a stop's action once it is done, and announces it", async () => {
    let finish = () => {};
    const leave = vi.fn();
    const steps: TourStep[] = [
      welcome,
      {
        id: "try", title: msg`Write, then build`, body: msg`Edit here.`, action: msg`Press ⌘S`, target: target(),
        watch: (_context, done) => {
          finish = done;
          return () => {};
        },
        leave,
      },
    ];
    renderTour(steps);
    fireEvent.click(screen.getByRole("button", { name: /start tour/i }));
    const action = (await screen.findByText("Press ⌘S")).closest(".guided-tour-action")!;
    expect(action).not.toHaveAttribute("data-done");
    act(() => finish());
    expect(action).toHaveAttribute("data-done");
    expect(screen.getByText("Done")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("dialog", { name: "Welcome to Lattice" });
    expect(leave).toHaveBeenCalledWith(expect.anything(), { activeKey: "main.tex", preset: null, workspace: "default" });
  });

  it("welcomes back a writer who finished it before", () => {
    renderTour([welcome], { replay: true });
    expect(screen.getByRole("dialog", { name: "Welcome back" })).toBeInTheDocument();
  });
});

describe("guided tour progress", () => {
  it("remembers a finished tour, and a skipped replay does not forget it", () => {
    expect(hasFinishedGuidedTour()).toBe(false);
    rememberGuidedTour("skipped");
    expect(hasFinishedGuidedTour()).toBe(false);
    rememberGuidedTour("completed");
    rememberGuidedTour("skipped");
    expect(hasFinishedGuidedTour()).toBe(true);
  });
});

describe("placeCard", () => {
  const card = { width: 320, height: 180 };
  const viewport = { width: 1280, height: 800 };

  it("sits beside the spotlight on the roomier side that fits it", () => {
    expect(placeCard({ left: 0, top: 40, width: 280, height: 700 }, card, viewport)).toMatchObject({ side: "right", left: 294 });
    expect(placeCard({ left: 900, top: 40, width: 380, height: 700 }, card, viewport)).toMatchObject({ side: "left", left: 566 });
    expect(placeCard({ left: 300, top: 0, width: 700, height: 40 }, card, viewport)).toMatchObject({ side: "bottom", top: 54 });
  });

  it("goes inside a spotlight that fills the window, and centers without one", () => {
    expect(placeCard({ left: 8, top: 8, width: 1264, height: 784 }, card, viewport)).toMatchObject({ side: "inside" });
    expect(placeCard(null, card, viewport)).toEqual({ side: "center", left: 480, top: 310 });
  });

  it("keeps the card inside a narrow window", () => {
    const narrow = { width: 400, height: 700 };
    const placed = placeCard({ left: 0, top: 0, width: 400, height: 700 }, { width: 368, height: 200 }, narrow);
    expect(placed.left).toBeGreaterThanOrEqual(16);
    expect(placed.left + 368).toBeLessThanOrEqual(narrow.width - 16);
  });
});
