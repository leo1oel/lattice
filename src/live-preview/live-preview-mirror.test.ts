import { describe, expect, it, vi } from "vitest";
import { applyModelOp, LivePreviewAssets } from "./live-preview-assets";
import { LivePreviewMirror, LivePreviewRelay, type LivePreviewRelayMessage } from "./live-preview-mirror";
import type { LivePreviewModelChange, LivePreviewSession } from "./live-preview-session";
import { PreviewModel, type ModelOp } from "./rtex-model";
import type { DisplayList, Fragment, Line, PageUpdate } from "./rtex-protocol";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => new ArrayBuffer(0)) }));
vi.mock("../pdf/pdfjs-runtime", () => ({ getDocument: vi.fn() }));

const U = 65536;
const line = (x: number, y: number): Line => ({ x: x * U, y: y * U, w: 100 * U, h: 7 * U, d: 2 * U, items: [] });
const dl = (lines: Line[]): DisplayList => ({ kind: "page", fonts: {}, lines, other: [], flags: [], width: 0, height: 0, depth: 0, page_width: 600, page_height: 800 });
const page = (n: number, lines: Line[]): PageUpdate => ({ page: n, exact: true, hash: n, dl: dl(lines) });
const frag = (pageNumber: number, baselines: number[]): Fragment => ({
  page: pageNumber, first_line: 1, last_line: baselines.length, x: 10 * U, xs: baselines.map(() => 10 * U), baselines: baselines.map((v) => v * U), approximate: false,
});
const placements = [{ par_id: 5, fragments: [frag(1, [112, 124])], lines: 2, kind: "par" }];
const layout = (revision: number): ModelOp => ({
  op: "layout",
  input: { pages: [page(1, [line(10, 100), line(10, 112), line(10, 124)])], pagesTotal: 1, placements, revision, layoutVersion: revision, hasFallback: false },
});

/** The session's side of the relay: its model, changed as the session changes it. */
function fakeSession() {
  const model = new PreviewModel();
  const assets = new LivePreviewAssets(async () => new Uint8Array(), () => {});
  const listeners = new Set<(change: LivePreviewModelChange) => void>();
  const session = {
    model,
    subscribeModel: (listener: (change: LivePreviewModelChange) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mirrorStart: () => ({ projectRoot: "/paper", session: 7, model: model.snapshot(), fallback: null }),
  } as unknown as LivePreviewSession;
  const make = (change: ModelOp) => {
    applyModelOp(model, assets, change);
    for (const listener of listeners) listener({ change, fallback: null });
  };
  return { session, model, make };
}

function owner() {
  return { basePromoted: vi.fn(), waitForLayout: vi.fn(), resync: vi.fn() };
}

/** Let the relay's microtask and its chain of sends run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the live preview in the PDF's separate window", () => {
  it("draws the session's model: as it was when the window opened, then each change in order", async () => {
    const { session, model, make } = fakeSession();
    make({ op: "loaded", revision: 1 });
    make(layout(1));
    const mirror = new LivePreviewMirror(owner());
    const pages = vi.fn();
    mirror.subscribePages(pages);
    // What crosses to the window is JSON, as Tauri's events carry it.
    const relay = new LivePreviewRelay(session, async (message) => mirror.receive(JSON.parse(JSON.stringify(message)) as LivePreviewRelayMessage));
    await settle();
    expect(mirror.model.snapshot()).toEqual(model.snapshot());

    // Typing: a live paragraph, a second keystroke's, then a layout and the build's PDF taking over.
    make({ op: "paragraph", parId: 5, dl: dl([line(0, 7), line(0, 19)]), fragments: [frag(1, [112, 124])], revision: 2 });
    make({ op: "paragraph", parId: 5, dl: dl([line(0, 7), line(0, 19)]), fragments: [frag(1, [112, 124])], revision: 3 });
    await settle();
    expect(mirror.model.overlaysOn(1)).toEqual(model.overlaysOn(1));
    expect(mirror.model.hiddenLines(1)).toEqual(new Set([1, 2]));
    make(layout(3));
    make({ op: "base", revision: 3 });
    await settle();
    expect(mirror.model.snapshot()).toEqual(model.snapshot());
    expect(mirror.model.overlaysOn(1)).toEqual([]);
    expect(pages).toHaveBeenCalledWith("all");

    // Live preview stopped: nothing drawn over the window's pages.
    relay.dispose();
    await settle();
    expect(mirror.model.pages.size).toBe(0);
  });

  it("asks to start again after a change it cannot place, and does not hear a replaced relay", () => {
    const asks = owner();
    const mirror = new LivePreviewMirror(asks);
    const changes = (stream: number, seq: number): LivePreviewRelayMessage => ({
      kind: "changes", stream, seq, changes: [{ change: { op: "drop" }, fallback: null }],
    });
    // Opened after the start went out: the first change it hears is the second.
    mirror.receive(changes(3, 2));
    mirror.receive(changes(3, 3));
    expect(asks.resync).toHaveBeenCalledOnce();

    const start = (stream: number): LivePreviewRelayMessage => ({
      kind: "start", stream, start: { projectRoot: "/paper", session: 7, model: new PreviewModel().snapshot(), fallback: null },
    });
    mirror.receive(start(4));
    mirror.receive(changes(4, 1));
    // The relay of a session since replaced, heard late.
    mirror.receive({ kind: "off", stream: 2 });
    mirror.receive(changes(3, 4));
    expect(asks.resync).toHaveBeenCalledOnce();
    mirror.receive(changes(4, 3));
    expect(asks.resync).toHaveBeenCalledTimes(2);
  });

  it("hands what only the session can do back to the workspace", () => {
    const asks = owner();
    const mirror = new LivePreviewMirror(asks);
    mirror.basePromoted();
    mirror.waitForLayout();
    expect(asks.basePromoted).toHaveBeenCalledOnce();
    expect(asks.waitForLayout).toHaveBeenCalledOnce();
  });
});
