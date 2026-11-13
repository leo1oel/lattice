/**
 * What Visual mode draws in place of source: set math, reference and
 * citation chips, list markers, figures, the preamble bar. Each widget
 * compares by what it shows, never by where it sits, so a rebuild after a
 * keystroke keeps every unchanged widget's DOM (and KaTeX's work) as it was.
 */
import { EditorView, WidgetType } from "@codemirror/view";
import { msg } from "@lingui/core/macro";
import { i18n } from "../../../i18n";
import { element } from "../../dom-utils";
import type { FigureLabel } from "./visual-figure";
import { renderInline, type InlineContext } from "./visual-inline";

/** A class list from single class names. */
const classes = (...names: string[]) => names.join(" ");

/** Measured heights of block widgets, by what they show, so a block scrolled back to keeps its place. */
const heights = new Map<string, number>();
const HEIGHT_LIMIT = 2_000;

function rememberHeight(key: string, dom: HTMLElement) {
  const measure = () => {
    if (!dom.isConnected) return;
    const height = dom.getBoundingClientRect().height;
    if (!height) return;
    heights.set(key, height);
    if (heights.size > HEIGHT_LIMIT) heights.delete(heights.keys().next().value!);
  };
  requestAnimationFrame(measure);
}

/** Place the caret at `offset` past the start of the range `dom`'s widget replaces, and focus. */
function placeCaret(view: EditorView, dom: HTMLElement, offset: number) {
  const start = view.posAtDOM(dom);
  view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, start + offset) }, userEvent: "select.pointer" });
  view.focus();
}

/**
 * A block a click opens for editing: the press is the widget's own (no text
 * selection starts on it) and the release puts the caret `offset` into its
 * source, which then shows in its place.
 */
function opensOnClick(dom: HTMLElement, offset: number) {
  dom.addEventListener("mousedown", (event) => {
    if (event.button === 0) event.preventDefault();
  });
  dom.addEventListener("mouseup", (event) => {
    if (event.button !== 0) return;
    const view = EditorView.findFromDOM(dom);
    if (view) placeCaret(view, dom, offset);
  });
}

const isMouse = (event: Event) => event.type.startsWith("mouse") || event.type.startsWith("pointer") || event.type === "click";

/** Math set by KaTeX; source the caret can enter, which then shows in its place. */
export class MathWidget extends WidgetType {
  constructor(
    /** KaTeX's HTML, or null when it could not set the formula (the source shows instead). */
    readonly html: string | null,
    readonly source: string,
    readonly display: boolean,
    /** Everything the picture depends on: its source, number and the macros it was set with. */
    readonly key: string,
    /** Where, from the start of the region, its body starts: a click lands there. */
    readonly bodyOffset: number,
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other.key === this.key && other.bodyOffset === this.bodyOffset && other.html === this.html;
  }

  toDOM(): HTMLElement {
    const dom = element(this.display ? "div" : "span", this.display ? classes("lx-tex-math", "lx-tex-math-display") : "lx-tex-math");
    if (this.html === null) {
      dom.classList.add("is-unset");
      dom.textContent = this.source;
      dom.title = i18n._(msg`KaTeX cannot set this formula; it shows as written.`);
    } else {
      dom.innerHTML = this.html;
    }
    if (this.display) {
      opensOnClick(dom, this.bodyOffset);
      rememberHeight(this.key, dom);
    }
    return dom;
  }

  get estimatedHeight(): number {
    return this.display ? heights.get(this.key) ?? 48 : -1;
  }

  ignoreEvent(event: Event): boolean {
    // Display math takes its own clicks (see opensOnClick); inline math lets
    // CodeMirror put the caret beside it, which shows its source.
    return this.display && isMouse(event);
  }
}

/** A word or character standing for source: a symbol, a reference's number, a citation, a label. */
export class TextWidget extends WidgetType {
  constructor(readonly text: string, readonly className: string, readonly title = "") {
    super();
  }

  eq(other: TextWidget): boolean {
    return other.text === this.text && other.className === this.className && other.title === this.title;
  }

