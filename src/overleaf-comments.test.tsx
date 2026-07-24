import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { OverleafCommentsPanel } from "./overleaf-comments";
import { useOverleafComments } from "./use-overleaf-comments";
import type { OverleafThread } from "./app-types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

function thread(overrides: Partial<OverleafThread> = {}): OverleafThread {
  return {
    id: "t1",
    messages: [{
      id: "c1",
      content: "This claim needs a citation",
      authorName: "Ada Lovelace",
      authorEmail: "ada@example.edu",
      timestamp: 1_700_000_000_000,
      mine: false,
    }],
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    ...overrides,
  };
}

const anchors = new Map([["t1", { position: 42, quote: "state of the art" }]]);

function panel(overrides: Partial<Parameters<typeof OverleafCommentsPanel>[0]> = {}) {
  return (
    <OverleafCommentsPanel
      threads={[thread()]}
      anchors={anchors}
      documentOpen
      loading={false}
      error={null}
      onReply={vi.fn().mockResolvedValue(undefined)}
      onResolve={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
      onReveal={vi.fn()}
      {...overrides}
    />
  );
}

describe("Overleaf comments panel", () => {
  beforeEach(cleanup);

  it("quotes the commented span and reveals it when clicked", () => {
    const onReveal = vi.fn();
    render(panel({ onReveal }));
    expect(screen.getByText("This claim needs a citation")).toBeInTheDocument();
    expect(screen.getByText("In this file")).toBeInTheDocument();
    fireEvent.click(screen.getByText("state of the art"));
    expect(onReveal).toHaveBeenCalledWith(42);
  });

  it("replies on Enter and resolves through the callbacks", async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(panel({ onReply, onResolve }));

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const box = screen.getByLabelText("Reply");
    fireEvent.change(box, { target: { value: "added it" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onReply).toHaveBeenCalledWith("t1", "added it"));

    fireEvent.click(await screen.findByRole("button", { name: /Resolve/ }));
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith("t1", true));
  });

  it("hides resolved threads until asked, and cannot act without the file open", () => {
    render(panel({
      threads: [thread({ id: "t2", resolved: true, resolvedBy: "Leo" })],
      anchors: new Map(),
      documentOpen: false,
    }));
    expect(screen.queryByText("This claim needs a citation")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Include resolved/ }));
    expect(screen.getByText("This claim needs a citation")).toBeInTheDocument();
    // No anchor for it, so it is filed under the rest of the project.
    expect(screen.getByText("Elsewhere in the project")).toBeInTheDocument();
    expect(screen.getByText(/Resolved by Leo/)).toBeInTheDocument();
    // Overleaf keys resolve and delete on the document, which is not open.
    expect(screen.getByRole("button", { name: /Reopen/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Delete/ })).toBeDisabled();
  });
});

describe("useOverleafComments", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    vi.mocked(listen).mockResolvedValue(() => {});
  });

  it("re-reads the threads when the channel says one changed", async () => {
    let emit: ((event: { payload: unknown }) => void) | null = null;
    vi.mocked(listen).mockImplementation(async (_name, handler) => {
      emit = handler as (event: { payload: unknown }) => void;
      return () => {};
    });
    let served: OverleafThread[] = [thread()];
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_threads") return served;
      throw new Error(`Unexpected command: ${command}`);
    });

    const { result } = renderHook(() => useOverleafComments({
      enabled: true,
      docId: "doc-1",
      anchored: ["t1"],
    }));
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    expect(result.current.openCount).toBe(1);

    served = [thread(), thread({ id: "t2" })];
    await act(async () => {
      emit?.({ payload: { type: "threadsChanged" } });
      // The re-read is debounced so a burst costs one request.
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(result.current.threads).toHaveLength(2);
    // Only threads anchored in the open document count as open here.
    expect(result.current.openCount).toBe(1);
  });

  it("refuses to resolve when no document is open, rather than failing silently", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_threads") return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    const { result } = renderHook(() => useOverleafComments({
      enabled: true,
      docId: null,
      anchored: [],
    }));
    await act(async () => {
      await expect(result.current.setResolved("t1", true)).rejects.toThrow(/Open the file/);
    });
    expect(result.current.error).toMatch(/Open the file/);
    expect(invoke).not.toHaveBeenCalledWith("overleaf_resolve_thread", expect.anything());
  });
});
