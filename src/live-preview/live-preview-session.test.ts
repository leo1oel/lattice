import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { LivePreviewSession } from "./live-preview-session";
import type { Item } from "./rtex-protocol";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
}));
vi.mock("../pdf/pdfjs-runtime", () => ({ getDocument: vi.fn() }));

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let events: { onmessage: (message: unknown) => void } | null;
let batches: string[][];
let sendGate: Deferred<void> | null;
let reads: Map<string, Deferred<string>[]>;

beforeEach(() => {
  events = null;
  batches = [];
  sendGate = null;
  reads = new Map();
  vi.mocked(invoke).mockReset().mockImplementation(async (command: string, args?: unknown) => {
    const payload = args as Record<string, unknown>;
    if (command === "live_preview_start") {
      events = payload.onEvent as typeof events;
      return 7;
    }
    if (command === "live_preview_send") {
      batches.push((payload.commands as string[]).map((line) => JSON.parse(line).cmd + (JSON.parse(line).text ? `:${JSON.parse(line).text}` : "")));
      if (sendGate) await sendGate.promise;
      return null;
    }
    if (command === "read_project_file") {
      const read = deferred<string>();
      const path = payload.path as string;
      reads.set(path, [...(reads.get(path) ?? []), read]);
      return read.promise;
    }
    return null;
  });
});

afterEach(() => vi.useRealTimers());

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const reply = (message: unknown) => events?.onmessage(message);
const editReply = (revision: number) => reply({
  reply: "edit", result: { edit_id: revision, source_revision: revision, outcome: { touched: [], added: [], removed: [] }, routed: "fast", reasons: [] },
});

