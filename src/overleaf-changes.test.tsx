import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { OverleafChangesPanel } from "./overleaf-changes";
import { useOverleafTrackChanges } from "./use-overleaf-track-changes";
import type { TrackedChange } from "./use-overleaf-realtime";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const SOURCE = "The quick brown fox jumps over the lazy dog";

function change(overrides: Partial<TrackedChange> = {}): TrackedChange {
  return {
    id: "c1",
    position: 4,
    text: "quick",
    deletion: false,
    userId: "user-1",
    timestamp: "2026-07-01T10:00:00.000Z",
    hue: 200,
    ...overrides,
  };
}

function panel(overrides: Partial<Parameters<typeof OverleafChangesPanel>[0]> = {}) {
  return (
    <OverleafChangesPanel
      changes={[change()]}
      source={SOURCE}
      authorName={() => "Ada Lovelace"}
      documentOpen
      canAct
      busy={null}
      error={null}
      onAccept={vi.fn().mockResolvedValue(undefined)}
      onReject={vi.fn().mockResolvedValue(undefined)}
      onReveal={vi.fn()}
      {...overrides}
    />
  );
}

describe("Overleaf changes panel", () => {
  beforeEach(cleanup);

  it("quotes the suggestion in context and reveals it when clicked", () => {
    const onReveal = vi.fn();
    render(panel({ onReveal }));
    expect(screen.getByText("quick")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("suggests inserting")).toBeInTheDocument();
    fireEvent.click(screen.getByText("quick"));
    expect(onReveal).toHaveBeenCalledWith(4);
  });

  it("accepts and rejects one suggestion through its own row", async () => {
    const onAccept = vi.fn().mockResolvedValue(undefined);
    const onReject = vi.fn().mockResolvedValue(undefined);
    render(panel({ onAccept, onReject }));

    fireEvent.click(screen.getByRole("button", { name: /Accept$/ }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith(["c1"]));

    fireEvent.click(screen.getByRole("button", { name: /Reject$/ }));
    await waitFor(() => expect(onReject).toHaveBeenCalledWith([change()]));
  });

  it("sends every id in a single call when accepting all", async () => {
    const onAccept = vi.fn().mockResolvedValue(undefined);
    const changes = [change({ id: "a" }), change({ id: "b", position: 20, text: "lazy" })];
    render(panel({ changes, onAccept }));

    fireEvent.click(screen.getByRole("button", { name: /Accept all/ }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(1));
    expect(onAccept).toHaveBeenCalledWith(["a", "b"]);
  });

  it("disables accept and reject when this account cannot act", () => {
    render(panel({ canAct: false }));
    expect(screen.getByRole("button", { name: /Accept$/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Reject$/ })).toBeDisabled();
  });

  it("disables acting when the document is not open, even if the account otherwise could", () => {
    render(panel({ documentOpen: false }));
    expect(screen.getByRole("button", { name: /Accept$/ })).toBeDisabled();
  });
});

describe("useOverleafTrackChanges", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("accepts by sending the docId and ids Overleaf expects", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const reload = vi.fn();
    const { result } = renderHook(() => useOverleafTrackChanges({
      enabled: true,
      docId: "doc-1",
      version: 7,
      changes: [change()],
      canAct: true,
      reload,
    }));

    await act(async () => {
      await result.current.accept(["c1"]);
    });
    expect(invoke).toHaveBeenCalledWith("overleaf_accept_changes", { docId: "doc-1", changeIds: ["c1"] });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("rejects by sending the full change objects and the document's version", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const reload = vi.fn();
    const toReject = [change()];
    const { result } = renderHook(() => useOverleafTrackChanges({
      enabled: true,
      docId: "doc-1",
      version: 7,
      changes: toReject,
      canAct: true,
      reload,
    }));

    await act(async () => {
      await result.current.reject(toReject);
    });
    expect(invoke).toHaveBeenCalledWith("overleaf_reject_changes", {
      docId: "doc-1",
      version: 7,
      changes: toReject,
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("refuses to act for a read-only account, rather than calling Overleaf and failing there", async () => {
    const reload = vi.fn();
    // No changes in this render: the point is that `accept` itself refuses
    // to call Overleaf, which the author-name lookup (keyed on the changes
    // that exist) would otherwise also do and muddy this assertion.
    const { result } = renderHook(() => useOverleafTrackChanges({
      enabled: true,
      docId: "doc-1",
      version: 7,
      changes: [],
      canAct: false,
      reload,
    }));

    await act(async () => {
      await expect(result.current.accept(["c1"])).rejects.toThrow(/cannot accept or reject/);
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/cannot accept or reject/);
  });

  it("looks up author names from overleaf_change_authors, snake_case fields and all", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_change_authors") {
        return [
          { id: "user-1", email: "ada@example.edu", first_name: "Ada", last_name: "Lovelace" },
          { id: "user-2", email: "sam@example.edu" },
        ];
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const { result } = renderHook(() => useOverleafTrackChanges({
      enabled: true,
      docId: "doc-1",
      version: 7,
      changes: [change({ userId: "user-1" }), change({ id: "c2", userId: "user-2" })],
      canAct: true,
      reload: vi.fn(),
    }));

    await waitFor(() => expect(result.current.authorName("user-1")).toBe("Ada Lovelace"));
    expect(result.current.authorName("user-2")).toBe("sam");
    expect(result.current.authorName("user-3")).toBe("Unknown");
    expect(result.current.authorName(null)).toBe("Unknown");
  });
});
