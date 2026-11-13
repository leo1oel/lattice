/**
 * Visual mode's decorations from the constructs a scan found. Two sets:
 *
 * - `replacements`: what hides or stands for source (widgets, hidden
 *   command tokens). It depends on the selection: a construct the caret or
 *   a selection end touches shows its source (R1), a styled argument only
 *   shows faint braces (R2), and a list marker always draws (R3). It is
 *   also the editor's atomic ranges, so the caret steps over what it hides.
 * - `styles`: marks and line classes (bold, a heading's size, a list's
 *   indent, a figure's box). They never depend on the selection, so showing
 *   a construct's source moves little else on screen.
 */
import { Decoration, type DecorationSet } from "@codemirror/view";
import type { EditorSelection, EditorState, Range, RangeSet, RangeValue } from "@codemirror/state";
import { msg } from "@lingui/core/macro";
import { i18n } from "../../../i18n";
import { figureEntryBeside } from "../../../project/figure-source-open";
import type { LatexVisualHost } from "../latex-visual-switch";
import { resolveProjectPath } from "../latex-symbols";
import { overlaysTouch } from "../../source-overlays";
import type { Construct, ScanFrame, Span } from "./visual-scan";
import { BOXED_ENVIRONMENTS, FIGURE_ENVIRONMENTS, LIST_ENVIRONMENTS, TABLE_ENVIRONMENTS } from "./visual-symbols";
import { macroRevision, mathHtml, visualMathSource } from "./visual-math";
import { BarWidget, FigureWidget, ImageWidget, IncludeWidget, MarkerWidget, MathWidget, PlaceholderWidget, TextWidget, TitleWidget, type FigurePicture } from "./visual-widgets";
import { figureEntryGraphic, figureEntryLabels } from "./visual-figure";
import { frontMatter } from "./visual-front-matter";
import { parseFloat, type FloatNode } from "./visual-float";
import { FloatWidget } from "./visual-float-widget";
import {
  captionLabel, citationIndex, citationText, compoundNumber, drawnNodes, environmentTitle, equationTag, floatOfTable, identity, indexed,
  inlineContext, referenceText, type DrawContext,
} from "./visual-numbering";

export type { DrawContext } from "./visual-numbering";

/** The preamble Visual mode folds away: from the start through the `\begin{document}` line. */
export type Preamble = { to: number } | null;

const hidden = Decoration.replace({});
/** A class list from single class names. */
const classes = (...names: string[]) => names.join(" ");
const lineDecorations = new Map<string, Decoration>();
/** One line decoration per class list, shared across builds. */
function lineClass(className: string): Decoration {
  let decoration = lineDecorations.get(className);
  if (!decoration) {
    decoration = Decoration.line({ class: className });
    lineDecorations.set(className, decoration);
  }
  return decoration;
}
const markDecorations = new Map<string, Decoration>();
function markClass(className: string): Decoration {
  let decoration = markDecorations.get(className);
  if (!decoration) {
    decoration = Decoration.mark({ class: className, inclusive: true });
    markDecorations.set(className, decoration);
  }
  return decoration;
}

/** Selection ends, sorted: a construct is touched when one lies inside it, both its edges included. */
export function selectionPoints(selection: EditorSelection): number[] {
  return selection.ranges.flatMap((range) => [range.anchor, range.head]).sort((a, b) => a - b);
}

function touches(points: readonly number[], from: number, to: number): boolean {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (points[middle] < from) low = middle + 1;
    else high = middle;
  }
  return low < points.length && points[low] <= to;
}

/** `[from, to]` widened to whole lines when only blanks share those lines with it, else null. */
function wholeLines(state: EditorState, from: number, to: number): Span | null {
  const first = state.doc.lineAt(from);
  const last = state.doc.lineAt(to);
  if (first.text.slice(0, from - first.from).trim() || last.text.slice(to - last.from).trim()) return null;
  return { from: first.from, to: last.to };
}

