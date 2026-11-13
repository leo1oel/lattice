/**
 * A float or a table drawn whole (visual-float.ts reads its layout): panels
 * side by side as the page sets them, wrapping under one another when the
 * column is narrow; images through the project's reference-image loader
 * (PDFs show their first page); tables as tables; captions numbered from the
 * last build. A click on any part puts the caret in that part's source,
 * which then shows in the float's place for editing.
 */
import { EditorView, WidgetType } from "@codemirror/view";
import { msg } from "@lingui/core/macro";
import { i18n } from "../../../i18n";
import { element } from "../../dom-utils";
import type { FloatNode } from "./visual-float";
import { renderInline, type InlineContext } from "./visual-inline";
import type { Table } from "./visual-table";

/** A class list from single class names. */
const classes = (...names: string[]) => names.join(" ");

/** A float's layout with what a build adds: each caption's "Figure 3:" and each image's project path. */
export type DrawnNode =
  | Exclude<FloatNode, { kind: "row" | "panel" | "caption" | "image" }>
  | { kind: "row"; items: DrawnNode[]; from: number }
  | { kind: "panel"; width: number | null; children: DrawnNode[]; from: number }
  | (Extract<FloatNode, { kind: "caption" }> & { prefix: string })
  | (Extract<FloatNode, { kind: "image" }> & { resolved: string | null });

/** Measured heights of drawn floats, by what they show, so a float scrolled back to keeps its place. */
const heights = new Map<string, number>();
const HEIGHT_LIMIT = 500;

const isMouse = (event: Event) => event.type.startsWith("mouse") || event.type.startsWith("pointer") || event.type === "click";

/** What an environment the float does not draw stands for, in words. */
function opaqueName(name: string): string {
  if (name === "tikzpicture" || name === "pgfpicture") return i18n._(msg`TikZ picture`);
  if (/^algorithm/.test(name)) return i18n._(msg`Algorithm`);
  return name;
}

export class FloatWidget extends WidgetType {
  constructor(
    readonly nodes: readonly DrawnNode[],
    /** Everything the drawing depends on: the source, the numbers, the macros and the project data it was drawn with. */
    readonly key: string,
    readonly load: (path: string) => Promise<string | null>,
    readonly context: InlineContext,
    /** A table on its own, rather than a float. */
    readonly bare: boolean,
  ) {
    super();
  }

  eq(other: FloatWidget): boolean {
    return other.key === this.key;
  }

  toDOM(): HTMLElement {
    const dom = element("div", this.bare ? classes("lx-tex-float-block", "is-bare") : "lx-tex-float-block");
    for (const node of this.nodes) this.draw(node, dom);
    dom.addEventListener("mousedown", (event) => {
      if (event.button === 0) event.preventDefault();
    });
    dom.addEventListener("mouseup", (event) => {
      if (event.button !== 0) return;
      const view = EditorView.findFromDOM(dom);
      if (!view) return;
      // The part clicked, or the float's first line.
      const part = (event.target as Element | null)?.closest?.("[data-offset]");
      const offset = Number(part?.getAttribute("data-offset") ?? 0);
      const start = view.posAtDOM(dom);
      view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, start + offset) }, userEvent: "select.pointer" });
      view.focus();
    });
    const measure = () => {
      if (!dom.isConnected) return;
      const height = dom.getBoundingClientRect().height;
      if (!height) return;
      heights.set(this.key, height);
      if (heights.size > HEIGHT_LIMIT) heights.delete(heights.keys().next().value!);
    };
    requestAnimationFrame(measure);
    return dom;
  }

  private draw(node: DrawnNode, parent: HTMLElement) {
    const at = (dom: HTMLElement) => {
      dom.dataset.offset = String(node.from);
      parent.append(dom);
      return dom;
    };
    switch (node.kind) {
      case "row": {
        const row = at(element("div", "lx-tex-float-row"));
        for (const item of node.items) this.draw(item, row);
        return;
      }
      case "panel": {
        const panel = at(element("div", "lx-tex-float-panel"));
        if (node.width !== null) panel.style.setProperty("--lx-tex-share", String(node.width));
        for (const child of node.children) this.draw(child, panel);
        return;
      }
      case "image":
        at(this.image(node));
        return;
      case "caption": {
        const caption = at(element("div", node.sub ? classes("lx-tex-float-caption", "is-sub") : "lx-tex-float-caption"));
        if (node.prefix) caption.append(element("span", "lx-tex-caption-label", node.prefix));
        // An empty caption (as a pasted figure brings) reads as one to fill in; a click lands between its braces.
        if (node.text.trim()) caption.append(renderInline(node.text, this.context));
        else caption.append(element("span", "lx-tex-caption-empty", i18n._(msg`Add a caption`)));
        return;
      }
      case "table":
        at(this.table(node.table));
        return;
      case "text": {
        const text = at(element("div", "lx-tex-float-text"));
        text.append(renderInline(node.text, this.context));
        if (!text.textContent?.trim()) text.remove();
        return;
      }
      case "opaque":
        at(element("div", "lx-tex-float-opaque", opaqueName(node.name)));
        return;
      case "label":
        return;
    }
  }

  private image(node: Extract<DrawnNode, { kind: "image" }>): HTMLElement {
    const dom = element("div", classes("lx-tex-float-image", "is-loading"));
    if (node.width !== null) dom.style.setProperty("--lx-tex-share", String(node.width));
    const path = node.resolved ?? node.path;
    dom.setAttribute("aria-label", path);
    const settle = (content: Node | string, state: "loaded" | "failed") => {
      dom.classList.remove("is-loading");
      dom.classList.add(`is-${state}`);
      dom.replaceChildren(content);
      EditorView.findFromDOM(dom)?.requestMeasure();
    };
    const loading = node.resolved && !/^https?:/.test(node.resolved) ? this.load(node.resolved) : Promise.resolve(null);
    void loading.then((source) => {
      if (!source) return settle(i18n._(msg`No preview for ${path}; the PDF shows it.`), "failed");
      const image = element("img");
      image.alt = path;
      image.src = source;
      image.addEventListener("load", () => EditorView.findFromDOM(dom)?.requestMeasure(), { once: true });
      settle(image, "loaded");
    }, () => settle(i18n._(msg`${path} could not be read.`), "failed"));
    return dom;
  }

  private table(table: Table): HTMLElement {
    const scroll = element("div", "lx-tex-table-scroll");
    const dom = element("table", table.fullWidth ? classes("lx-tex-table", "is-full") : "lx-tex-table");
    const body = element("tbody");
    for (const row of table.rows) {
      const tr = element("tr");
      if (row.above) tr.classList.add(`rule-above-${row.above}`);
      if (row.below) tr.classList.add(`rule-below-${row.below}`);
      let column = 0;
      for (const cell of row.cells) {
        const td = element("td", `is-${cell.align}`);
        td.dataset.offset = String(cell.from);
        if (cell.colspan > 1) td.colSpan = cell.colspan;
        if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
        if (cell.left) td.classList.add("rule-left");
        if (cell.right) td.classList.add("rule-right");
        if (table.columns[column]?.wraps) td.classList.add("wraps");
        if (row.partialBelow.some((index) => index >= column && index < column + cell.colspan)) td.classList.add("rule-below-partial");
        td.append(renderInline(cell.text, this.context));
        tr.append(td);
        column += cell.colspan;
      }
      body.append(tr);
    }
    dom.append(body);
    scroll.append(dom);
    return scroll;
  }

  get estimatedHeight(): number {
    return heights.get(this.key) ?? 240;
  }

  ignoreEvent(event: Event): boolean {
    return isMouse(event);
  }
}
