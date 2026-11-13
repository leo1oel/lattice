/**
 * The text Visual mode draws from the last build and the project's data:
 * reference and equation numbers, citation chips, caption labels
 * ("Figure 3:"), and a float's layout with its captions numbered and its
 * images resolved.
 */
import type { EditorState } from "@codemirror/state";
import { msg } from "@lingui/core/macro";
import { i18n } from "../../../i18n";
import type { CompiledLabel } from "../compiled-labels";
import { numberedKey, type CompoundNumbers } from "../compound-keys";
import type { LatexVisualHost } from "../latex-visual-switch";
import { resolveProjectPath } from "../latex-symbols";
import { referenceKindLabel, type CitationInfo, type ReferenceInfo } from "../latex-text";
import type { Construct } from "./visual-scan";
import { ACKNOWLEDGMENT_ENVIRONMENTS, REFERENCE_COMMANDS } from "./visual-symbols";
import type { FloatNode } from "./visual-float";
import type { DrawnNode } from "./visual-float-widget";
import type { InlineContext } from "./visual-inline";
import type { ChipPart } from "./visual-widgets";
import { parseTable } from "./visual-table";

/** What a build reads beyond the constructs: the project's data and the last build's numbers. */
export type DrawContext = {
  state: EditorState;
  host: LatexVisualHost;
  /** The last build's label numbers; null before the first build (every number reads "?"). */
  labels: ReadonlyMap<string, CompiledLabel> | null;
  /** The compound numbers chemnum gave in the last build; null before the first build (every number reads "?"). */
  compounds?: CompoundNumbers | null;
};

/** An environment's name as a heading: `theorem*` reads "Theorem". */
export const environmentTitle = (name: string) => (ACKNOWLEDGMENT_ENVIRONMENTS.has(name)
  ? i18n._(msg`Acknowledgments`)
  : name.replace(/\*$/, "").replace(/^./, (first) => first.toUpperCase()));

/** A number for each object identity, so a widget's key changes when the data it was drawn from does. */
const identities = new WeakMap<object, number>();
let nextIdentity = 1;
export function identity(value: object | null | undefined): number {
  if (!value) return 0;
  let known = identities.get(value);
  if (known === undefined) {
    known = nextIdentity++;
    identities.set(value, known);
  }
  return known;
}

/** How the rich text of a float, a table or the title block reads references, citations and macros. */
export function inlineContext(context: DrawContext, citations: Map<string, CitationInfo>): InlineContext {
  return {
    macros: context.host.data().katexMacros,
    reference: (command, keys) => referenceText({ kind: "reference", command, keys, from: 0, to: 0 }, context),
    citation: (command, keys, notes) => citationText({ kind: "citation", command, keys, notes, from: 0, to: 0 }, citations),
  };
}

/**
 * A float's layout with what the last build and the project add: captions
 * numbered ("Figure 3:", subfigures "(a)"), images resolved to project paths.
 */
export function drawnNodes(nodes: readonly FloatNode[], float: string, context: DrawContext): DrawnNode[] {
  const data = context.host.data();
  let letter = 0;
  const draw = (node: FloatNode): DrawnNode => {
    switch (node.kind) {
      case "row": return { ...node, items: node.items.map(draw) };
      case "panel": return { ...node, children: node.children.map(draw) };
      case "image": {
        const resolved = resolveProjectPath(node.path, data.projectPaths, "graphics", data.graphicsRoots, data.rootDocumentPath);
        return { ...node, resolved };
      }
      case "caption": {
        if (node.sub) return { ...node, prefix: `(${String.fromCharCode(97 + (letter++ % 26))}) ` };
        const type = node.type ?? float;
        return { ...node, prefix: type ? floatCaptionLabel(type, node.label, context) : "" };
      }
      default: return node;
    }
  };
  return nodes.map(draw);
}


/** The authors a citation card shows, cut to what a chip has room for: "Vaswani et al." */
function citationAuthors(authors: string): string {
  const people = authors.split(/\s+and\s+|;\s*/).map((person) => person.trim()).filter(Boolean);
  if (!people.length) return "";
  const first = people[0].includes(",") ? people[0].split(",")[0] : people[0].split(/\s+/).at(-1) ?? people[0];
  if (people.length === 1) return first;
  if (people.length === 2) {
    const second = people[1].includes(",") ? people[1].split(",")[0] : people[1].split(/\s+/).at(-1) ?? people[1];
    return i18n._(msg`${first} and ${second}`);
  }
  return i18n._(msg`${first} et al.`);
}

/** Lookups built once per data array, not per chip. */
export const citationIndex = new WeakMap<CitationInfo[], Map<string, CitationInfo>>();
const referenceIndex = new WeakMap<ReferenceInfo[], Map<string, ReferenceInfo>>();
export function indexed<T>(cache: WeakMap<T[], Map<string, T>>, list: T[] | undefined, key: (item: T) => string): Map<string, T> {
  if (!list) return new Map();
  let index = cache.get(list);
  if (!index) {
    index = new Map(list.map((item) => [key(item), item]));
    cache.set(list, index);
  }
  return index;
}

