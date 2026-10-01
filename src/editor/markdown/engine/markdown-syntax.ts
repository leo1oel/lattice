/**
 * Markdown syntax for Lattice's visual editor engine: one parser and two
 * serializers over the same grammar (CommonMark + GFM + `$` math).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 * Built only on unified/remark/micromark (MIT).
 */
import type { Parent, Parents, Root, RootContent, Text } from "mdast";
import { defaultHandlers, type ConstructName, type Handle, type Info, type Options, type State } from "mdast-util-to-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { autolinkLiteralSpans } from "./autolink-literal";
import { remarkLatexMath } from "./latex-math-syntax";

/** Style the parser recorded for one node, carried on `node.data.lattice` through serialization. */
/** The uppercase task box, `[X]`, recorded so an item is written back as typed (R-FMT-14). */
// eslint-disable-next-line lingui/no-unlocalized-strings -- Markdown syntax, not interface copy
export const UPPERCASE_CHECK = "X";

export type LatticeNodeStyle = {
  /** A text run as authored: each piece's `source` is emitted verbatim in literal mode. */
  pieces?: { value: string; source?: string }[];
  /** `*`/`_` for emphasis, `**`/`__` for strong, `~`/`~~` for strikethrough. */
  marker?: string;
  bullet?: string;
  delimiter?: string;
  incrementListMarker?: boolean;
  setext?: boolean;
  fence?: string;
  /** The closing fence as authored, when it differs from the opening (a longer run). */
  closeFence?: string;
  indented?: boolean;
  /** Exact syntax of a thematic break or of a hard break (without its newline). */
  markup?: string;
  /** How a link was written: `<url>` or a bare GFM literal. */
  autolink?: "angle" | "literal";
  /** Exact source of a formula, kept while its TeX is unchanged. */
  source?: string;
  /** A table's layout comment (merged cells), written directly above it. */
  layoutMarker?: string;
};

type Styled = { data?: { lattice?: LatticeNodeStyle } };
const styleOf = (node: unknown): LatticeNodeStyle | undefined => (node as Styled).data?.lattice;

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkLatexMath).freeze();

/**
 * Parse Markdown into mdast with source positions. A `$` pair that pandoc's
 * rule would not accept as a formula (prices such as `$5 and $10`) stays prose.
 */
export function parseMarkdownTree(markdown: string): Root {
  const tree = parser.parse(markdown);
  positionAutolinkLiterals(tree, markdown);
  demoteCurrencyMath(tree, markdown);
  return tree;
}

type Located = { type: string; value?: string; children?: Located[]; position?: { start: { offset?: number }; end: { offset?: number } } };

const offsetOf = (node: Located | undefined, edge: "start" | "end") => node?.position?.[edge].offset;

/**
 * GFM finds some literal autolinks after parsing, in text whose escapes are
 * already resolved (a file saved as `https\://example.com`), and the pieces
 * it splits that text into carry no source position. Each run of such pieces
 * is located again in the source it came from, so the paragraph reads as
 * text and a link instead of an unplaceable block. A run that cannot be
 * aligned stays unpositioned and its block is kept raw.
 */
function positionAutolinkLiterals(parent: Located, markdown: string) {
  const children = parent.children ?? [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    if (child.position) {
      positionAutolinkLiterals(child, markdown);
      continue;
    }
    let last = index;
    while (last + 1 < children.length && !children[last + 1]!.position) last += 1;
    const run = children.slice(index, last + 1);
    const from = offsetOf(children[index - 1], "end") ?? offsetOf(parent, "start");
    const to = offsetOf(children[last + 1], "start") ?? offsetOf(parent, "end");
    if (from != null && to != null && run.every((node) => node.type === "text" || isAutolinkPiece(node))) {
      // Between two placed siblings the run fills the gap exactly; at the
      // parent's edges it may sit after a prefix (`# `) or before a suffix.
      locateRun(run, markdown, from, to, { exactStart: index > 0, exactEnd: last + 1 < children.length });
    }
    index = last;
  }
}

const isAutolinkPiece = (node: Located) => node.type === "link" && node.children?.length === 1 && node.children[0]!.type === "text" && !node.children[0]!.position;

const pieceText = (node: Located) => (node.type === "text" ? node.value! : node.children![0]!.value!);

