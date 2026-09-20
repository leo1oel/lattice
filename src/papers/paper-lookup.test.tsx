import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PaperLookup from "./paper-lookup";
import { beginPaperDrag, resolvePaperDrag } from "./paper-drag";
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
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async (callback: (event: { payload: unknown }) => void) => {
  native.listeners.set("native-drop", callback);
  return native.cleanup;
} }) }));
const state: PaperLookupState = {
  projectRoot: "/projects/Research", theme: "light", papers: [
    { arxivId: "1706.03762", title: "Attention Is All You Need", authors: "Vaswani et al.", citationKey: "vaswani2017", hasFullText: true, hasBlog: false },
    { arxivId: "", title: "Cited reference", citationKey: "smith2020", hasFullText: false, hasBlog: false },
  ],
};
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); native.listeners.clear(); });
const send = (event: string, payload: unknown) => act(() => native.listeners.get(event)?.({ payload }));

describe("paper lookup", () => {
  it("relays an intercepted native paper drop without consuming Finder files or cancelled drags", async () => {
    vi.stubGlobal("DataTransfer", class {
      values = new Map<string, string>();
      get types() { return [...this.values.keys()]; }
      setData(type: string, value: string) { this.values.set(type, value); }
      getData(type: string) { return this.values.get(type) ?? ""; }
    });
    vi.stubGlobal("DragEvent", class extends Event {
      constructor(type: string, init: DragEventInit) { super(type, init); Object.assign(this, { dataTransfer: init.dataTransfer, clientX: init.clientX, clientY: init.clientY }); }
    });
    vi.stubGlobal("devicePixelRatio", 2);
    const target = document.createElement("div");
    const received = vi.fn();
    target.addEventListener("drop", received);
    const hitTest = vi.fn(() => target);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hitTest });
    renderHook(() => usePaperLookup(state, vi.fn(), vi.fn()));
    await waitFor(() => expect(native.listeners.has("native-drop")).toBe(true));
    const identity = { projectRoot: state.projectRoot, arxivId: state.papers[0].arxivId, citationKey: state.papers[0].citationKey };
    const start = () => send("paper-native-drag", { id: "drag-1", paper: identity });
    const enter = (paths: string[] = []) => send("native-drop", { type: "enter", paths, position: { x: 92, y: 158 } });
    const drop = (paths: string[] = []) => send("native-drop", { type: "drop", paths, position: { x: 92, y: 158 } });
    start(); enter();
    // WebKit can deliver source dragend before Tauri forwards the target drop.
    send("paper-native-drag", { id: "drag-1", paper: null });
    drop();
    expect(received).toHaveBeenCalledOnce();
    expect(hitTest).toHaveBeenLastCalledWith(46, 79);
    const event = received.mock.calls[0][0] as DragEvent;
    expect(resolvePaperDrag(event.dataTransfer, state.projectRoot, state.papers)).toBe(state.papers[0]);
    drop(); // One native drop must never insert twice.
    enter(); drop(); // An unrelated external text drag after dragend is not a paper.
    start(); enter(["/tmp/figure.png"]); drop(["/tmp/figure.png"]);
    start(); enter(); send("native-drop", { type: "leave" }); drop();
    expect(received).toHaveBeenCalledOnce();
    enter(); start(); drop(); // Native enter can arrive before source IPC.
    expect(received).toHaveBeenCalledTimes(2);
    send("paper-native-drag", { id: "other-project", paper: { ...identity, projectRoot: "/other" } });
    enter(); drop();
    expect(received).toHaveBeenCalledTimes(2);
    delete (document as Partial<Document>).elementFromPoint;
  });

  it("sends the drag identity and matching dragend to the lookup's owner", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const values = new Map<string, string>();
    const data = { setData: (key: string, value: string) => values.set(key, value) } as unknown as DataTransfer;
    beginPaperDrag(data, state.projectRoot, state.papers[0], "project-2");
    const identity = { projectRoot: state.projectRoot, arxivId: state.papers[0].arxivId, citationKey: state.papers[0].citationKey };
    expect(native.emitTo).toHaveBeenLastCalledWith("project-2", "paper-native-drag", { id: expect.any(String), paper: identity });
    const id = (native.emitTo.mock.lastCall as unknown as [string, string, { id: string }])[2].id;
    window.dispatchEvent(new Event("dragend"));
    await waitFor(() => expect(native.emitTo).toHaveBeenLastCalledWith("project-2", "paper-native-drag", { id, paper: null }));
  });

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
    await waitFor(() => expect(native.cleanup).toHaveBeenCalledTimes(4));
  });
});