/** Parts joined with `separator` between them. */
function joined(parts: readonly ChipPart[], separator: string): ChipPart[] {
  return parts.flatMap((part, index) => (index ? [{ text: separator }, part] : [part]));
}

/** A citation chip's words, each key's own: "[Vaswani et al., 2017; Devlin et al., 2019]". */
export function citationParts(construct: Extract<Construct, { kind: "citation" }>, citations: Map<string, CitationInfo>): ChipPart[] {
  const textual = /^(?:citet|Citet|textcite|Textcite|citealt|Citealt)$/.test(construct.command);
  const entries = construct.keys.map((key) => {
    const info = citations.get(key);
    const authors = info ? citationAuthors(info.authors) : "";
    if (!info || !authors) return { key, label: key, year: "" };
    return { key, label: authors, year: info.year };
  });
  if (construct.command === "citeauthor" || construct.command === "Citeauthor") {
    return joined(entries.map(({ key, label }) => ({ key, text: label })), "; ");
  }
  if (construct.command === "citeyear" || construct.command === "citeyearpar") {
    return joined(entries.map(({ key, label, year }) => ({ key, text: year || label })), "; ");
  }
  const note = construct.notes.at(-1)?.replace(/~/g, " ").trim();
  if (textual) return joined(entries.map(({ key, label, year }) => ({ key, text: year ? `${label} (${year})` : label })), "; ");
  const inner = joined(entries.map(({ key, label, year }) => ({ key, text: year ? `${label}, ${year}` : label })), "; ");
  return [{ text: "[" }, ...inner, { text: note ? `, ${note}]` : "]" }];
}

/** A reference chip's words, each label's own: "Section 2, 3". */
export function referenceParts(construct: Extract<Construct, { kind: "reference" }>, context: DrawContext): ChipPart[] {
  const style = REFERENCE_COMMANDS.get(construct.command) ?? "number";
  const references = indexed(referenceIndex, context.host.data().references, (reference) => reference.label);
  const parts = construct.keys.map((key) => {
    const compiled = context.labels?.get(key);
    const number = (style === "page" ? compiled?.page : compiled?.number) || "?";
    if (style === "parenthesized") return { key, text: `(${number})` };
    if (style !== "named") return { key, text: number };
    const kind = references.get(key)?.kind;
    return { key, text: kind ? `${referenceKindLabel(kind)} ${number}` : number };
  });
  return joined(parts, ", ");
}

const plain = (parts: readonly ChipPart[]) => parts.map((part) => part.text).join("");

/** A citation's words as plain text, for the rich text of a caption or a cell. */
export function citationText(construct: Extract<Construct, { kind: "citation" }>, citations: Map<string, CitationInfo>): string {
  return plain(citationParts(construct, citations));
}

/** A reference's words as plain text: "Section 2, 3". */
export function referenceText(construct: Extract<Construct, { kind: "reference" }>, context: DrawContext): string {
  return plain(referenceParts(construct, context));
}

/** A labelled equation's number from the last build: "?" before one, or for a label it never saw. */
export function equationTag(construct: Extract<Construct, { kind: "math" }>, context: DrawContext, body: string): string | null {
  const environment = construct.environment;
  if (!environment || environment.endsWith("*") || environment === "displaymath" || environment === "math") return null;
  const labels = [...body.matchAll(/\\label\s*\{([^}]*)\}/g)].map((match) => match[1].trim());
  if (labels.length !== 1 || /\\(?:nonumber|notag|tag)\b/.test(body)) return null;
  return context.labels?.get(labels[0])?.number || "?";
}

/** A compound key's number from the last build: `key.sub.num` is recorded as `key.sub`, a series mark as `A:key`. */
export function compoundNumber(key: string, context: DrawContext): string {
  const numbers = context.compounds;
  return numbers?.get(key) ?? numbers?.get(numberedKey(key)) ?? "?";
}

/** "Figure 3:" for a float's caption: its float's name and the number the last build gave its label. */
export function captionLabel(construct: Extract<Construct, { kind: "caption" }>, context: DrawContext): string {
  const float = construct.float?.replace(/\*$/, "");
  if (!float || float === "subfigure" || float === "wrapfigure") return "";
  return floatCaptionLabel(float, construct.label, context);
}

/** "Table 2: " for a caption in a `float` with `label`; "?" before a build has numbered it. */
function floatCaptionLabel(float: string, label: string | null, context: DrawContext): string {
  if (float === "subfigure" || float === "subtable" || float === "wrapfigure") return "";
  const number = (label && context.labels?.get(label)?.number) || "?";
  return `${environmentTitle(float)} ${number}: `;
}

/** A table outside a float, as a float's layout of one table. */
export function floatOfTable(source: string, offset: number): FloatNode[] {
  const table = parseTable(source, offset);
  return table ? [{ kind: "table", table, from: offset }] : [];
}