/** The span a construct shows its source for when the selection touches it. */
function revealSpan(state: EditorState, construct: Construct): Span {
  if ((construct.kind === "math" && construct.environment) || construct.kind === "environment" || construct.kind === "block") {
    return { from: state.doc.lineAt(construct.from).from, to: state.doc.lineAt(construct.to).to };
  }
  return construct;
}

/** Which constructs show their source: those a selection end touches, and those under an overlay (a change, a comment, a caret). */
export function revealedConstructs(
  state: EditorState, constructs: readonly Construct[], points: readonly number[], overlays: readonly RangeSet<RangeValue>[],
): boolean[] {
  return constructs.map((construct) => {
    const span = revealSpan(state, construct);
    return touches(points, span.from, span.to) || overlaysTouch(overlays, construct.from, construct.to);
  });
}

const BULLETS = ["•", "◦", "▪", "‣"];
function enumeration(index: number, depth: number): string {
  const level = (depth - 1) % 4;
  if (level === 0) return `${index}.`;
  if (level === 1) return `(${String.fromCharCode(96 + ((index - 1) % 26) + 1)})`;
  if (level === 2) return `${roman(index)}.`;
  return `${String.fromCharCode(64 + ((index - 1) % 26) + 1)}.`;
}
function roman(value: number): string {
  const numerals: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [amount, numeral] of numerals) while (value >= amount) { out += numeral; value -= amount; }
  return out;
}

function imageWidth(options: string): number | null {
  const match = /(?:^|,)\s*width\s*=\s*([\d.]*)\s*\\(?:linewidth|textwidth|columnwidth|hsize)/.exec(options);
  if (!match) return null;
  const value = match[1] ? Number(match[1]) : 1;
  return Number.isFinite(value) && value > 0 ? Math.min(value, 1) : null;
}

/** The pictures an editable figure may draw: what the reference-image loader previews. */
const FIGURE_GRAPHIC = /\.(?:pdf|png|jpe?g|gif|svg)$/i;

/**
 * The graphic an entry includes, from the project root: beside the entry,
 * with the extension LaTeX would try first. Only a picture the project lists
 * is read (an entry is anyone's file, and may name any path); otherwise the
 * PDF named after the entry, as drawing programs write it.
 */
function entryGraphic(entry: string, written: string | null, projectPaths: readonly string[]): string {
  const folder = entry.slice(0, entry.lastIndexOf("/") + 1);
  const fallback = `${folder}${entry.slice(folder.length).replace(/\.tex$/i, "")}.pdf`;
  if (!written || written.includes("..") || written.startsWith("/")) return fallback;
  const path = `${folder}${written.replace(/^\.\//, "")}`;
  const candidates = FIGURE_GRAPHIC.test(path) ? [path] : [".pdf", ".png", ".jpg", ".jpeg"].map((extension) => path + extension);
  return candidates.find((candidate) => projectPaths.includes(candidate)) ?? fallback;
}

/** An editable figure's graphic and labels, read from its entry file when the widget is drawn. */
function figurePicture(entry: string, host: LatexVisualHost, projectPaths: readonly string[]): () => Promise<FigurePicture> {
  return async () => {
    const text = await (host.readFile?.(entry) ?? Promise.resolve(""));
    const graphic = entryGraphic(entry, figureEntryGraphic(text), projectPaths);
    const image = await host.loadImage(graphic);
    return { graphic, image, labels: figureEntryLabels(text) };
  };
}

/**
 * The replacements for `constructs` with `revealed` deciding which show
 * their source, plus the folded preamble and the end of the document.
 */
