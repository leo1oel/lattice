/**
 * One project's rtex session, as the window sees it: what is sent to rtex,
 * what rtex reported back, and the state the PDF's overlay draws from.
 *
 * Every change to a project file reaches rtex through one ordered queue: the
 * open file's text as the writer types, and the files the watcher reports
 * (an Overleaf pull, the agent, another editor) read from disk. A disk read
 * that a newer change overtook is dropped, and rtex's own source revisions
 * order what comes back, so a late result never paints over newer text.
 *
 * The normal latexmk build is untouched. The pipeline tells this session
 * which revision of the files each build compiled (`buildStarted`,
 * `baseShown`), so edits the PDF on screen already holds stop being painted.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { FontStore, ImageStore } from "./rtex-render";
import { PreviewModel } from "./rtex-model";
import { ResourceLoader } from "./rtex-resources";
import { SourceSync } from "./rtex-source-sync";
import type { Command, DisplayList, LayoutUpdateEvent, ParagraphUpdateEvent, Reply, RtexEvent } from "./rtex-protocol";
import { getDocument } from "../pdf/pdfjs-runtime";
import { PDF_CMAP_URL, PDF_STANDARD_FONT_DATA_URL } from "../pdf/pdf-viewer-utils";

type PdfDocument = Awaited<ReturnType<typeof getDocument>["promise"]>;

/**
 * Where the session is. `starting`: rtex is loading the preamble.
 * `first-layout`: typesetting the whole document for the first time.
 * `live`: paragraphs follow typing. `paused`: rtex could not load the
 * preamble for live typing; whole-document passes still run. `error`: rtex
 * stopped, or its first pass failed.
 */
export type LivePreviewPhase = "starting" | "first-layout" | "live" | "paused" | "error";

export type LivePreviewSnapshot = Readonly<{
  phase: LivePreviewPhase;
  /** A whole-document pass is catching up with the text: page breaks and what follows an edit may move. */
  layoutPending: boolean;
  /** rtex's words when it stopped or failed. */
  detail: string | null;
}>;

const INITIAL: LivePreviewSnapshot = { phase: "starting", layoutPending: false, detail: null };

/** A fallback PDF of one layout, kept in memory: rtex deletes the file two layouts later. */
type Fallback = { layoutVersion: number; document: Promise<PdfDocument | null> };

const EVENT_CMDS = new Set(["edit", "set_document"]);

export class LivePreviewSession {
  readonly model = new PreviewModel();
  /** How many of each event and reply rtex sent: what the perf lab reports beside its timings. */
  readonly received = new Map<string, number>();
  readonly fonts = new FontStore();
  readonly images: ImageStore;
  private readonly resources: ResourceLoader;
  private readonly sync = new SourceSync();
  private session: number | null = null;
  private disposed = false;
  private snapshot: LivePreviewSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private readonly pageListeners = new Set<(pages: ReadonlySet<number> | "all") => void>();

  // ---- The command queue, and the revision each command left rtex at.
  private readonly queue: Command[] = [];
  private sending = false;
  /** Commands awaiting their reply, oldest first, with their index among the text changes. */
  private readonly awaiting: Array<{ cmd: Command["cmd"]; index: number | null }> = [];
  /** How many text changes (edit, set_document) have been queued. */
  private changes = 0;
  /** rtex's source revision after each text change, by index; [-1] is before the first. */
  private readonly revisions = new Map<number, number>();
  /** The newest revision rtex acknowledged. */
  private latestRevision = 0;
  /** When the writer made the change rtex numbered with each revision, for the paint measure. */
  private readonly typedAt = new Map<number, number>();
  private readonly pendingTyped: Array<number | null> = [];
  /** Text changes up to this index are on disk. */
  private diskIndex = 0;
  /** A base PDF on screen whose revision is still in the queue. */
  private pendingBase: number | null = null;
  /** The newest revision whose pagination no layout or build has caught up with yet. */
  private awaitingSince: number | null = null;
  /** A base PDF the viewer is still loading. */
  private nextBase: number | null = null;

