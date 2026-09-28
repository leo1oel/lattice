import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mockInvoke, type CommandTable } from "../platform/tauri-test-mocks";
import { useOverleafTrackChanges } from "./use-overleaf-track-changes";
import type { TrackedChange } from "./use-overleaf-realtime";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const CHANGE: TrackedChange = { id: "change-1", position: 2, text: "new", deletion: false, userId: "author-1", timestamp: null, hue: 100 };

type Options = Parameters<typeof useOverleafTrackChanges>[0];

/** Mount on doc-1 (`rerender` takes the next doc id) with a fresh `invoke` answering `commands`. */
function mount(overrides: Partial<Options> = {}, commands: CommandTable = {}) {
  vi.mocked(invoke).mockReset();
  mockInvoke({ overleaf_change_authors: [], overleaf_accept_changes: undefined, overleaf_reject_changes: undefined, ...commands });
  return renderHook((docId: string) => useOverleafTrackChanges({
    enabled: true,
    projectRoot: "/tmp/project",
    docId,
    settledVersion: () => 12,
    reserveOperation: () => ({ docId, version: 12 }),
    noteReservedOperationUnknown: () => undefined,
    changes: [CHANGE],
    canAct: true,
    reload: vi.fn(),
    ...overrides,
  }), { initialProps: "doc-1" });
}

describe("accepting tracked changes", () => {
  it("refuses to accept while an OT operation is still pending, without reserving the wire", async () => {
    const settledVersion = vi.fn(() => null);
    const reserveOperation = vi.fn(() => ({ docId: "doc-1", version: 12 }));
    const { result } = mount({ settledVersion, reserveOperation });
    await act(async () => {
      await expect(result.current.accept([CHANGE.id])).rejects.toThrow(/edit is still on its way/i);
    });
    expect(settledVersion).toHaveBeenCalledOnce();
    // Accept is a REST mutation: an empty OT reservation could never be acknowledged.
    expect(reserveOperation).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("overleaf_accept_changes", expect.anything());
  });

  it("accepts once the document is settled, and reloads it", async () => {
    const reload = vi.fn();
    const { result } = mount({ reload });
    await act(() => result.current.accept([CHANGE.id]));
    expect(invoke).toHaveBeenCalledWith("overleaf_accept_changes", { projectRoot: "/tmp/project", docId: "doc-1", changeIds: [CHANGE.id] });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload a different document after an accept finishes", async () => {
    let finishAccept!: () => void;
    const reload = vi.fn();
    const { result, rerender } = mount({ reload }, {
      overleaf_accept_changes: () => new Promise<void>((resolve) => { finishAccept = resolve; }),
    });
    let request: Promise<void> | undefined;
    act(() => { request = result.current.accept([CHANGE.id]); });
    rerender("doc-2");
    await act(async () => {
      finishAccept();
      await request;
    });
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("rejecting tracked changes", () => {
  it("reserves the OT wire at the current version, sends the full changes, and reloads", async () => {
    const reserveOperation = vi.fn(() => ({ docId: "doc-1", version: 19 }));
    const reload = vi.fn();
    const { result } = mount({ reserveOperation, reload });
    await act(() => result.current.reject([CHANGE]));
    expect(reserveOperation).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("overleaf_reject_changes", { projectRoot: "/tmp/project", docId: "doc-1", version: 19, changes: [CHANGE] });
    expect(reload).toHaveBeenCalledOnce();
  });

  it("refuses to reject while one of our own edits is still unacknowledged", async () => {
    // A second operation built on a version the server has not confirmed
    // would apply against the wrong history.
    const { result } = mount({ reserveOperation: () => null });
    await act(async () => {
      await expect(result.current.reject([CHANGE])).rejects.toThrow(/still on its way/);
    });
    expect(invoke).not.toHaveBeenCalledWith("overleaf_reject_changes", expect.anything());
  });

  it("marks a failed reserved reject as outcome unknown, keyed on the reservation", async () => {
    const failure = new Error("ack lost");
    const noteReservedOperationUnknown = vi.fn();
    // The reservation stays authoritative even if the visible document changed meanwhile.
    const { result } = mount({
      noteReservedOperationUnknown,
      reserveOperation: () => ({ docId: "doc-before-switch", version: 12 }),
    }, { overleaf_reject_changes: () => { throw failure; } });
    await act(async () => {
      await expect(result.current.reject([CHANGE])).rejects.toThrow("ack lost");
    });
    expect(noteReservedOperationUnknown).toHaveBeenCalledWith({ docId: "doc-before-switch", version: 12 }, failure);
    expect(invoke).toHaveBeenCalledWith("overleaf_reject_changes", {
      projectRoot: "/tmp/project", docId: "doc-before-switch", version: 12, changes: [CHANGE],
    });
  });
});

describe("permission and authors", () => {
  it("refuses to act for a read-only account, rather than calling Overleaf and failing there", async () => {
    const reload = vi.fn();
    // No changes, so the author lookup (keyed on the changes that exist) makes
    // no call of its own to muddy the assertion.
    const { result } = mount({ canAct: false, changes: [], reload });
    await act(async () => {
      await expect(result.current.accept([CHANGE.id])).rejects.toThrow(/cannot accept or reject/);
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/cannot accept or reject/);
  });

  it("looks up author names from overleaf_change_authors, snake_case fields and all", async () => {
    const { result } = mount({ changes: [CHANGE, { ...CHANGE, id: "change-2", userId: "author-2" }] }, {
      overleaf_change_authors: [
        { id: "author-1", email: "ada@example.edu", first_name: "Ada", last_name: "Lovelace" },
        { id: "author-2", email: "sam@example.edu" },
      ],
    });
    await waitFor(() => expect(result.current.authorName("author-1")).toBe("Ada Lovelace"));
    expect(result.current.authorName("author-2")).toBe("sam");
    expect(result.current.authorName("author-3")).toBe("Unknown");
    expect(result.current.authorName(null)).toBe("Unknown");
  });
});
