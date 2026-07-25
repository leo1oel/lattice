import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { OverleafTrackChangesToggle } from "./overleaf-track-changes-toggle";
import { useOverleafTrackChangesToggle } from "./use-overleaf-track-changes-toggle";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("OverleafTrackChangesToggle", () => {
  beforeEach(cleanup);

  it("shows the off state and asks to turn on when clicked", () => {
    const onToggle = vi.fn().mockResolvedValue(undefined);
    render(<OverleafTrackChangesToggle on={false} disabled={false} pending={false} onToggle={onToggle} onError={() => undefined} />);
    expect(screen.getByRole("button", { name: /Editing/ })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("shows the on state clearly and asks to turn off when clicked", () => {
    const onToggle = vi.fn().mockResolvedValue(undefined);
    render(<OverleafTrackChangesToggle on disabled={false} pending={false} onToggle={onToggle} onError={() => undefined} />);
    const button = screen.getByRole("button", { name: /Suggesting/ });
    expect(button).toHaveAttribute("aria-pressed", "true");
    // `active` is the toolbar's own pressed treatment, shared with the other
    // toggles beside it.
    expect(button.className).toContain("active");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("carries its label the way the toolbar can shrink", () => {
    // The toolbar sizes every button to a 28px square and hides the label of a
    // `canvas-text-button` when it runs out of room, by hiding the span. A
    // button that styles its own width loses to that rule and its label ends
    // up outside the button, clipped by the toolbar's edge — which is exactly
    // what this one did.
    render(
      <OverleafTrackChangesToggle on={false} disabled={false} pending={false} onToggle={vi.fn()} onError={() => undefined} />,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("canvas-text-button");
    expect(button.querySelector("span")?.textContent).toBe("Editing");
  });

  it("reports a refusal instead of looking like a dead button", async () => {
    // The bug this covers: the toggle refuses when this account's Overleaf id
    // is not known, the button caught that and discarded it, and clicking
    // therefore did nothing and said nothing.
    const onError = vi.fn();
    const onToggle = vi.fn().mockRejectedValue(new Error("no account id yet"));
    render(
      <OverleafTrackChangesToggle
        on={false}
        disabled={false}
        pending={false}
        onToggle={onToggle}
        onError={onError}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("no account id yet"));
  });

  it("disables rather than lets a read-only account try", () => {
    const onToggle = vi.fn();
    render(<OverleafTrackChangesToggle on={false} disabled pending={false} onToggle={onToggle} onError={() => undefined} />);
    expect(screen.getByRole("button")).toBeDisabled();
    fireEvent.click(screen.getByRole("button"));
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe("useOverleafTrackChangesToggle", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("sends a map with only this account's id", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const { result } = renderHook(() => useOverleafTrackChangesToggle("user-1"));

    await act(async () => {
      await result.current.setTrackChanges(true);
    });
    expect(invoke).toHaveBeenCalledWith("overleaf_set_track_changes", { onFor: { "user-1": true } });
  });

  it("refuses rather than guessing an id when this account's is not yet known", async () => {
    const { result } = renderHook(() => useOverleafTrackChangesToggle(null));

    await act(async () => {
      await expect(result.current.setTrackChanges(true)).rejects.toThrow(/Overleaf id/);
    });
    expect(invoke).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.error).toMatch(/Overleaf id/));
  });
});
