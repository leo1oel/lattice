/**
 * One FlashTeX session's traffic: the open file's text as it is typed goes to
 * the host (src-tauri/lattice-core/src/flashtex_preview.rs), and each PDF
 * that has the edit in it goes to the PDF panel (`onPdf`).
 *
 * One compile at a time, and only the newest text: the host typesets a
 * keystroke in tens of milliseconds, so text that arrives while a compile
 * runs waits for it and is then sent alone, however many keystrokes it holds.
 * Anything going wrong ends the session quietly: the preview it fed is the
 * normal build's again, as with the developer flag off.
 */
import { invoke } from "@tauri-apps/api/core";

/** Text the host typesets. A `.bib` matters only once BibTeX runs, which the preview never does. */
const TYPESET = /\.(tex|ltx|sty|cls|clo|def|cfg|fd|bbx|cbx)$/i;

/** Wait this long after a keystroke for the next one, as FlashTeX's own editors do. */
const DEBOUNCE_MS = 55;

/** What one keystroke's trip took, for a developer reading `window.__latticeFlashtex`. */
export type FlashtexTiming = {
  status: string;
  mode: string;
  pages: number;
  typesetPages: number;
  /** The host's own time for the compile. */
  hostMs: number;
  /** From the text arriving here to the compile's answer. */
  compileMs: number;
  /** From the text arriving here to its PDF handed to the panel; null when none was. */
  shownMs: number | null;
  pdfBytes: number;
  errors: string[];
};

type CompileReport = {
  status: string;
  mode: string;
  pages: number;
  typesetPages: number;
  hostMs: number;
  wallMs: number;
  errors: string[];
  pdf: boolean;
};

export class FlashtexSession {
  readonly timings: FlashtexTiming[] = [];
  private text: { path: string; text: string; at: number } | null = null;
  /** The text last sent, so an unchanged editor sends nothing. */
  private sent: { path: string; text: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private disposed = false;

  constructor(
    private readonly root: string,
    private readonly session: number,
    private readonly mainFile: string,
    private readonly onPdf: (document: string, bytes: ArrayBuffer) => void,
    private readonly onEnded: (reason: string) => void,
  ) {}

  /** The open file and its text, as of now. */
  noteText(path: string, text: string) {
    if (this.disposed || !TYPESET.test(path) || path.startsWith("/")) return;
    const previous = this.text?.path ?? this.sent?.path;
    // The file left behind is on disk as the editor saved it; the copy the
    // host compiles still has the text it was last sent.
    if (previous && previous !== path) void this.sync([previous]);
    if (this.sent?.path === path && this.sent.text === text) {
      this.text = null;
      return;
    }
    this.text = { path, text, at: performance.now() };
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, DEBOUNCE_MS);
  }

  /** Files that changed on disk: the host's copy takes them, and typesets again. */
  async noteFilesChanged(paths: readonly string[]) {
    // The open file's own save: the host already has that text.
    const others = paths.filter((path) => path !== this.sent?.path && path !== this.text?.path);
    if (others.length === 0) return;
    await this.sync(others);
    if (!this.text && this.sent) this.text = { ...this.sent, at: performance.now() };
    void this.pump();
  }

  /** The first compile: the engine loads the document while nothing waits for it. */
  async warm() {
    this.running = true;
    try {
      await invoke<CompileReport>("flashtex_preview_compile", { projectRoot: this.root, session: this.session, buffers: [] });
    } catch (reason) {
      this.end(reason);
    } finally {
      this.running = false;
    }
    void this.pump();
  }

  dispose() {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    void invoke("flashtex_preview_stop", { projectRoot: this.root, session: this.session }).catch(() => undefined);
  }

  private async sync(paths: string[]) {
    try {
      await invoke("flashtex_preview_sync", { projectRoot: this.root, session: this.session, paths });
    } catch (reason) {
      this.end(reason);
    }
  }

  private async pump() {
    if (this.running || this.disposed || !this.text || this.timer !== null) return;
    const next = this.text;
    this.text = null;
    this.running = true;
    try {
      const report = await invoke<CompileReport>("flashtex_preview_compile", {
        projectRoot: this.root, session: this.session, buffers: [{ path: next.path, text: next.text }],
      });
      this.sent = { path: next.path, text: next.text };
      const compileMs = performance.now() - next.at;
      let shownMs: number | null = null;
      let pdfBytes = 0;
      // A TeX error (often a macro half typed) keeps the last good preview,
      // as an errored build keeps the last good PDF.
      if (report.pdf && report.status === "ok" && report.mode !== "unchanged" && !this.disposed) {
        const bytes = await invoke<ArrayBuffer>("flashtex_preview_pdf", { projectRoot: this.root, session: this.session });
        if (!this.disposed) {
          pdfBytes = bytes.byteLength;
          this.onPdf(this.mainFile, bytes);
          shownMs = performance.now() - next.at;
        }
      }
      this.record({
        status: report.status, mode: report.mode, pages: report.pages, typesetPages: report.typesetPages,
        hostMs: report.hostMs, compileMs, shownMs, pdfBytes, errors: report.errors,
      });
    } catch (reason) {
      this.end(reason);
    } finally {
      this.running = false;
    }
    void this.pump();
  }

  private record(timing: FlashtexTiming) {
    this.timings.push(timing);
    if (this.timings.length > 500) this.timings.shift();
  }

  private end(reason: unknown) {
    if (this.disposed) return;
    this.disposed = true;
    this.onEnded(reason instanceof Error ? reason.message : String(reason));
  }
}
