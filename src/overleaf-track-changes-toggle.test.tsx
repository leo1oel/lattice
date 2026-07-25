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
    render(<OverleafTrackChangesToggle on={false} disabled={false} pending={false} onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: /Editing/ })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("shows the on state clearly and asks to turn off when clicked", () => {
    const onToggle = vi.fn().mockResolvedValue(undefined);
    render(<OverleafTrackChangesToggle on disabled={false} pending={false} onToggle={onToggle} />);
    const button = screen.getByRole("button", { name: /Suggesting/ });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button.className).toContain("on");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("disables rather than lets a read-only account try", () => {
    const onToggle = vi.fn();
    render(<OverleafTrackChangesToggle on={false} disabled pending={false} onToggle={onToggle} />);
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