describe("a live preview session", () => {
  it("asks for rtex's starting revision before any edit, and sends edits in the order they were made", async () => {
    const session = new LivePreviewSession("/project", "main.tex");
    // Typed while rtex is still starting: queued behind the status request.
    session.noteText("main.tex", "Hello, world", "Hello world");
    await session.start();
    await flush();
    expect(batches.flat()).toEqual(["status", "edit:,"]);
    // One batch at a time: what is typed while one is being written waits for it.
    sendGate = deferred();
    session.noteText("main.tex", "Hello, world!", "Hello world");
    await flush();
    session.noteText("main.tex", "Hello, world!?", "Hello world");
    await flush();
    expect(batches.slice(1)).toEqual([["edit:!"]]);
    sendGate.resolve();
    await flush();
    expect(batches.slice(1)).toEqual([["edit:!"], ["edit:?"]]);
    session.dispose();
  });

  it("drops a file read that a newer change of the same file overtook", async () => {
    const session = new LivePreviewSession("/project", "main.tex");
    await session.start();
    session.noteFilesChanged(["chapter.tex"], []);
    session.noteFilesChanged(["chapter.tex"], []);
    const [older, newer] = reads.get("chapter.tex")!;
    newer.resolve("pulled from Overleaf");
    await flush();
    older.resolve("an earlier save");
    await flush();
    expect(batches.flat()).toEqual(["status", "set_document:pulled from Overleaf"]);
    session.dispose();
  });

  it("stops painting edits once the PDF on screen was built from them", async () => {
    const session = new LivePreviewSession("/project", "main.tex");
    await session.start();
    reply({ reply: "status", versions: { source_revision: 1, context_revision: 0, engine_generation: 0, layout_version: 0 }, convergence: null });
    session.noteText("main.tex", "ab", "a");
    await flush();
    editReply(2);
    // Saved, then built: the build compiled revision 2.
    session.noteSaved();
    const token = session.buildStarted();
    session.noteText("main.tex", "abc", "ab");
    await flush();
    editReply(3);
    reply({
      event: "ParagraphUpdate", par_id: 1, edit_id: 3, versions: { source_revision: 3, context_revision: 0, engine_generation: 0, layout_version: 1 },
      status: "ok", reasons: [], fragments: [], pagination_stale: false, context_stale: false,
      dl: { kind: "paragraph", fonts: {}, lines: [], other: [], flags: [], width: 0, height: 0, depth: 0 },
      diagnostics: [], timing: { total_us: 1, tex_us: 1, traverse_us: 0, pack_us: 0 },
    });
    expect(session.model.overlays.has(1)).toBe(true);
    // The PDF is still loading: the edit stays painted over the old one.
    session.baseLoading(token);
    expect(session.model.baseRevision).toBe(1);
    session.basePromoted();
    expect(session.model.baseRevision).toBe(2);
    // Revision 3 came after the build: still painted.
    expect(session.model.overlays.has(1)).toBe(true);
    session.dispose();
  });

  it("waits for the layout instead of painting a live paragraph set in none of its unit's fonts", async () => {
    const session = new LivePreviewSession("/project", "main.tex");
    await session.start();
    reply({ reply: "status", versions: { source_revision: 1, context_revision: 0, engine_generation: 0, layout_version: 0 }, convergence: null });
    const fonts = { "1": { id: 1, name: "ec-lmss9" }, "2": { id: 2, name: "t1-stixgeneral" } };
    const row = (font: number) => ({ unit: 4, x: 0, y: 100, w: 10, h: 7, d: 2, items: [["g", font, 65, null, 0, 0, 0, 0] as Item] });
    session.model.applyLayout({
      pages: [{ page: 1, exact: true, hash: 1, dl: { kind: "page", fonts, lines: [row(1)], other: [], flags: [], width: 0, height: 0, depth: 0 } }],
      pagesTotal: 1,
      placements: [{ par_id: 8, fragments: [{ page: 1, first_line: 1, last_line: 1, x: 0, xs: [0], baselines: [100], approximate: false }], lines: 1, kind: "par" }],
      revision: 1,
      layoutVersion: 1,
      hasFallback: false,
    });
    const paragraph = (revision: number, font: number) => reply({
      event: "ParagraphUpdate", par_id: 8, edit_id: revision, versions: { source_revision: revision, context_revision: 0, engine_generation: 0, layout_version: 1 },
      status: "ok", reasons: [], fragments: [], pagination_stale: false, context_stale: false,
      dl: { kind: "paragraph", fonts, lines: [{ ...row(font), y: 7 }], other: [], flags: [], width: 0, height: 0, depth: 0 },
      diagnostics: [], timing: { total_us: 1, tex_us: 1, traverse_us: 0, pack_us: 0 },
    });
    paragraph(2, 1);
    expect(session.model.overlays.has(8)).toBe(true);
    expect(session.getSnapshot().layoutPending).toBe(false);
    paragraph(3, 2);
    expect(session.model.overlays.get(8)?.revision).toBe(2);
    expect(session.getSnapshot().layoutPending).toBe(true);
    session.dispose();
  });

  it("reports a quiet build until the PDF it made is on screen", async () => {
    const session = new LivePreviewSession("/project", "main.tex");
    await session.start();
    const token = session.buildStarted(true);
    expect(session.getSnapshot().rebuilding).toBe(true);
    session.baseLoading(token, true);
    session.buildFinished();
    expect(session.getSnapshot().rebuilding).toBe(true);
    session.basePromoted();
    expect(session.getSnapshot().rebuilding).toBe(false);
    // A build the writer asked for shows itself: the session does not report it.
    session.baseLoading(session.buildStarted(), false);
    expect(session.getSnapshot().rebuilding).toBe(false);
    session.dispose();
  });

  it("reports rtex stopping on its own", async () => {
    const session = new LivePreviewSession("/project", "main.tex");
    await session.start();
    reply({ event: "SessionExited", session: 7, stderr: "lualatex not found" });
    expect(session.getSnapshot()).toMatchObject({ phase: "error", detail: "lualatex not found" });
    session.dispose();
  });
});
