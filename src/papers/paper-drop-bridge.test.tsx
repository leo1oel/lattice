import { act, cleanup, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginPaperDrag, resolvePaperDrag } from "./paper-drag";
import { usePaperDropRouting, type PaperDropLibrary } from "./paper-drop-bridge";

const native = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  emitTo: vi.fn(async () => {}),
  cleanup: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, callback: (event: { payload: unknown }) => void) => {
    native.listeners.set(event, callback);
    return native.cleanup;
  }),
  emitTo: native.emitTo,
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async (callback: (event: { payload: unknown }) => void) => {
  native.listeners.set("native-drop", callback);
  return native.cleanup;
} }) }));
const state: PaperDropLibrary = {
  projectRoot: "/projects/Research", papers: [
    { arxivId: "1706.03762", title: "Attention Is All You Need", authors: "Vaswani et al.", citationKey: "vaswani2017", hasFullText: true, hasBlog: false },
    { arxivId: "", title: "Cited reference", citationKey: "smith2020", hasFullText: false, hasBlog: false },
  ],
};
const identity = { projectRoot: state.projectRoot, arxivId: state.papers[0].arxivId, citationKey: state.papers[0].citationKey };
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); native.listeners.clear(); });
const send = (event: string, payload: unknown) => act(() => native.listeners.get(event)?.({ payload }));

describe("paper drop bridge", () => {
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
    renderHook(() => usePaperDropRouting(state, 1.25, vi.fn(), vi.fn()));
    await waitFor(() => expect(native.listeners.has("native-drop")).toBe(true));
    const start = () => send("paper-native-drag", { id: "drag-1", paper: identity });
    const enter = (paths: string[] = []) => send("native-drop", { type: "enter", paths, position: { x: 115, y: 197.5 } });
    const drop = (paths: string[] = []) => send("native-drop", { type: "drop", paths, position: { x: 115, y: 197.5 } });
    start(); enter();
    // WebKit can deliver source dragend before Tauri forwards the target drop.
    send("paper-native-drag", { id: "drag-1", paper: null });
    drop();
    expect(received).toHaveBeenCalledOnce();
    expect(hitTest).toHaveBeenLastCalledWith(92, 158);
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

  it("sends the drag identity and matching dragend to its own window's bridge", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const values = new Map<string, string>();
    const data = { setData: (key: string, value: string) => values.set(key, value) } as unknown as DataTransfer;
    beginPaperDrag(data, state.projectRoot, state.papers[0]);
    expect(native.emitTo).toHaveBeenLastCalledWith("main", "paper-native-drag", { id: expect.any(String), paper: identity });
    const id = (native.emitTo.mock.lastCall as unknown as [string, string, { id: string }])[2].id;
    window.dispatchEvent(new Event("dragend"));
    await waitFor(() => expect(native.emitTo).toHaveBeenLastCalledWith("main", "paper-native-drag", { id, paper: null }));
  });

  it("opens a dropped paper only on document panels and the titlebar", () => {
    const open = vi.fn();
    renderHook(() => usePaperDropRouting(state, 1, open, vi.fn()));
    document.body.innerHTML = `
      <div class="titlebar-main"></div>
      <div class="lattice-trellis">
        ${["file", "pdf", "project", "papers", "agent", "history", "git", "comments", "todos", "checklist", "literature", "overleaf"].map((type) => `
          <div data-trellis-part="tab" data-type="${type}"><span id="tab-${type}"></span></div>
          <div data-trellis-part="surface" data-type="${type}"><div id="${type}"></div></div>`).join("")}
      </div>`;
    const values = new Map<string, string>();
    const dataTransfer = {
      get types() { return [...values.keys()]; },
      setData: (type: string, value: string) => { values.set(type, value); },
      getData: (type: string) => values.get(type) ?? "",
    };
    beginPaperDrag(dataTransfer as unknown as DataTransfer, state.projectRoot, state.papers[0]);
    const accepts = (selector: string) => {
      open.mockClear();
      const drop = fireEvent.drop(document.querySelector(selector)!, { dataTransfer });
      const over = fireEvent.dragOver(document.querySelector(selector)!, { dataTransfer });
      return { opened: open.mock.calls.length === 1, dropHandled: !drop, overHandled: !over };
    };
    for (const selector of ["#file", "#tab-file", "#pdf", ".titlebar-main"]) {
      expect(accepts(selector), selector).toEqual({ opened: true, dropHandled: true, overHandled: true });
    }
    for (const type of ["project", "papers", "agent", "history", "git", "comments", "todos", "checklist", "literature", "overleaf"]) {
      expect(accepts(`#${type}`), type).toEqual({ opened: false, dropHandled: false, overHandled: false });
      expect(accepts(`#tab-${type}`), `${type} tab`).toEqual({ opened: false, dropHandled: false, overHandled: false });
    }
    document.body.innerHTML = "";
  });

  it("opens through the latest library and releases its listeners on unmount", async () => {
    const open = vi.fn();
    const hook = renderHook(({ library }) => usePaperDropRouting(library, 1, open, vi.fn()), { initialProps: { library: state } });
    await waitFor(() => expect(native.listeners.has("native-drop")).toBe(true));
    const values = new Map<string, string>();
    const dataTransfer = {
      get types() { return [...values.keys()]; },
      setData: (type: string, value: string) => { values.set(type, value); },
      getData: (type: string) => values.get(type) ?? "",
    };
    beginPaperDrag(dataTransfer as unknown as DataTransfer, state.projectRoot, state.papers[0]);
    document.body.innerHTML = `<div class="titlebar-main"></div>`;
    fireEvent.drop(document.querySelector(".titlebar-main")!, { dataTransfer });
    expect(open).toHaveBeenCalledWith(state.papers[0]);
    // A drag from the previous project resolves against today's library only.
    hook.rerender({ library: { projectRoot: "/new-project", papers: [] } });
    fireEvent.drop(document.querySelector(".titlebar-main")!, { dataTransfer });
    expect(open).toHaveBeenCalledTimes(1);
    hook.unmount();
    await waitFor(() => expect(native.cleanup).toHaveBeenCalledTimes(2));
    document.body.innerHTML = "";
  });
});