export function buildReplacements(
  context: DrawContext, constructs: readonly Construct[], revealed: readonly boolean[], preamble: { span: Preamble; revealed: boolean },
  endDocument: { span: Span; revealed: boolean } | null,
): DecorationSet {
  const { state, host } = context;
  const ranges: Range<Decoration>[] = [];
  const add = (from: number, to: number, decoration: Decoration) => {
    if (from < to || (from === to && decoration.point)) ranges.push(decoration.range(from, to));
  };
  const data = host.data();
  const macros = data.katexMacros;
  const citations = indexed(citationIndex, data.citations, (citation) => citation.key);
  const preambleEnd = preamble.span?.to ?? -1;
  // Constructs inside a range already replaced whole are drawn by that range.
  let coveredTo = -1;
  const brace = (char: string) => Decoration.replace({ widget: new TextWidget(char, "lx-tex-brace") });
  /** The line a run of commands that print nothing ends on, when it is only them: hidden whole, line and all. */
  let silentLineTo = -1;

  if (preamble.span) {
    if (!preamble.revealed) {
      const label = i18n._(msg`Show preamble`);
      add(0, preamble.span.to, Decoration.replace({ widget: new BarWidget(label, "lx-tex-preamble"), block: true }));
    } else {
      const label = i18n._(msg`Hide preamble`);
      add(0, 0, Decoration.widget({ widget: new BarWidget(label, classes("lx-tex-preamble", "is-open"), preamble.span.to + 1), block: true, side: -1 }));
    }
  }

  constructs.forEach((construct, index) => {
    if (construct.from < coveredTo || construct.from <= preambleEnd) return;
    const touched = revealed[index];
    switch (construct.kind) {
      case "style":
      case "link": {
        if (construct.open.to >= construct.close.from) return;
        const footnote = construct.kind === "style" && construct.style === "footnote";
        add(construct.open.from, construct.open.to, touched ? brace("{")
          : footnote ? Decoration.replace({ widget: new TextWidget("†", "lx-tex-footnote-mark") }) : hidden);
        add(construct.close.from, construct.close.to, touched ? brace("}") : hidden);
        return;
      }
      case "heading":
      case "caption": {
        if (touched) return;
        if (!state.sliceDoc(construct.open.to, construct.close.from).trim()) {
          // An empty caption (as a pasted figure brings) reads as one to fill in; a click opens its braces.
          if (construct.kind !== "caption" || !construct.float) return;
          const label = captionLabel(construct, context);
          add(construct.from, construct.to, Decoration.replace({
            widget: new PlaceholderWidget(`${label}${i18n._(msg`Add a caption`)}`, classes("lx-tex-caption-empty"), construct.open.to - construct.from),
          }));
          return;
        }
        const label = construct.kind === "caption" && construct.float ? captionLabel(construct, context) : "";
        add(construct.open.from, construct.open.to, label ? Decoration.replace({ widget: new TextWidget(label, "lx-tex-caption-label") }) : hidden);
        add(construct.close.from, construct.close.to, hidden);
        return;
      }
      case "math": {
        if (touched) return;
        const body = state.sliceDoc(construct.body.from, construct.body.to);
        if (!body.trim()) return;
        const source = visualMathSource(body, construct.environment, equationTag(construct, context, body));
        const html = mathHtml(source, construct.display, macros);
        const key = `${macroRevision(macros)}:${construct.display ? 1 : 0}:${source}`;
        const lines = construct.display ? wholeLines(state, construct.from, construct.to) : null;
        const from = lines?.from ?? construct.from;
        const to = lines?.to ?? construct.to;
        const widget = new MathWidget(html, state.sliceDoc(construct.from, construct.to), construct.display, key, construct.body.from - from);
        add(from, to, Decoration.replace({ widget, block: construct.display }));
        coveredTo = to;
        return;
      }
      case "symbol":
        if (touched) return;
        if (!construct.text) {
          if (construct.to <= silentLineTo) return;
          // Commands that print nothing (`\vspace{4pt}`, `{\centering\small`), alone on their line, take the line with them.
          const run = silentRun(state, constructs, revealed, index);
          const lines = wholeLines(state, construct.from, run);
          if (lines && lines.from >= coveredTo) {
            add(lines.from, lines.to, Decoration.replace({ block: true }));
            silentLineTo = lines.to;
            return;
          }
          add(construct.from, construct.to, hidden);
          return;
        }
        add(construct.from, construct.to, Decoration.replace({ widget: new TextWidget(construct.text, "lx-tex-symbol") }));
        return;
      case "reference":
        if (touched) return;
        add(construct.from, construct.to, Decoration.replace({
          widget: new TextWidget(referenceText(construct, context), classes("lx-tex-chip", "lx-tex-ref"), construct.keys.join(", ")),
        }));
        return;
      case "citation":
        if (touched) return;
        add(construct.from, construct.to, Decoration.replace({
          widget: new TextWidget(citationText(construct, citations), classes("lx-tex-chip", "lx-tex-cite"), construct.keys.join(", ")),
        }));
        return;
      case "compound": {
        if (touched) return;
        const number = construct.keys.map((key) => compoundNumber(key, context)).join(", ");
        add(construct.from, construct.to, Decoration.replace({ widget: new TextWidget(number, classes("lx-tex-chip", "lx-tex-compound"), construct.keys.join(", ")) }));
        return;
      }
      case "label":
        if (touched) return;
        add(construct.from, construct.to, Decoration.replace({ widget: new TextWidget(construct.key, classes("lx-tex-chip", "lx-tex-label")) }));
        return;
      case "include": {
        if (touched) return;
        const target = resolveProjectPath(construct.path, data.projectPaths, "tex", [], data.rootDocumentPath);
        const entry = target && host.readFile ? figureEntryBeside(target, data.projectPaths) : null;
        const lines = entry ? wholeLines(state, construct.from, construct.to) : null;
        if (entry && lines) {
          const openDrawing = host.openDrawing ? () => host.openDrawing?.(entry) : null;
          const widget = new FigureWidget(
            entry, figurePicture(entry, host, data.projectPaths), (key) => compoundNumber(key, context),
            context.compounds ?? null, openDrawing, construct.from - lines.from,
          );
          add(lines.from, lines.to, Decoration.replace({ widget, block: true }));
          coveredTo = lines.to;
          return;
        }
        const open = target ? () => host.open({ kind: "include", path: target }) : null;
        add(construct.from, construct.to, Decoration.replace({ widget: new IncludeWidget(construct.path, open) }));
        return;
      }
      case "image": {
        if (touched) return;
        const resolved = resolveProjectPath(construct.path, data.projectPaths, "graphics", data.graphicsRoots, data.rootDocumentPath);
        const lines = wholeLines(state, construct.from, construct.to);
        const load = () => (resolved && !/^https?:/.test(resolved) ? host.loadImage(resolved) : Promise.resolve(null));
        const widget = new ImageWidget(resolved ?? construct.path, load, imageWidth(construct.options), Boolean(lines), lines ? construct.from - lines.from : 0);
        add(lines?.from ?? construct.from, lines?.to ?? construct.to, Decoration.replace({ widget, block: Boolean(lines) }));
        coveredTo = lines?.to ?? construct.to;
        return;
      }
      case "item": {
        const line = state.doc.lineAt(construct.from);
        const start = line.text.slice(0, construct.from - line.from).trim() ? construct.from : line.from;
        if (construct.term) {
          // `\item[term]`: the term is text to read and edit; its brackets show when the caret is at them.
          add(start, construct.term.from, Decoration.replace({ widget: touched ? new TextWidget("[", "lx-tex-brace") : new MarkerWidget("", construct.depth) }));
          add(construct.term.to, construct.to, touched ? brace("]") : Decoration.replace({ widget: new TextWidget(" ", "lx-tex-item-gap") }));
          return;
        }
        const marker = construct.list === "enumerate" ? enumeration(construct.index, construct.depth) : construct.list === "itemize" ? BULLETS[(construct.depth - 1) % BULLETS.length] : "";
        add(start, construct.to, Decoration.replace({ widget: new MarkerWidget(marker, construct.depth) }));
        return;
      }
      case "title": {
        const lines = wholeLines(state, construct.from, construct.to);
        const front = touched || !lines ? null : frontMatter(state.doc, construct.from);
        if (front) {
          const key = `${macroRevision(macros)}:${JSON.stringify(front)}`;
          const widget = new TitleWidget(front.title, front.authors, construct.from - lines!.from, key, inlineContext(context, citations));
          add(lines!.from, lines!.to, Decoration.replace({ widget, block: true }));
        }
        return;
      }
      case "block": {
        if (touched) return;
        const lines = wholeLines(state, construct.from, construct.to);
        if (!lines || lines.from < coveredTo) return;
        const source = state.sliceDoc(construct.from, construct.to);
        // A float that brings in a file (an editable figure's entry) is drawn line by line, as before.
        if (/\\(?:input|include|subfile|import|subimport)(?![A-Za-z@])/.test(source)) return;
        const bare = TABLE_ENVIRONMENTS.has(construct.name);
        // Offsets from the block's first line, where a click lands.
        const offset = construct.from - lines.from;
        const nodes: FloatNode[] = bare ? floatOfTable(source, offset) : parseFloat(source, offset);
        if (!nodes.length) return;
        const drawn = drawnNodes(nodes, construct.name.replace(/\*$/, ""), context);
        const key = [
          source, JSON.stringify(drawn), macroRevision(macros), identity(context.labels), identity(data.citations), identity(data.references),
        ].join("\u0000");
        const widget = new FloatWidget(drawn, key, (path) => host.loadImage(path), inlineContext(context, citations), bare);
        add(lines.from, lines.to, Decoration.replace({ widget, block: true }));
        coveredTo = lines.to;
        return;
      }
      case "marker": {
        if (touched) return;
        const label = construct.marker === "appendix" ? i18n._(msg`Appendix`) : i18n._(msg`References`);
        const lines = wholeLines(state, construct.from, construct.to);
        if (lines) add(lines.from, lines.to, Decoration.replace({ widget: new BarWidget(label, classes("lx-tex-env-start", "lx-tex-marker-bar"), construct.from - lines.from), block: true }));
        else add(construct.from, construct.to, Decoration.replace({ widget: new TextWidget(label, classes("lx-tex-chip", "lx-tex-marker-chip")) }));
        return;
      }
      case "centered":
        return;
      case "environment": {
        if (touched) return;
        const lines = wholeLines(state, construct.from, construct.to);
        if (!lines) return;
        const { name, begin } = construct;
        if (LIST_ENVIRONMENTS.has(name) || name === "quote" || name === "quotation" || name === "center" || (FIGURE_ENVIRONMENTS.has(name))) {
          const edge = FIGURE_ENVIRONMENTS.has(name) ? new BarWidget("", begin ? "lx-tex-float-top" : "lx-tex-float-bottom") : null;
          add(lines.from, lines.to, Decoration.replace({ widget: edge ?? undefined, block: true }));
        } else if (BOXED_ENVIRONMENTS.has(name)) {
          const title = begin ? environmentTitle(name) + (construct.argument ? ` (${construct.argument})` : "") : "";
          add(lines.from, lines.to, Decoration.replace({ widget: new BarWidget(title, begin ? classes("lx-tex-env-start", `lx-tex-env-${name.replace(/\*$/, "")}`) : "lx-tex-env-end"), block: true }));
        }
        return;
      }
    }
  });

  if (endDocument && !endDocument.revealed && endDocument.span.from > coveredTo) {
    add(endDocument.span.from, endDocument.span.to, Decoration.replace({ widget: new BarWidget(i18n._(msg`End of document`), "lx-tex-end-document"), block: true }));
  }
  return Decoration.set(ranges, true);
}
/**
 * Where a run of commands that print nothing, starting with `constructs[index]`,
 * ends: the next ones that follow it with only blanks between, none of them revealed.
 */
