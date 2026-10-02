/**
 * Frozen table headers (spec R-CHR-9): while a table scrolls past the top of
 * the view, its header row stays pinned there, and it stops at the table's
 * end so it never covers what follows.
 *
 * The header cells move by Web Animations, which change nothing in the
 * document's DOM (the editor would otherwise re-read and redraw the table on
 * every scroll). Where the engine supports scroll timelines the animation is
 * driven by the scroll itself; elsewhere (WebKit) a paused animation is set
 * from scroll events. Geometry is measured again after edits and resizes, and
 * the animations of cells the document no longer shows are cancelled.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { blockWindowMoved, scrollerOf } from "./block-window";

type ScrollTimelineConstructor = new (options: { source: Element; axis: "block" }) => AnimationTimeline;

/** A pinned header: its cells' animations and where in the scroll the table pins. */
type Pinned = { cells: HTMLElement[]; animations: Animation[]; start: number; shift: number };

const DURATION = 1000;
/** How long after the last edit the tables are measured again. */
const SETTLE_MS = 150;

class FrozenHeadersView {
  private scroller: HTMLElement | null = null;
  private timeline: AnimationTimeline | null = null;
  private pinned: Pinned[] = [];
  private frame: number | null = null;
  private resize: ResizeObserver | null = null;
  private readonly supported = typeof Element !== "undefined" && "animate" in Element.prototype;

  constructor(private readonly view: EditorView, private readonly enabled: () => boolean) {
    this.schedule();
  }

  update(view: EditorView, previous: EditorView["state"]) {
    if (!this.scroller) this.schedule();
    // A table the document dropped stops at once; while typing, tables only
    // move a little, so they are measured again once typing pauses.
    else if (this.pinned.some((entry) => !entry.cells[0]?.isConnected)) this.schedule();
    // A long document drew or released tables as it scrolled (block-window.ts).
    else if (blockWindowMoved(view.state, previous)) this.schedule();
    else if (!view.state.doc.eq(previous.doc)) this.settle();
  }

  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  private settle() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.schedule();
    }, SETTLE_MS);
  }

  destroy() {
    if (this.frame != null) cancelAnimationFrame(this.frame);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.scroller?.removeEventListener("scroll", this.onScroll);
    this.resize?.disconnect();
    this.release(this.pinned);
    this.pinned = [];
  }

  /**
   * The pane the editor scrolls in, found once the editor is in the page (it
   * is built detached and moved in afterwards).
   */
  private attach(): HTMLElement | null {
    if (this.scroller || !this.supported || !this.view.dom.isConnected) return this.scroller;
    const scroller = scrollerOf(this.view.dom);
    if (!scroller) return null;
    this.scroller = scroller;
    const ScrollTimeline = (globalThis as { ScrollTimeline?: ScrollTimelineConstructor }).ScrollTimeline;
    this.timeline = ScrollTimeline ? new ScrollTimeline({ source: scroller, axis: "block" }) : null;
    if (!this.timeline) scroller.addEventListener("scroll", this.onScroll, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      this.resize = new ResizeObserver(() => this.schedule());
      this.resize.observe(scroller);
      this.resize.observe(this.view.dom);
    }
    return scroller;
  }

  private readonly onScroll = () => this.follow();

  private schedule() {
    if (this.frame != null || !this.supported) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.attach()) this.measure();
    });
  }

  private release(pinned: readonly Pinned[]) {
    for (const entry of pinned) for (const animation of entry.animations) animation.cancel();
  }

  /** Pin every table's header row again from the current layout. */
  private measure() {
    const scroller = this.scroller;
    if (!scroller || !this.view.dom.isConnected) return;
    if (!this.enabled()) {
      this.release(this.pinned);
      this.pinned = [];
      return;
    }
    const range = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const next: Pinned[] = [];
    for (const table of this.view.dom.querySelectorAll<HTMLTableElement>("table")) {
      const header = table.rows[0];
      if (!header || table.rows.length < 2) continue;
      const tableRect = table.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const start = tableRect.top - origin;
      // The header rides down to the last row, never past the table.
      const shift = Math.max(0, tableRect.height - headerRect.height - table.rows[table.rows.length - 1]!.getBoundingClientRect().height);
      // A table whose top the scroll never reaches (or without room to move) is never pinned.
      if (shift <= 0 || start >= range) continue;
      const cells = Array.from(header.cells);
      const kept = this.pinned.find((entry) => entry.cells.length === cells.length && entry.cells.every((cell, index) => cell === cells[index]));
      if (kept && kept.start === start && kept.shift === shift) {
        next.push(kept);
        continue;
      }
      if (kept) this.release([kept]);
      next.push({ cells, start, shift, animations: cells.map((cell) => this.animate(cell, start, shift, range)) });
    }
    // Cells the document no longer shows (a replaced document, a deleted table) stop moving.
    this.release(this.pinned.filter((entry) => !next.includes(entry)));
    this.pinned = next;
    if (!this.timeline) this.follow();
  }

  private animate(cell: HTMLElement, start: number, shift: number, range: number): Animation {
    // Linear in the scroll: pinned from the table's top, moving one pixel per
    // pixel scrolled until the header reaches the last row or the scroll ends.
    const end = Math.min(start + shift, range);
    const moved = Math.max(0, end - start);
    const frames = [
      { transform: "translateY(0px)", offset: 0 },
      { transform: "translateY(0px)", offset: Math.min(1, Math.max(0, start / range)) },
      { transform: `translateY(${moved}px)`, offset: Math.min(1, Math.max(0, end / range)) },
      { transform: `translateY(${moved}px)`, offset: 1 },
    ];
    if (this.timeline) {
      try {
        return cell.animate(frames, { timeline: this.timeline, fill: "both", easing: "linear" } as KeyframeAnimationOptions);
      } catch {
        // A timeline the engine will not take falls back to following scroll events.
      }
    }
    const animation = cell.animate(frames, { duration: DURATION, fill: "both", easing: "linear" });
    animation.pause();
    return animation;
  }

  /** Without a scroll timeline: set each paused animation to the scroll position. */
  private follow() {
    const scroller = this.scroller;
    if (!scroller) return;
    const progress = scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    for (const entry of this.pinned) {
      for (const animation of entry.animations) {
        if (!animation.timeline || animation.timeline === document.timeline) animation.currentTime = progress * DURATION;
      }
    }
  }
}

/** `enabled` is read at every measure: paper reading mode uses light table handles and no frozen headers (R-BLK-11). */
export const FrozenHeaders = Extension.create<{ enabled: () => boolean }>({
  name: "latticeFrozenHeaders",
  addOptions: () => ({ enabled: () => true }),
  addProseMirrorPlugins() {
    const { enabled } = this.options;
    return [new Plugin({ key: new PluginKey("latticeFrozenHeaders"), view: (view) => new FrozenHeadersView(view, enabled) })];
  },
});
