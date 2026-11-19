/**
 * The live preview in the compiled PDF's separate window (#1177). rtex runs
 * for the workspace window, whose session (live-preview-session.ts) owns the
 * model; the separate window keeps a copy of that model and draws it with the
 * same layer (live-preview-layer.tsx) over its own viewer.
 *
 * The workspace side, LivePreviewRelay, sends the model as it is once
 * ("start"), then every change the session makes, in order ("changes"),
 * numbered within that start's stream. The window side, LivePreviewMirror,
 * replays them through the same applyModelOp, so both draw the same pages;
 * it reads fonts, images and fallback PDFs from the same rtex session
 * itself. A change it cannot place (a stream it never saw start, or a gap)
 * asks the workspace to start it again rather than drawing a model that has
 * drifted. What only the session can do (a new base PDF on the window's
 * screen, a layout to wait for) goes back as a window action.
 */
import { invoke } from "@tauri-apps/api/core";
import { applyModelOp, LivePreviewAssets } from "./live-preview-assets";
import type { LivePreviewSurface } from "./live-preview-context";
import type { LivePreviewMirrorStart, LivePreviewModelChange, LivePreviewSession } from "./live-preview-session";
import { PreviewModel } from "./rtex-model";

export type LivePreviewRelayMessage =
  /** Live preview stopped: draw nothing over the PDF. */
  | { kind: "off"; stream: number }
  | { kind: "start"; stream: number; start: LivePreviewMirrorStart }
  | { kind: "changes"; stream: number; seq: number; changes: LivePreviewModelChange[] };

/**
 * The streams of this workspace window, across relays: a session replaced while the
 * PDF is detached starts a new relay whose messages must not be taken for
 * the old one's, which can still be in flight.
 */
let streams = 0;

/** The workspace's side: the session's model, sent on to the separate window with \`send\`. */
export class LivePreviewRelay {
  private stream = 0;
  private seq = 0;
  private queue: LivePreviewModelChange[] = [];
  private scheduled = false;
  private sending: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: () => void;

  constructor(private readonly session: LivePreviewSession, private readonly send: (message: LivePreviewRelayMessage) => Promise<unknown>) {
    this.unsubscribe = session.subscribeModel((change) => {
      // Not started yet (rtex was still starting): the snapshot taken now holds this change.
      if (!this.stream) {
        this.restart();
        return;
      }
      this.queue.push(change);
      this.schedule();
    });
    this.restart();
  }

  /** Send the model as it is now, starting a new stream (the window asked, or just opened). */
  restart(): void {
    this.queue = [];
    const start = this.session.mirrorStart();
    if (!start) {
      this.stream = 0;
      return;
    }
    this.stream = ++streams;
    this.seq = 0;
    this.post({ kind: "start", stream: this.stream, start });
  }

  dispose(): void {
    this.unsubscribe();
    this.queue = [];
    this.post({ kind: "off", stream: ++streams });
  }

  /** The changes of one task go as one message. */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.queue.length || !this.stream) return;
      const changes = this.queue;
      this.queue = [];
      this.seq += 1;
      this.post({ kind: "changes", stream: this.stream, seq: this.seq, changes });
    });
  }

  /** One message at a time, so the window hears them in the order they were made. */
  private post(message: LivePreviewRelayMessage): void {
    this.sending = this.sending.then(() => this.send(message)).catch(() => undefined);
  }
}

/** What the mirror asks of the workspace window's session. */
export type LivePreviewMirrorOwner = {
  basePromoted: () => void;
  waitForLayout: () => void;
  /** Send the model again from the start. */
  resync: () => void;
};

/** The separate window's side: the session's model, as the relay sends it, for the layer to draw. */
export class LivePreviewMirror implements LivePreviewSurface {
  model = new PreviewModel();
  private assets: LivePreviewAssets | null = null;
  private source: { projectRoot: string; session: number } | null = null;
  private stream = 0;
  private seq = 0;
  private resyncAsked = false;
  private readonly pageListeners = new Set<(pages: ReadonlySet<number> | "all") => void>();

  constructor(private readonly owner: LivePreviewMirrorOwner) {}

  get fonts() {
    return this.ensureAssets().fonts;
  }

  get images() {
    return this.ensureAssets().images;
  }

  receive(message: LivePreviewRelayMessage): void {
    // A relay since replaced, still being heard.
    if (message.stream < this.stream) return;
    if (message.kind === "off") {
      this.stream = message.stream;
      this.model = new PreviewModel();
      this.markPages("all");
      return;
    }
    if (message.kind === "start") {
      this.begin(message.stream, message.start);
      return;
    }
    if (message.stream !== this.stream || message.seq !== this.seq + 1) {
      if (!this.resyncAsked) {
        this.resyncAsked = true;
        this.owner.resync();
      }
      return;
    }
    this.seq = message.seq;
    const assets = this.ensureAssets();
    for (const { change, fallback } of message.changes) this.markPages(applyModelOp(this.model, assets, change, fallback));
  }

  // ---- What the layer reads (LivePreviewSurface) -------------------------------------------------

  subscribePages(listener: (pages: ReadonlySet<number> | "all") => void): () => void {
    this.pageListeners.add(listener);
    return () => { this.pageListeners.delete(listener); };
  }

  fallbackDocument(layoutVersion: number) {
    return this.ensureAssets().fallbackDocument(layoutVersion);
  }

  basePromoted(): void {
    this.owner.basePromoted();
  }

  waitForLayout(): void {
    this.owner.waitForLayout();
  }

  /** The paint measure is the workspace's (perf-lab-harness.ts); nothing to record here. */
  painted(): void {}

  dispose(): void {
    this.assets?.dispose();
    this.pageListeners.clear();
  }

  // ---- Internals ---------------------------------------------------------------------------------

  private begin(stream: number, start: LivePreviewMirrorStart): void {
    this.stream = stream;
    this.seq = 0;
    this.resyncAsked = false;
    // Another rtex session: what was loaded for the last one may be gone.
    if (this.source?.session !== start.session || this.source.projectRoot !== start.projectRoot) {
      this.assets?.dispose();
      this.assets = null;
      this.source = { projectRoot: start.projectRoot, session: start.session };
    }
    const assets = this.ensureAssets();
    this.model = PreviewModel.fromSnapshot(start.model);
    if (start.fallback) assets.loadFallback(start.fallback);
    const pages = [...this.model.pages.values()].filter((page) => this.model.pageSource(page.page).kind === "display-list");
    assets.load([...pages.map((page) => page.dl), ...[...this.model.overlays.values()].map((overlay) => overlay.dl)]);
    this.markPages("all");
  }

  private ensureAssets(): LivePreviewAssets {
    this.assets ??= new LivePreviewAssets((kind, path) => this.readFile(kind, path), () => this.markPages("all"));
    return this.assets;
  }

  private async readFile(kind: "font" | "image" | "fallback", path: string): Promise<Uint8Array> {
    const source = this.source;
    // eslint-disable-next-line lingui/no-unlocalized-strings -- never shown: a file the layer waits for is only missing
    if (!source) throw new Error("The live preview has not started.");
    const bytes = await invoke<ArrayBuffer>("live_preview_read_file", { projectRoot: source.projectRoot, session: source.session, kind, path });
    return new Uint8Array(bytes);
  }

  private markPages(pages: ReadonlySet<number> | "all"): void {
    if (pages !== "all" && pages.size === 0) return;
    for (const listener of [...this.pageListeners]) listener(pages);
  }
}