function silentRun(state: EditorState, constructs: readonly Construct[], revealed: readonly boolean[], index: number): number {
  let to = constructs[index].to;
  for (let next = index + 1; next < constructs.length; next++) {
    const construct = constructs[next];
    if (construct.from < to) continue;
    if (construct.kind !== "symbol" || construct.text || revealed[next] || state.sliceDoc(to, construct.from).trim()) break;
    to = construct.to;
  }
  return to;
}

/** Styling for `constructs`, independent of the selection. `open` are the environments open where the scan began. */
export function buildStyles(state: EditorState, constructs: readonly Construct[], open: readonly ScanFrame[], scan: Span): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const lineRange = (from: number, to: number, className: string) => {
    for (let line = state.doc.lineAt(from); ; line = state.doc.line(line.number + 1)) {
      ranges.push(lineClass(className).range(line.from));
      if (line.to >= to || line.number >= state.doc.lines) break;
    }
  };
  // Environments that style the lines inside them: lists indent, floats box, quotes rule.
  type Open = { name: string; from: number; depth: number };
  const stack: Open[] = [];
  let depth = 0;
  for (const frame of open) {
    if (LIST_ENVIRONMENTS.has(frame.name)) depth++;
    stack.push({ name: frame.name, from: scan.from, depth });
  }
  /** Lines inside an environment that styles them: a list's (by depth), a float's, a quote's, a centered block's. */
  const blocks: { from: number; to: number; depth: number; className: string }[] = [];
  const close = (entry: Open, to: number) => {
    if (to <= entry.from) return;
    if (LIST_ENVIRONMENTS.has(entry.name)) blocks.push({ from: entry.from, to, depth: entry.depth, className: "" });
    else if (FIGURE_ENVIRONMENTS.has(entry.name)) blocks.push({ from: entry.from, to, depth: 0, className: "lx-tex-float" });
    else if (entry.name === "quote" || entry.name === "quotation") blocks.push({ from: entry.from, to, depth: 0, className: "lx-tex-quote" });
    else if (entry.name === "center") blocks.push({ from: entry.from, to, depth: 0, className: "lx-tex-center" });
  };

  for (const construct of constructs) {
    switch (construct.kind) {
      case "style":
      case "link":
        if (construct.open.to < construct.close.from) {
          const className = construct.kind === "link" ? "lx-tex-link" : `lx-tex-${construct.style}`;
          ranges.push(markClass(className).range(construct.open.to, construct.close.from));
        }
        break;
      case "heading":
        lineRange(construct.from, construct.to, classes("lx-tex-heading", `lx-tex-heading-${construct.level}`));
        break;
      case "caption":
        lineRange(construct.from, construct.to, "lx-tex-caption");
        break;
      case "centered":
        lineRange(construct.from, construct.to, "lx-tex-center");
        break;
      case "item":
        ranges.push(lineClass("lx-tex-item").range(state.doc.lineAt(construct.from).from));
        if (construct.term) ranges.push(markClass("lx-tex-item-term").range(construct.term.from, construct.term.to));
        break;
      case "environment": {
        if (construct.begin) {
          if (LIST_ENVIRONMENTS.has(construct.name)) depth++;
          // The lines after the `\begin` line are the inside.
          stack.push({ name: construct.name, from: state.doc.lineAt(construct.to).to + 1, depth });
          break;
        }
        const index = stack.map((entry) => entry.name).lastIndexOf(construct.name);
        if (index < 0) break;
        for (const entry of stack.splice(index)) close(entry, state.doc.lineAt(construct.from).from - 1);
        depth = stack.filter((entry) => LIST_ENVIRONMENTS.has(entry.name)).length;
        break;
      }
    }
  }
  for (const entry of stack) close(entry, scan.to);
  // A line in nested lists takes the innermost one's depth; other blocks add their classes.
  const lines = new Map<number, { depth: number; classes: string[] }>();
  for (const block of blocks) {
    if (block.from > state.doc.length) continue;
    for (let line = state.doc.lineAt(block.from); ; line = state.doc.line(line.number + 1)) {
      const entry = lines.get(line.from) ?? { depth: 0, classes: [] };
      lines.set(line.from, entry);
      if (block.depth) entry.depth = Math.max(entry.depth, block.depth);
      else if (!entry.classes.includes(block.className)) entry.classes.push(block.className);
      if (line.to >= block.to || line.number >= state.doc.lines) break;
    }
  }
  for (const [from, { depth: listDepth, classes: lineClasses }] of lines) {
    const className = classes(...lineClasses, ...(listDepth ? ["lx-tex-list", `lx-tex-depth-${Math.min(listDepth, 6)}`] : []));
    ranges.push(lineClass(className).range(from));
  }
  return Decoration.set(ranges, true);
}