  toDOM(): HTMLElement {
    const dom = element("span", this.className, this.text);
    if (this.title) dom.title = this.title;
    return dom;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** A piece of a chip's text: a key's own words carry the key, separators and brackets none. */
export type ChipPart = { text: string; key?: string };

/**
 * A reference's or citation's chip, each key's words in a span of their own
 * (`data-key`), so a ⌘-click jumps to the key under the pointer. It has no
 * title: the hover card (visual-hover.ts) says what the keys name.
 */
export class KeyedChipWidget extends WidgetType {
  private readonly signature: string;

  constructor(readonly parts: readonly ChipPart[], readonly className: string) {
    super();
    this.signature = JSON.stringify(parts);
  }

  eq(other: KeyedChipWidget): boolean {
    return other.className === this.className && other.signature === this.signature;
  }

  toDOM(): HTMLElement {
    const dom = element("span", this.className);
    for (const part of this.parts) {
      if (part.key === undefined) dom.append(part.text);
      else {
        const span = element("span", "lx-tex-chip-key", part.text);
        span.dataset.key = part.key;
        dom.append(span);
      }
    }
    return dom;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Text standing for an empty construct to fill in (`\caption{}`): a click puts
 * the caret `offset` into its source, between the braces, rather than at the
 * widget's edge where typing would land outside them.
 */
export class PlaceholderWidget extends WidgetType {
  constructor(readonly text: string, readonly className: string, readonly offset: number) {
    super();
  }

  eq(other: PlaceholderWidget): boolean {
    return other.text === this.text && other.className === this.className && other.offset === this.offset;
  }

  toDOM(): HTMLElement {
    const dom = element("span", this.className, this.text);
    opensOnClick(dom, this.offset);
    return dom;
  }

  ignoreEvent(event: Event): boolean {
    return isMouse(event);
  }
}

/** A list item's marker: a bullet or number by depth, or the item's own `[label]`. */
export class MarkerWidget extends WidgetType {
  constructor(readonly marker: string, readonly depth: number) {
    super();
  }

  eq(other: MarkerWidget): boolean {
    return other.marker === this.marker && other.depth === this.depth;
  }

  toDOM(): HTMLElement {
    const dom = element("span", "lx-tex-marker", this.marker);
    dom.setAttribute("aria-hidden", "true");
    return dom;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** A link to an `\input` or `\include`d file: a click opens it; the keyboard reaches its source. */
export class IncludeWidget extends WidgetType {
  constructor(readonly path: string, readonly open: (() => void) | null) {
    super();
  }

  eq(other: IncludeWidget): boolean {
    return other.path === this.path && Boolean(other.open) === Boolean(this.open);
  }

  toDOM(): HTMLElement {
    const dom = element("span", classes("lx-tex-chip", "lx-tex-include"), this.path);
    if (!this.open) return dom;
    dom.setAttribute("role", "link");
    const path = this.path;
    dom.title = i18n._(msg`Open ${path}`);
    dom.addEventListener("mousedown", (event) => {
      if (event.button === 0) event.preventDefault();
    });
    // Read at click time: a widget kept across rebuilds (equal path) keeps its first handler.
    const open = this.open;
    dom.addEventListener("click", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      open();
    });
    return dom;
  }

  ignoreEvent(event: Event): boolean {
    return Boolean(this.open) && isMouse(event);
  }
}

const missingPreview = (path: string) => i18n._(msg`No preview for ${path}; the PDF shows it.`);

/** A figure's image, loaded through the project's reference-image loader (PDFs show their first page). */
export class ImageWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly load: () => Promise<string | null>,
    /** The share of the column it takes (`width=0.6\linewidth`), or null for its natural size. */
    readonly width: number | null,
    readonly block: boolean,
    /** Where, from the start of the region, `\includegraphics` starts: a click lands there. */
    readonly offset: number,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.path === this.path && other.width === this.width && other.block === this.block && other.offset === this.offset;
  }

  toDOM(): HTMLElement {
    const dom = element(this.block ? "div" : "span", this.block ? classes("lx-tex-image", "is-block") : "lx-tex-image");
    if (this.width !== null) dom.style.setProperty("--lx-tex-image-width", `${Math.round(this.width * 100)}%`);
    dom.classList.add("is-loading");
    dom.setAttribute("aria-label", this.path);
    const settle = (content: Node | string, state: "loaded" | "failed") => {
      dom.classList.remove("is-loading");
      dom.classList.add(`is-${state}`);
      dom.replaceChildren(content);
      if (this.block) rememberHeight(`image:${this.path}:${this.width}`, dom);
      EditorView.findFromDOM(dom)?.requestMeasure();
    };
    const path = this.path;
    void this.load().then((source) => {
      if (!source) return settle(missingPreview(path), "failed");
      const image = element("img");
      image.alt = path;
      image.src = source;
      image.addEventListener("load", () => EditorView.findFromDOM(dom)?.requestMeasure(), { once: true });
      settle(image, "loaded");
    }, () => settle(i18n._(msg`${path} could not be read.`), "failed"));
    if (this.block) opensOnClick(dom, this.offset);
    return dom;
  }

  get estimatedHeight(): number {
    return this.block ? heights.get(`image:${this.path}:${this.width}`) ?? 180 : -1;
  }

  ignoreEvent(event: Event): boolean {
    return this.block && isMouse(event);
  }
}

/** What an editable figure draws: its graphic as an image URL (null when it has none to show) and the labels set over it. */
export type FigurePicture = { graphic: string; image: string | null; labels: readonly FigureLabel[] };

/**
 * The previews' scale for a PDF page: twice its size in points, up to 720
 * pixels wide (reference-preview.ts). A wider page's size is not known from
 * its picture; a column is about this wide.
 */
const PREVIEW_SCALE = 2;
const WIDE_PAGE_POINTS = 360;

/**
 * An editable figure an `\input` brings in (docs/editable-figures.md),
 * drawn as its graphic with the labels its entry sets over it: compound
 * numbers from the last build, "?" before one. A click opens the include
 * line's source; the button opens the drawing in the program it came from.
 */
export class FigureWidget extends WidgetType {
  constructor(
    readonly entry: string,
    readonly load: () => Promise<FigurePicture>,
    /** A compound key's number, "?" when the last build gave it none. */
    readonly number: (key: string) => string,
    /** What the numbers were read from: a new build draws the figure again. */
    readonly numbersKey: unknown,
    readonly openDrawing: (() => void) | null,
    /** Where, from the start of the region, the include command starts: a click lands there. */
    readonly offset: number,
  ) {
    super();
  }

  eq(other: FigureWidget): boolean {
    return other.entry === this.entry && other.numbersKey === this.numbersKey && other.offset === this.offset
      && Boolean(other.openDrawing) === Boolean(this.openDrawing);
  }

  toDOM(): HTMLElement {
    const dom = element("div", classes("lx-tex-image", "lx-tex-figure", "is-block", "is-loading"));
    const path = this.entry;
    dom.setAttribute("aria-label", path);
    const settle = (content: Node | string, state: "loaded" | "failed") => {
      dom.classList.remove("is-loading");
      dom.classList.add(`is-${state}`);
      dom.replaceChildren(content);
      if (this.openDrawing) dom.append(this.drawingButton(this.openDrawing));
      rememberHeight(`figure:${path}`, dom);
      EditorView.findFromDOM(dom)?.requestMeasure();
    };
    void this.load().then(({ graphic, image, labels }) => {
      if (!image) return settle(missingPreview(graphic), "failed");
      settle(this.picture(image, graphic, labels), "loaded");
    }, () => settle(i18n._(msg`${path} could not be read.`), "failed"));
    opensOnClick(dom, this.offset);
    return dom;
  }

  /** The graphic with its labels over it, the labels sized as the entry sets them against the graphic's width. */
  private picture(source: string, graphic: string, labels: readonly FigureLabel[]): HTMLElement {
    const canvas = element("div", "lx-tex-figure-canvas");
    const image = element("img");
    image.alt = graphic;
    image.src = source;
    const layer = element("div", "lx-tex-figure-labels");
    layer.setAttribute("aria-hidden", "true");
    for (const label of labels) {
      const mark = element("span", "lx-tex-figure-label");
      mark.style.left = `${label.x * 100}%`;
      mark.style.bottom = `${label.y * 100}%`;
      if (label.size) mark.style.fontSize = `${label.size}em`;
      mark.classList.add(`is-${label.font ?? "serif"}`);
      for (const run of label.runs) {
        const text = "text" in run ? run.text : run.compounds.map(this.number).join(",");
        mark.append(element("span", run.bold ? "is-bold" : "", text));
      }
      layer.append(mark);
    }
    // One point of the figure, in pixels as it is drawn: what the labels' sizes are in.
    const scale = () => {
      const points = image.naturalWidth >= 720 ? WIDE_PAGE_POINTS : image.naturalWidth / PREVIEW_SCALE;
      if (points > 0 && image.clientWidth > 0) layer.style.setProperty("--lx-tex-figure-point", `${image.clientWidth / points}px`);
    };
    image.addEventListener("load", () => {
      scale();
      EditorView.findFromDOM(canvas)?.requestMeasure();
    }, { once: true });
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(scale);
      observer.observe(image);
      this.observers.push(observer);
    }
    canvas.append(image, layer);
    return canvas;
  }

  private readonly observers: ResizeObserver[] = [];

  destroy(): void {
    this.observers.splice(0).forEach((observer) => observer.disconnect());
  }

  private drawingButton(open: () => void): HTMLElement {
    const button = element("button", "lx-tex-figure-edit", i18n._(msg`Edit drawing`));
    button.type = "button";
    button.title = i18n._(msg`Open the drawing this figure was made from`);
    // The figure's own click opens its source: the button's press and release stay the button's.
    for (const type of ["mousedown", "mouseup"] as const) {
      button.addEventListener(type, (event) => {
        event.stopPropagation();
        if (type === "mousedown") event.preventDefault();
      });
    }
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      open();
    });
    return button;
  }