/** Place `run` at the first offset in `[from, to)` whose source spells its text. */
function locateRun(run: Located[], markdown: string, from: number, to: number, edges: { exactStart: boolean; exactEnd: boolean }) {
  for (let start = from; start < (edges.exactStart ? from + 1 : to); start += 1) {
    const ends: number[] = [];
    let cursor: number | null = start;
    for (const node of run) {
      cursor = spell(pieceText(node), markdown, cursor, to);
      if (cursor == null) break;
      ends.push(cursor);
    }
    if (cursor == null || (edges.exactEnd && cursor !== to)) continue;
    run.forEach((node, position) => {
      const location = { start: { offset: position ? ends[position - 1]! : start }, end: { offset: ends[position]! } };
      node.position = location as Located["position"];
      if (node.type === "link") node.children![0]!.position = { ...location };
    });
    return;
  }
}

/**
 * Where the source spelling `value` from `at` ends: each character written as
 * itself or as a backslash escape, a line break followed by the container
 * prefix of the next line. `null` when the source spells something else.
 */
function spell(value: string, markdown: string, at: number, limit: number): number | null {
  let cursor = at;
  for (const character of value) {
    if (character === "\n") {
      while (cursor < limit && (markdown[cursor] === " " || markdown[cursor] === "\t")) cursor += 1;
      if (markdown[cursor] !== "\n") return null;
      cursor += 1;
      while (cursor < limit && /[ \t>]/.test(markdown[cursor]!)) cursor += 1;
    } else if (markdown[cursor] === "\\" && markdown[cursor + 1] === character && /[!-/:-@[-`{-~]/.test(character)) {
      cursor += 2;
    } else if (markdown[cursor] === character) {
      cursor += 1;
    } else {
      return null;
    }
    if (cursor > limit) return null;
  }
  return cursor;
}

function demoteCurrencyMath(parent: Parent, markdown: string) {
  const children = parent.children as RootContent[];
  let changed = false;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    if ("children" in child) demoteCurrencyMath(child as Parent, markdown);
    if (child.type !== "inlineMath" || child.position?.start.offset == null || child.position.end.offset == null) continue;
    const source = markdown.slice(child.position.start.offset, child.position.end.offset);
    if (source.startsWith("$$") || source.startsWith("\\")) continue;
    if (/^\s|\s$/.test(child.value) || /\d/.test(markdown.charAt(child.position.end.offset))) {
      children[index] = { type: "text", value: source, position: child.position } satisfies Text;
      changed = true;
    }
  }
  if (!changed) return;
  // Any other parse yields one text node for adjacent prose; merge so the
  // demoted formula compares equal to how serialized output re-parses.
  for (let index = children.length - 1; index > 0; index -= 1) {
    const left = children[index - 1]!;
    const right = children[index]!;
    if (left.type !== "text" || right.type !== "text") continue;
    left.value += right.value;
    if (left.position && right.position) left.position = { start: left.position.start, end: right.position.end };
    children.splice(index, 1);
  }
}

/**
 * `literal` reproduces authored syntax: recorded markers and fences, and the
 * exact source of unchanged text runs, with new text written unescaped.
 * `safe` ignores recorded text and escapes whatever the grammar could misread.
 * Callers verify a `literal` result by re-parsing and fall back to `safe`.
 */
export type SerializeMode = "literal" | "safe";

/** Run `render` with one serializer option overridden, restoring it after. */
function withOption<K extends keyof Options>(state: State, key: K, value: Options[K] | undefined, render: () => string): string {
  if (value === undefined) return render();
  const previous = state.options[key];
  state.options[key] = value;
  try {
    return render();
  } finally {
    state.options[key] = previous;
  }
}

/**
 * Text escaped wherever the grammar could misread it, except inside the spans
 * GFM reads as extended autolinks: those are linked whatever their escapes,
 * so a backslash there would only become part of the link. GFM carries a
 * link on to the next whitespace, so a span is written raw only when neither
 * it nor the text up to that whitespace needs an escape (a `|` ending a table
 * cell, `]` a link label, `\*` after the URL). Otherwise the span is escaped
 * like other text, its opener too, so GFM reads it only after the escapes are
 * resolved.
 */
function safeText(value: string, state: State, info: Info): string {
  const spans = autolinkLiteralSpans(value);
  if (!spans.length) return state.safe(value, info);
  let written = "";
  let cursor = 0;
  const safe = (from: number, to: number) => state.safe(value.slice(from, to), {
    ...info,
    before: from ? value.charAt(from - 1) : info.before,
    after: to < value.length ? value.charAt(to) : info.after,
  });
  for (const [from, to] of spans) {
    if (from > cursor) written += safe(cursor, from);
    const whitespace = value.slice(to).search(/\s/u);
    const tail = whitespace < 0 ? value.length : to + whitespace;
    const escaped = safe(from, to);
    written += !/\\[|\]]/u.test(escaped) && safe(to, tail) === value.slice(to, tail)
      ? value.slice(from, to)
      : escaped.replace(/^(https?|www)([:.])|@/iu, (_match, opener: string | undefined, mark: string) => (opener ? `${opener}\\${mark}` : "\\@"));
    cursor = to;
  }
  if (value.length > cursor) written += safe(cursor, value.length);
  return written;
}

function latticeHandlers(mode: SerializeMode, stock: Record<string, Handle>): Record<string, Handle> {
  const literal = mode === "literal";
  const handlers: Record<string, Handle> = {
    text(node, _parent, state, info) {
      const pieces = styleOf(node)?.pieces;
      if (!literal) return safeText((node as Text).value, state, info);
      return pieces ? pieces.map((piece) => piece.source ?? piece.value).join("") : (node as Text).value;
    },
    emphasis: (node, parent, state, info) => withOption(
      state, "emphasis", styleOf(node)?.marker as Options["emphasis"], () => stock.emphasis!(node, parent, state, info),
    ),
    strong: (node, parent, state, info) => withOption(
      state, "strong", styleOf(node)?.marker?.charAt(0) as Options["strong"], () => stock.strong!(node, parent, state, info),
    ),
    delete(node, parent, state, info) {
      if (!literal || styleOf(node)?.marker !== "~") return stock.delete!(node, parent, state, info);
      const value = state.containerPhrasing(node as Parents, { ...info, before: "~", after: "~" });
      return `~${value}~`;
    },
    listItem(node, parent, state, info) {
      const written = stock.listItem!(node, parent, state, info);
      // An authored uppercase task marker stays uppercase (R-FMT-14).
      return styleOf(node)?.marker === UPPERCASE_CHECK ? written.replace(/^(\s*(?:\d{1,9}[.)]|[-+*])\s+)\[x\]/, `$1[${UPPERCASE_CHECK}]`) : written;
    },
    heading: (node, parent, state, info) => withOption(
      state, "setext", literal ? styleOf(node)?.setext : undefined, () => stock.heading!(node, parent, state, info),
    ),
    list(node, parent, state, info) {
      const style = literal ? styleOf(node) : undefined;
      const ordered = (node as { ordered?: boolean | null }).ordered;
      const marker = ordered ? style?.delimiter : style?.bullet;
      return withOption(state, ordered ? "bulletOrdered" : "bullet", marker as never, () => (
        withOption(state, "incrementListMarker", style?.incrementListMarker, () => stock.list!(node, parent, state, info))
      ));
    },
    thematicBreak(node, parent, state, info) {
      const markup = styleOf(node)?.markup;
      return literal && markup ? markup : stock.thematicBreak!(node, parent, state, info);
    },
    break(node, parent, state, info) {
      const markup = styleOf(node)?.markup;
      return literal && markup ? `${markup}\n` : stock.break!(node, parent, state, info);
    },
    code(node, parent, state, info) {
      const style = styleOf(node);
      const code = node as { value: string; lang?: string | null; meta?: string | null };
      if (!literal || (!style?.fence && !style?.indented)) return stock.code!(node, parent, state, info);
      if (style.indented && !code.lang && !code.meta && code.value.trim() !== "" && !/^\n|\n$/.test(code.value)) {
        return code.value.split("\n").map((line) => (line ? `    ${line}` : line)).join("\n");
      }
      const marker = style.fence?.charAt(0) === "~" ? "~" : "`";
      let longest = 0;
      for (const run of code.value.match(marker === "~" ? /~+/g : /`+/g) ?? []) longest = Math.max(longest, run.length);
      const fence = marker.repeat(Math.max(style.fence?.length ?? 3, longest + 1, 3));
      // A longer closing run, as authored, still closes the same fence.
      const close = style.closeFence?.charAt(0) === marker && style.closeFence.length >= fence.length ? style.closeFence : fence;
      const infoString = [code.lang, code.meta].filter(Boolean).join(" ");
      return code.value ? `${fence}${infoString}\n${code.value}\n${close}` : `${fence}${infoString}\n${close}`;
    },
    link(node, parent, state, info) {
      const link = node as { url: string; title?: string | null; children: RootContent[] };
      const only = link.children.length === 1 ? link.children[0] : undefined;
      if (literal && styleOf(node)?.autolink === "literal" && only?.type === "text" && !link.title) {
        const text = only.value;
        if (link.url === text || link.url === `http://${text}` || link.url === `mailto:${text}`) return text;
      }
      return stock.link!(node, parent, state, info);
    },
    inlineMath(node, parent, state, info) {
      const source = styleOf(node)?.source;
      return literal && source ? source : stock.inlineMath!(node, parent, state, info);
    },
    math(node, parent, state, info) {
      const source = styleOf(node)?.source;
      return literal && source ? source : stock.math!(node, parent, state, info);
    },
    table(node, parent, state, info) {
      const marker = styleOf(node)?.layoutMarker;
      const lines = stock.table!(node, parent, state, info).split("\n");
      // The delimiter row as Lattice writes it (spec §11.14): `---`, `:---`, `---:`, `:---:`.
      if (lines[1]) lines[1] = lines[1].replace(/:?-+:?/g, (cell) => `${cell.startsWith(":") ? ":" : ""}---${cell.length > 1 && cell.endsWith(":") ? ":" : ""}`);
      const table = lines.join("\n");
      return marker ? `${marker}\n\n${table}` : table;
    },
    // An MDX component: its tags as recorded, around its exact body or its
    // re-serialized blocks (see document-to-markdown).
    latticeComponent(node, _parent, state, info) {
      const component = node as unknown as { open: string; close: string; inner?: string; lead?: string; trail?: string; children?: RootContent[] };
      if (component.inner != null) return `${component.open}${component.inner}${component.close}`;
      const body = component.children?.length ? state.containerFlow(node as Parameters<State["containerFlow"]>[0], info) : "";
      return body ? `${component.open}${component.lead}${body}${component.trail}${component.close}` : `${component.open}\n\n${component.close}`;
    },
    latticeHighlight(node, _parent, state, info) {
      return `==${state.containerPhrasing(node as Parameters<State["containerPhrasing"]>[0], { ...info, before: "=", after: "=" })}==`;
    },
    latticeUnderline(node, _parent, state, info) {
      // eslint-disable-next-line lingui/no-unlocalized-strings -- HTML markup written into the document
      return `<u>${state.containerPhrasing(node as Parameters<State["containerPhrasing"]>[0], { ...info, before: ">", after: "<" })}</u>`;
    },
    // Verbatim inline source. Unlike `html`, a line break before it stays a
    // line break; the caller's verification catches the rare line start where
    // that would now read as block HTML, and `safe` mode writes it as `html`.
    latticeRaw: (node) => (node as { value: string }).value,
  };
  // Phrasing asks the next sibling's `peek` for its first character. Without
  // one it runs the whole handler, and that handler's attention-encoding side
  // effect then lands on the wrong sibling. Peeks must be side-effect free.
  const peeks: Record<string, Handle> = {
    emphasis: (node, _parent, state) => (literal && styleOf(node)?.marker) || state.options.emphasis || "*",
    strong: (node, _parent, state) => (literal && styleOf(node)?.marker?.charAt(0)) || state.options.strong || "*",
    delete: () => "~",
    latticeRaw: (node) => (node as { value: string }).value.charAt(0),
    inlineMath: () => "$",
    latticeHighlight: () => "=",
    latticeUnderline: () => "<",
    link(node, parent, state, info) {
      const only = (node as { children: RootContent[] }).children[0];
      if (literal && styleOf(node)?.autolink === "literal" && only?.type === "text") return only.value.charAt(0);
      return (stock.link as Handle & { peek: Handle }).peek(node, parent, state, info);
    },
  };
  for (const [name, peek] of Object.entries(peeks)) Object.assign(handlers[name]!, { peek });
  return handlers;
}

const notInPhrasingText: ConstructName[] = ["autolink", "destinationLiteral", "destinationRaw", "reference", "titleQuote", "titleApostrophe", "image", "imageReference"];

const baseOptions: Options = {
  // `==` would read back as a highlight, and `[[` as a wiki link (inline-syntax.ts).
  unsafe: [
    { character: "=", after: "=", inConstruct: "phrasing", notInConstruct: notInPhrasingText },
    { character: "[", after: "\\[", inConstruct: "phrasing", notInConstruct: notInPhrasingText },
  ],
  bullet: "-",
  emphasis: "*",
  strong: "*",
  fence: "`",
  rule: "-",
  listItemIndent: "one",
  resourceLink: false,
};

/**
 * Table cells padded with single spaces (spec §11.14): an edited cell
 * rewrites its own row, not the column widths of every other row.
 */
const gfmOptions = { tablePipeAlign: false };

type Unsafe = NonNullable<Options["unsafe"]>[number];
type ToMarkdownExtension = Options & { extensions?: ToMarkdownExtension[] };

/**
 * The escapes GFM's serializer writes into bare URLs, `www.` hosts and email
 * addresses (`https\://`, `www\.`, `a\@b`). The parser links that text
 * after resolving escapes, so they never keep it plain; they only corrupt the
 * text the reader typed. Such text is written as is and reads back as a
 * literal autolink, which is the same reading (semantic-key.ts).
 */
const autolinkLiteralGuard = (pattern: Unsafe) => (
  (pattern.character === ":" && pattern.before === "[ps]")
  || (pattern.character === "." && pattern.before === "[Ww]")
  || (pattern.character === "@" && pattern.after === "[\\-.\\w]")
);

function withoutAutolinkGuards(extension: ToMarkdownExtension): ToMarkdownExtension {
  return {
    ...extension,
    ...(extension.unsafe ? { unsafe: extension.unsafe.filter((pattern) => !autolinkLiteralGuard(pattern)) } : {}),
    ...(extension.extensions ? { extensions: extension.extensions.map(withoutAutolinkGuards) } : {}),
  };
}

/** Drop the autolink-literal escapes from the extensions registered before it. */
function remarkPlainAutolinkLiterals(this: ReturnType<typeof unified>) {
  const data = this.data();
  data.toMarkdownExtensions = (data.toMarkdownExtensions ?? []).map((extension) => withoutAutolinkGuards(extension as ToMarkdownExtension));
}

type Processor = { stringify: (tree: Root) => string };
const processors = new Map<SerializeMode, Processor>();

function processorFor(mode: SerializeMode): Processor {
  const cached = processors.get(mode);
  if (cached) return cached;
  // Every wrapper delegates to the stock handler: mdast-util-to-markdown's
  // core table plus whatever the GFM and math extensions contribute.
  const stock: Record<string, Handle> = { ...(defaultHandlers as Record<string, Handle>) };
  type Extension = { handlers?: Record<string, Handle>; extensions?: Extension[] };
  const collect = (extension: Extension) => {
    Object.assign(stock, extension.handlers);
    extension.extensions?.forEach(collect);
  };
  const probe = unified().use(remarkGfm, gfmOptions).use(remarkMath).freeze();
  ((probe.data("toMarkdownExtensions") ?? []) as Extension[]).forEach(collect);
  const built = unified()
    .use(remarkStringify, { ...baseOptions, handlers: latticeHandlers(mode, stock) })
    .use(remarkGfm, gfmOptions)
    .use(remarkMath)
    .use(remarkPlainAutolinkLiterals)
    .freeze();
  const processor: Processor = { stringify: (tree) => built.stringify(tree) };
  processors.set(mode, processor);
  return processor;
}

/** Serialize block-level mdast, without the final newline remark-stringify appends. */
export function stringifyMarkdownTree(tree: Root, mode: SerializeMode): string {
  if (mode === "safe") asHtml(tree);
  return processorFor(mode).stringify(tree).replace(/\n$/, "");
}

/** In safe mode verbatim inline source is written as `html`, with the serializer's own line-start guard. */
function asHtml(node: { type: string; children?: unknown[] }) {
  if (node.type === "latticeRaw") node.type = "html";
  for (const child of (node.children ?? []) as (typeof node)[]) asHtml(child);
}