  // ---- Disk reads: a counter per file, so a read a newer change overtook is dropped.
  private readonly fileGeneration = new Map<string, number>();
  private activePath: string | null = null;
  private editorDirty = false;

  private fallback: Fallback | null = null;
  private generation = -1;
  private basePages: number | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly mainFile: string,
  ) {
    this.images = new ImageStore(rasterizePdfImage);
    this.images.onLoaded = () => this.markPages("all");
    this.resources = new ResourceLoader((kind, path) => this.readFile(kind, path));
    // First in the queue, ahead of any edit made while rtex starts: the
    // revision rtex loaded the files at, which the base PDF was built from.
    this.enqueue([{ cmd: "status" }]);
  }

  // ---- Lifecycle ---------------------------------------------------------------------------------

  /**
   * Start rtex. `texFiles` are the project's .tex files: what rtex reads of
   * them now is recorded, so a watcher report that names files without
   * changing them (or names none) sends rtex nothing.
   */
  async start(texFiles: readonly string[] = []): Promise<void> {
    const events = new Channel<RtexEvent | Reply>();
    events.onmessage = (message) => {
      if (!this.disposed) this.receive(message);
    };
    const session = await invoke<number>("live_preview_start", {
      projectRoot: this.projectRoot, mainFile: this.mainFile, onEvent: events,
    });
    if (this.disposed) {
      void invoke("live_preview_stop", { projectRoot: this.projectRoot, session }).catch(() => undefined);
      return;
    }
    this.session = session;
    void this.flush();
    for (const path of texFiles.filter(isTexPath)) {
      const generation = this.fileGeneration.get(path) ?? 0;
      void invoke<string>("read_project_file", { path, projectRoot: this.projectRoot }).then((text) => {
        if (!this.disposed && (this.fileGeneration.get(path) ?? 0) === generation) this.sync.seed(path, text);
      }).catch(() => undefined);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const session = this.session;
    if (session !== null) void invoke("live_preview_stop", { projectRoot: this.projectRoot, session }).catch(() => undefined);
    void this.fallback?.document.then((document) => document?.loadingTask.destroy());
    this.listeners.clear();
    this.pageListeners.clear();
  }

  // ---- What the app reports ------------------------------------------------------------------------

  /** The open file's text, as the editor holds it, and as it is on disk. */
  noteText(path: string, text: string, saved: string): void {
    if (this.disposed || !isTexPath(path)) return;
    if (path !== this.activePath) {
      this.activePath = path;
      // A file switched in replaces whatever rtex last read of it.
      this.bumpFile(path);
    }
    this.editorDirty = text !== saved;
    const commands = this.sync.update(path, text, saved);
    if (commands.length) this.enqueue(commands, performance.now());
  }

  /** The files the watcher reports changed (null: anything may have). */
  noteFilesChanged(paths: readonly string[] | null, projectFiles: readonly string[]): void {
    if (this.disposed) return;
    const changed = (paths ?? projectFiles).filter((path) => isTexPath(path) && path !== this.activePath);
    for (const path of changed) {
      const generation = this.bumpFile(path);
      void invoke<string>("read_project_file", { path, projectRoot: this.projectRoot }).then((text) => {
        if (this.disposed || this.fileGeneration.get(path) !== generation || path === this.activePath) return;
        const command = this.sync.replace(path, text);
        if (!command) return;
        this.enqueue([command]);
        // What the watcher saw is on disk, and so on the next build's pages,
        // unless the open file holds edits the build will not see.
        if (!this.editorDirty) this.diskIndex = this.changes;
      }).catch(() => {
        // A removed file: rtex reports the \input it can no longer find.
      });
    }
  }

  /** The editor wrote the open file: everything sent so far is on disk. */
  noteSaved(): void {
    this.editorDirty = false;
    this.diskIndex = this.changes;
  }

  /** A latexmk pass starts reading the files: the token `baseShown` takes when its PDF is shown. */
  buildStarted(): number {
    return this.diskIndex;
  }

  /**
   * A new base PDF is loading into the viewer, built from the files as of
   * `token`; it takes over once the viewer shows it (`basePromoted`), so the
   * edits stay painted over the old one until then.
   */
  baseLoading(token: number | null): void {
    this.nextBase = token;
  }

  /** The viewer now shows the PDF `baseLoading` announced. */
  basePromoted(): void {
    const token = this.nextBase;
    this.nextBase = null;
    if (token !== null) this.baseShown(token);
  }

  /** The base PDF on screen is built from the files as of `token` (null: unknown). */
  baseShown(token: number | null): void {
    if (token !== null) {
      const revision = this.revisionAt(token);
      if (revision === undefined) this.pendingBase = token;
      else this.applyBase(revision);
    }
    this.markPages("all");
  }

  /** The page count of the base PDF, once pdf.js has opened it. */
  basePageCount(pages: number | null): void {
    if (this.basePages === pages) return;
    this.basePages = pages;
    this.refreshPending();
  }

  // ---- What the overlay reads --------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): LivePreviewSnapshot => this.snapshot;

  /** Pages to redraw ("all" when every page may have changed source). */
  subscribePages(listener: (pages: ReadonlySet<number> | "all") => void): () => void {
    this.pageListeners.add(listener);
    return () => { this.pageListeners.delete(listener); };
  }

  /** The fallback PDF that draws pages of layout `layoutVersion`, once loaded. */
  fallbackDocument(layoutVersion: number): Promise<PdfDocument | null> | null {
    return this.fallback && this.fallback.layoutVersion >= layoutVersion ? this.fallback.document : null;
  }

  /** A live paragraph cannot be drawn exactly: say the layout is catching up with it. */
  waitForLayout(): void {
    this.awaitLayout();
  }

  /** The overlay painted page `page`: record how long the edits on it took to show. */
  painted(page: number): void {
    const now = performance.now();
    // The newest change this page shows: a live paragraph's, or the layout's it was drawn from.
    let shown = this.model.pageSource(page).kind === "base" ? -1 : this.model.layoutRevision ?? -1;
    for (const { overlay } of this.model.overlaysOn(page)) shown = Math.max(shown, overlay.revision);
    for (const [revision, typed] of [...this.typedAt]) {
      if (revision > shown) continue;
      this.typedAt.delete(revision);
      // Read in the lab (perf-lab-harness.ts livePreview): keystroke to painted page.
      performance.measure("lattice-live-preview-paint", { start: typed, end: now, detail: { revision, page } });
    }
  }

  // ---- Internals ---------------------------------------------------------------------------------

  private bumpFile(path: string): number {
    const generation = (this.fileGeneration.get(path) ?? 0) + 1;
    this.fileGeneration.set(path, generation);
    return generation;
  }

  private enqueue(commands: Command[], typedAt: number | null = null): void {
    for (const command of commands) {
      const counts = EVENT_CMDS.has(command.cmd);
      this.awaiting.push({ cmd: command.cmd, index: counts ? this.changes : null });
      if (counts) {
        this.changes += 1;
        this.pendingTyped.push(typedAt);
      }
      this.queue.push(command);
    }
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.sending || this.session === null) return;
    this.sending = true;
    while (this.queue.length && !this.disposed) {
      const batch = this.queue.splice(0);
      try {
        await invoke("live_preview_send", {
          projectRoot: this.projectRoot, session: this.session, commands: batch.map((command) => JSON.stringify(command)),
        });
      } catch (reason) {
        this.updateSnapshot({ phase: "error", detail: String(reason) });
        break;
      }
    }
    this.sending = false;
  }

  private revisionAt(index: number): number | undefined {
    return index === 0 ? this.revisions.get(-1) : this.revisions.get(index - 1);
  }

  private applyBase(revision: number): void {
    this.pendingBase = null;
    this.model.setBase(revision);
    // rtex lays out again only when pagination moved, so its last layout can
    // be older than the PDF now on screen; the rows a live paragraph clears
    // come from that layout, so ask for one that matches the PDF.
    if (this.model.layoutRevision !== null && this.model.layoutRevision < revision) this.enqueue([{ cmd: "request_layout" }]);
    // The build laid out what the layout was awaited for.
    if (this.awaitingSince !== null && revision >= this.awaitingSince) this.awaitingSince = null;
    this.refreshPending();
  }

  /**
   * Pagination is behind the text as of `revision` (the newest change when
   * unknown): until a layout or a build includes it, what follows an edit
   * may sit where it was.
   */
  private awaitLayout(revision = this.latestRevision): void {
    this.awaitingSince = Math.max(this.awaitingSince ?? revision, revision);
    this.refreshPending();
  }

  private refreshPending(): void {
    this.updateSnapshot({ layoutPending: this.awaitingSince !== null || this.model.pagesDisagree(this.basePages) });
  }

  private receive(message: RtexEvent | Reply): void {
    const kind = "reply" in message ? `reply:${message.reply}` : message.event;
    this.received.set(kind, (this.received.get(kind) ?? 0) + 1);
    if ("reply" in message) this.onReply(message);
    else this.onEvent(message);
  }

  private onReply(reply: Reply): void {
    const sent = this.awaiting.shift();
    if (reply.reply === "status") {
      // The revision before any change of ours: the files the base PDF was built from.
      if (!this.revisions.has(-1)) {
        this.revisions.set(-1, reply.versions.source_revision);
        this.model.baseRevision = reply.versions.source_revision;
        this.latestRevision = Math.max(this.latestRevision, reply.versions.source_revision);
        if (this.pendingBase === 0) this.applyBase(reply.versions.source_revision);
      }
      return;
    }
    if (reply.reply !== "edit" && reply.reply !== "set_document") {
      // A refused edit (rtex does not know the file) leaves its revision where it was.
      if (sent?.index != null) this.recordRevision(sent.index, this.latestRevision);
      return;
    }
    const { result } = reply;
    if (sent?.index != null) this.recordRevision(sent.index, result.source_revision);
    if (result.outcome.removed.length) this.markPages(this.model.dropOverlays(result.outcome.removed));
    if (result.routed !== "fast") this.awaitLayout(result.source_revision);
  }

  private recordRevision(index: number, revision: number): void {
    this.revisions.set(index, revision);
    // A build reads its token within seconds; a few thousand changes is ample.
    this.revisions.delete(index - 4096);
    this.latestRevision = Math.max(this.latestRevision, revision);
    const typed = this.pendingTyped.shift();
    if (typed != null) this.typedAt.set(revision, typed);
    if (this.typedAt.size > 64) this.typedAt.delete(this.typedAt.keys().next().value!);
    if (this.pendingBase !== null && this.pendingBase === index + 1) {
      this.applyBase(revision);
      this.markPages("all");
    }
  }

  private onEvent(event: RtexEvent): void {
    switch (event.event) {
      case "EngineState":
        if (event.engine_generation !== this.generation && this.generation >= 0) this.markPages(this.model.dropOverlays());
        this.generation = event.engine_generation;
        if (event.state === "Failed") this.updateSnapshot({ phase: "paused", detail: event.reason });
        else if (event.state === "Ready") this.updateSnapshot({ phase: this.model.hasLayout ? "live" : "first-layout", detail: null });
        else if (event.state === "Starting" && this.model.hasLayout) this.awaitLayout();
        break;
      case "LayoutUpdate":
        this.onLayout(event);
        break;
      case "ParagraphUpdate":
        this.onParagraph(event);
        break;
      case "BackgroundScheduled":
        this.awaitLayout();
        break;
      case "SessionExited":
        this.updateSnapshot({ phase: "error", detail: event.stderr || null });
        this.markPages(this.model.dropOverlays());
        break;
      default:
        break;
    }
  }

  private onLayout(event: LayoutUpdateEvent): void {
    if (event.compile.state === "Failed") {
      // rtex keeps the previous layout; before the first one there is nothing to show.
      if (!this.model.hasLayout) this.updateSnapshot({ phase: "error", detail: null });
      return;
    }
    if (event.pdf_fallback) this.loadFallback(event.pdf_fallback, event.versions.layout_version);
    const dirty = this.model.applyLayout({
      pages: event.pages_changed,
      pagesTotal: event.pages_total,
      placements: event.placements,
      revision: event.versions.source_revision,
      layoutVersion: event.versions.layout_version,
      hasFallback: Boolean(event.pdf_fallback),
    });
    this.loadResources(event.pages_changed.map((page) => page.dl));
    const settled = event.convergence.state === "Converged" || event.convergence.state === "PassLimitReached";
    this.updateSnapshot({
      phase: this.snapshot.phase === "paused" ? "paused" : "live",
    });
    if (settled && this.awaitingSince !== null && event.versions.source_revision >= this.awaitingSince) this.awaitingSince = null;
    if (!settled) this.awaitLayout(event.versions.source_revision);
    this.refreshPending();
    this.markPages(dirty);
  }

  private onParagraph(event: ParagraphUpdateEvent): void {
    const revision = event.versions.source_revision;
    if (event.status === "removed") {
      this.markPages(this.model.applyParagraph(event.par_id, event.dl, [], revision));
      return;
    }
    // Something in it cannot be drawn exactly, or TeX stopped on an error:
    // the next whole-document pass shows it.
    if (event.status !== "ok") {
      this.awaitLayout(revision);
      return;
    }
    if (revision <= this.model.baseRevision) return;
    const fragments = event.pagination_stale ? event.fragments : this.model.placeLive(event.par_id, event.fragments);
    this.markPages(this.model.applyParagraph(event.par_id, event.dl, fragments, revision));
    this.loadResources([event.dl]);
    if (event.pagination_stale) this.awaitLayout(revision);
  }

  private loadResources(dls: DisplayList[]): void {
    const fonts = this.resources.fontsFor(dls, (key) => this.fonts.has(key)).then((found) => {
      for (const [key, resource] of found) this.fonts.add(key, resource);
      return found.size;
    });
    const images = this.resources.imagesFor(dls, (file) => this.images.has(file)).then((found) => {
      for (const [file, { resource, page }] of found) this.images.add(file, resource, page);
      return found.size;
    });
    void Promise.all([fonts, images]).then(([newFonts, newImages]) => {
      if (!this.disposed && newFonts + newImages > 0) this.markPages("all");
    });
  }

  private loadFallback(path: string, layoutVersion: number): void {
    const previous = this.fallback;
    const document = this.readFile("fallback", path)
      .then((data) => getDocument({
        data,
        cMapUrl: PDF_CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
        // As the main viewer: WKWebView can paint embedded Type 1 FontFace glyphs blank.
        disableFontFace: true,
        useSystemFonts: false,
      }).promise)
      .catch(() => null);
    this.fallback = { layoutVersion, document };
    void document.then(() => {
      void previous?.document.then((old) => old?.loadingTask.destroy());
      if (!this.disposed) this.markPages("all");
    });
  }

  private async readFile(kind: "font" | "image" | "fallback", path: string): Promise<Uint8Array> {
    const bytes = await invoke<ArrayBuffer>("live_preview_read_file", {
      projectRoot: this.projectRoot, session: this.session, kind, path,
    });
    return new Uint8Array(bytes);
  }

  private markPages(pages: ReadonlySet<number> | "all"): void {
    if (pages !== "all" && pages.size === 0) return;
    for (const listener of [...this.pageListeners]) listener(pages);
  }

  private updateSnapshot(patch: Partial<LivePreviewSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (next.phase === this.snapshot.phase && next.layoutPending === this.snapshot.layoutPending && next.detail === this.snapshot.detail) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The files rtex reads as source: the document's .tex files. */
function isTexPath(path: string): boolean {
  return path.toLowerCase().endsWith(".tex");
}

/** A PDF image a display list draws (\includegraphics of a PDF), rasterized once for drawImage. */
async function rasterizePdfImage(data: Uint8Array, n: number): Promise<CanvasImageSource> {
  const task = getDocument({ data: data.slice(), disableFontFace: true, useSystemFonts: false });
  const document = await task.promise;
  try {
    const page = await document.getPage(Math.max(1, Math.min(n, document.numPages)));
    const natural = page.getViewport({ scale: 1 });
    // enough pixels for a sharp figure at 200 % zoom on a 2× screen
    const scale = Math.min(6, 2400 / Math.max(natural.width, natural.height));
    const viewport = page.getViewport({ scale });
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    return canvas;
  } finally {
    void task.destroy();
  }
}
