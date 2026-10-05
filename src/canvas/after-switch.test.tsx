import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TrellisController } from "../trellis/trellis-controller";
import { AfterSwitch } from "./after-switch";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Beta r20: "When switching workspaces, the PDF sometimes takes a moment to
// load, causing the switch button at the top to appear laggy and pause
// briefly in the middle."
it("mounts a viewer brought on screen by a switch once the switch has animated, and keeps it through the next", () => {
  const controller = new TrellisController();
  act(() => controller.beginSwitch());
  render(<AfterSwitch state={controller.switchState}><div data-testid="viewer" /></AfterSwitch>);
  expect(screen.queryByTestId("viewer")).toBeNull();
  act(() => { vi.advanceTimersByTime(300); });
  expect(screen.queryByTestId("viewer")).toBeNull();
  act(() => { vi.advanceTimersByTime(200); });
  const viewer = screen.getByTestId("viewer");
  act(() => controller.beginSwitch());
  expect(screen.getByTestId("viewer")).toBe(viewer);
});

it("mounts at once outside a switch", () => {
  const controller = new TrellisController();
  render(<AfterSwitch state={controller.switchState}><div data-testid="viewer" /></AfterSwitch>);
  expect(screen.getByTestId("viewer")).toBeInTheDocument();
});
