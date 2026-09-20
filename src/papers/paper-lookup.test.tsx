import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PaperLookup from "./paper-lookup";
import { PAPER_LOOKUP_OPEN, PAPER_LOOKUP_READY, PAPER_LOOKUP_STATE, usePaperLookup, type PaperLookupState } from "./use-paper-lookup";

const native = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  emitTo: vi.fn(async () => {}),
  pin: vi.fn(async (_value: boolean) => {}),
  focus: vi.fn(async () => {}),
  cleanup: vi.fn(),
  invoke: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, callback: (event: { payload: unknown }) => void) => {
    native.listeners.set(event, callback);
    return native.cleanup;
  }),
  emitTo: native.emitTo,
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main", setAlwaysOnTop: native.pin, setFocus: native.focus }) }));
const state: PaperLookupState = {
  projectRoot: "/projects/Research", theme: "light", papers: [
    { arxivId: "1706.03762", title: "Attention Is All You Need", authors: "Vaswani et al.", citationKey: "vaswani2017", hasFullText: true, hasBlog: false },
    { arxivId: "", title: "Cited reference", citationKey: "smith2020", hasFullText: false, hasBlog: false },
  ],
};
afterEach(() => { cleanup(); vi.clearAllMocks(); native.listeners.clear(); });
const send = (event: string, payload: unknown) => act(() => native.listeners.get(event)?.({ payload }));

describe("paper lookup", () => {
  it("opens through the constrained native command and reports creation failures", async () => {
    const error = vi.fn();
    const hook = renderHook(() => usePaperLookup(state, vi.fn(), error));
    await act(() => hook.result.current());
    expect(native.invoke).toHaveBeenCalledWith("open_paper_lookup", { title: "Paper lookup" });
    native.invoke.mockRejectedValueOnce(new Error("Could not create window"));
    await act(() => hook.result.current());
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: "Could not create window" }));
  });

  it("handshakes before receiving the library, filters, reads in the owner, and toggles global pinning", async () => {
    render(<PaperLookup owner="project-2" />);
    await waitFor(() => expect(native.emitTo).toHaveBeenCalledWith("project-2", PAPER_LOOKUP_READY));
    send(PAPER_LOOKUP_STATE, state);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "vaswani need" } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Attention Is All/ }));
    expect(native.emitTo).toHaveBeenCalledWith("project-2", PAPER_LOOKUP_OPEN, { projectRoot: state.projectRoot, arxivId: "1706.03762", citationKey: "vaswani2017" });
    const pin = screen.getByRole("button", { name: "Keep on top" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(pin);
    await waitFor(() => expect(pin).toHaveAttribute("aria-pressed", "true"));
    expect(native.pin).toHaveBeenLastCalledWith(true);
    fireEvent.click(pin);
    await waitFor(() => expect(pin).toHaveAttribute("aria-pressed", "false"));
    expect(native.pin).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no-match" } });
    expect(screen.getByText("No matching papers")).toBeVisible();
  });

  it("publishes current state and rejects stale project requests without opening a paper", async () => {
    const open = vi.fn();
    const error = vi.fn();
    const hook = renderHook(({ library }) => usePaperLookup(library, open, error), { initialProps: { library: state } });
    send(PAPER_LOOKUP_READY, undefined);
    expect(native.emitTo).toHaveBeenLastCalledWith("paper-lookup-main", PAPER_LOOKUP_STATE, state);
    send(PAPER_LOOKUP_OPEN, { projectRoot: state.projectRoot, ...state.papers[0] });
    expect(open).toHaveBeenCalledWith(state.papers[0]);
    hook.rerender({ library: { ...state, projectRoot: "/new-project", papers: [] } });
    send(PAPER_LOOKUP_OPEN, { projectRoot: state.projectRoot, ...state.papers[0] });
    expect(open).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    hook.unmount();
    await waitFor(() => expect(native.cleanup).toHaveBeenCalledTimes(2));
  });
});