  get estimatedHeight(): number {
    return heights.get(`figure:${this.entry}`) ?? 180;
  }

  ignoreEvent(event: Event): boolean {
    return isMouse(event);
  }
}

/**
 * A labelled bar standing for an environment's `\begin` or `\end` line (an
 * abstract's heading, a theorem's name, the end rule), or for the preamble.
 * A click opens its source.
 */
export class BarWidget extends WidgetType {
  constructor(readonly label: string, readonly className: string, readonly offset = 0) {
    super();
  }

  eq(other: BarWidget): boolean {
    return other.label === this.label && other.className === this.className && other.offset === this.offset;
  }

  toDOM(): HTMLElement {
    const dom = element("div", `lx-tex-bar ${this.className}`);
    if (this.label) dom.append(element("span", "lx-tex-bar-label", this.label));
    opensOnClick(dom, this.offset);
    return dom;
  }

  ignoreEvent(event: Event): boolean {
    return isMouse(event);
  }
}

/**
 * The title block `\maketitle` prints: the title, then the author blocks side
 * by side, each set as rich text from its LaTeX (macros expanded, line breaks,
 * spacing and font switches kept). A click opens `\maketitle`'s source.
 */
export class TitleWidget extends WidgetType {
  constructor(
    readonly title: string,
    readonly authors: readonly string[],
    readonly offset: number,
    /** Everything the block depends on: its sources and the macros they are set with. */
    readonly key: string,
    readonly context: InlineContext,
  ) {
    super();
  }

  eq(other: TitleWidget): boolean {
    return other.key === this.key && other.offset === this.offset;
  }

  toDOM(): HTMLElement {
    const dom = element("div", "lx-tex-title-block");
    if (this.title) {
      const title = element("div", "lx-tex-title");
      title.append(renderInline(this.title, this.context));
      dom.append(title);
    }
    if (this.authors.length) {
      const row = element("div", "lx-tex-authors");
      for (const author of this.authors) {
        const block = element("div", "lx-tex-author");
        block.append(renderInline(author, this.context));
        row.append(block);
      }
      dom.append(row);
    }
    opensOnClick(dom, this.offset);
    return dom;
  }

  ignoreEvent(event: Event): boolean {
    return isMouse(event);
  }
}
