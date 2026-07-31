import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useOverleafTrackChanges } from "./use-overleaf-track-changes";
import type { ReservedOperation, TrackedChange } from "./use-overleaf-realtime";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const CHANGE: TrackedChange = {
  id: "change-1",
  position: 2,
  text: "new",
  deletion: false,
  userId: "author-1",
  timestamp: null,
  hue: 100,
};

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (command) => (
    command === "overleaf_change_authors" ? [] : undefined
  ));
});

function mount(options?: {
  settledVersion?: () => number | null;
  reserveOperation?: () => ReservedOperation | null;
  noteReservedOperationUnknown?: (reservation: ReservedOperation, reason: unknown) => void;
}) {
  return renderHook(() => useOverleafTrackChanges({
    enabled: true,
    projectRoot: "/tmp/project",
    docId: "doc-1",
    settledVersion: options?.settledVersion ?? (() => 12),
    reserveOperation: options?.reserveOperation ?? (() => ({ docId: "doc-1", version: 12 })),
    noteReservedOperationUnknown: options?.noteReservedOperationUnknown ?? (() => undefined),
    changes: [CHANGE],
    canAct: true,
    reload: vi.fn(),
  }));
}

describe("accepting tracked changes", () => {
  it("refuses to accept while an OT operation is still pending", async () => {
    const settledVersion = vi.fn(() => null);
    const reserveOperation = vi.fn(() => ({ docId: "doc-1", version: 12 }));
    const { result } = mount({ settledVersion, reserveOperation });

    await act(async () => {
      await expect(result.current.accept([CHANGE.id])).rejects.toThrow(
        /edit is still on its way/i,
      );
    });

    expect(settledVersion).toHaveBeenCalledOnce();
    // Accept is a REST mutation. It checks for a settled wire without creating
    // a fake OT reservation that could never receive an acknowledgement.
    expect(reserveOperation).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith(
      "overleaf_accept_changes",
      expect.anything(),
    );
  });

  it("accepts only after the document is settled", async () => {
    const { result } = mount();

    await act(async () => {
      await result.current.accept([CHANGE.id]);
    });

    expect(invoke).toHaveBeenCalledWith("overleaf_accept_changes", {
      projectRoot: "/tmp/project",
      docId: "doc-1",
      changeIds: [CHANGE.id],
    });
  });

  it("does not reload a different document after an accept finishes", async () => {
    let finishAccept: (() => void) | undefined;
    const acceptPending = new Promise<void>((resolve) => {
      finishAccept = resolve;
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_change_authors") return [];
      if (command === "overleaf_accept_changes") return acceptPending;
      return undefined;
    });
    const reload = vi.fn();
    const { result, rerender } = renderHook(
      (docId: string) => useOverleafTrackChanges({
        enabled: true,
        projectRoot: "/tmp/project",
        docId,
        settledVersion: () => 12,
        reserveOperation: () => ({ docId, version: 12 }),
        noteReservedOperationUnknown: () => undefined,
        changes: [CHANGE],
        canAct: true,
        reload,
      }),
      { initialProps: "doc-1" },
    );

    let request: Promise<void> | undefined;
    act(() => {
      request = result.current.accept([CHANGE.id]);
    });
    rerender("doc-2");
    await act(async () => {
      finishAccept?.();
      await request;
    });

    expect(reload).not.toHaveBeenCalled();
  });
});

describe("rejecting tracked changes", () => {
  it("continues to reserve the OT wire at the current version", async () => {
    const reserveOperation = vi.fn(() => ({ docId: "doc-1", version: 19 }));
    const { result } = mount({ reserveOperation });

    await act(async () => {
      await result.current.reject([CHANGE]);
    });

    expect(reserveOperation).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("overleaf_reject_changes", {
      projectRoot: "/tmp/project",
      docId: "doc-1",
      version: 19,
      changes: [CHANGE],
    });
  });

  it("marks a failed reserved reject as outcome unknown for reconciliation", async () => {
    const failure = new Error("ack lost");
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_change_authors") return [];
      if (command === "overleaf_reject_changes") throw failure;
      return undefined;
    });
    const noteReservedOperationUnknown = vi.fn();
    // Simulate the visible document changing while the request is in flight:
    // the reservation remains authoritative for both the request and failure.
    const reserveOperation = vi.fn(() => ({ docId: "doc-before-switch", version: 12 }));
    const { result } = mount({ noteReservedOperationUnknown, reserveOperation });

    await act(async () => {
      await expect(result.current.reject([CHANGE])).rejects.toThrow("ack lost");
    });

    expect(noteReservedOperationUnknown).toHaveBeenCalledWith(
      { docId: "doc-before-switch", version: 12 },
      failure,
    );
    expect(invoke).toHaveBeenCalledWith("overleaf_reject_changes", {
      projectRoot: "/tmp/project",
      docId: "doc-before-switch",
      version: 12,
      changes: [CHANGE],
    });
  });
});
