import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { lazy, Suspense, useCallback, useState, useTransition, type ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsLoadingShell } from "./tool-loading-shell";
import { useLoadingShell } from "./use-loading-shell";

let releaseSettings = () => {};
const SettingsDialog = lazy(() => new Promise<{ default: ComponentType }>((resolve) => {
  releaseSettings = () => resolve({ default: () => <p>settings dialog</p> });
}));

// Settings as App wires it: a transition opens it, the shell follows it.
function Harness() {
  const [open, setOpen] = useState(false);
  const [opening, startOpen] = useTransition();
  const late = useLoadingShell(opening, opening || open);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" onClick={() => startOpen(() => setOpen(true))}>open settings</button>
      {late && <SettingsLoadingShell label="Settings" backdrop={!open} onClose={close} />}
      <Suspense fallback={null}>{open && <SettingsDialog />}</Suspense>
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("closes Settings' loading card on Escape and withdraws the pending open", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByText("open settings"));
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(screen.queryByRole("status", { name: "Settings" })).not.toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.queryByRole("status", { name: "Settings" })).toBeNull();
  await act(async () => releaseSettings());
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(screen.queryByText("settings dialog")).toBeNull();
  expect(screen.queryByRole("status", { name: "Settings" })).toBeNull();
});
