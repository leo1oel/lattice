/**
 * Formatting the selection toolbar and the editor's keys apply to LaTeX
 * source, as toggles: a selection already in a format loses it, any other
 * selection gains it once. Applying `\textbf` to text that was already bold
 * used to wrap it again (`\textbf{\textbf{…}}`), so in Visual mode, which
 * hides the commands, Bold never undid itself.
 *
 * Pure text over a window around the selection, like `latex-highlights.ts`,
 * so the toolbar can also read which formats a selection already has on every
 * selection change. A group is found only when its braces match outside
 * comments; whatever cannot be read for certain is left as written.
 */
import { ChangeSet, type ChangeSpec } from "@codemirror/state";
import type { TextEdit } from "./latex-edits";

/** The inline formats that toggle; each writes one command and recognises its synonyms. */
export type LatexInlineFormat = "bold" | "italic" | "emphasis" | "underline" | "strikethrough";

const INLINE_FORMATS: Record<LatexInlineFormat, { write: string; reads: readonly string[] }> = {
  bold: { write: "textbf", reads: ["textbf"] },
  // Visual mode draws `\emph` and `\textit` alike, so either one is italic to
  // the toolbar's Italic and to ⌘I's emphasis: neither nests in the other.
  italic: { write: "textit", reads: ["textit", "emph"] },
  emphasis: { write: "emph", reads: ["emph", "textit"] },
  underline: { write: "underline", reads: ["underline", "uline"] },
  strikethrough: { write: "sout", reads: ["sout"] },
};

/** The sectioning commands the toolbar's heading menu offers, and the deeper ones it may meet. */
const HEADING_COMMANDS = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];

/** A selection after an edit, in the edited document. */
export type FormatEdit = { changes: TextEdit[]; selection: { anchor: number; head: number } };

/** A document as CodeMirror's `Text` reads it, so a selection need not copy the whole file. */
type Doc = { length: number; sliceString: (from: number, to?: number) => string };

/**
 * A formatted stretch: `[from, contentFrom)` opens it (`\textbf{`,
 * `\begin{quote}` and its newline), `[contentTo, to)` closes it.
 */
type Group = { from: number; to: number; contentFrom: number; contentTo: number; name: string };

/** How far from a selection a group's ends may lie (a formatted paragraph, not a chapter). */
const REACH = 4000;

function escaped(text: string, at: number): boolean {
  let slashes = 0;
  while (text[at - 1 - slashes] === "\\") slashes += 1;
  return slashes % 2 === 1;
}

/** Whether an unescaped `%` earlier on its line makes `at` a comment. */
function commented(text: string, at: number): boolean {
  for (let index = text.lastIndexOf("\n", at - 1) + 1; index < at; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === "%") return true;
  }
  return false;
}

/** Just past the brace that closes the group opened at `open`, or -1 when it never closes. */
function groupEnd(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === "%") {
      index = text.indexOf("\n", index);
      if (index < 0) return -1;
    } else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index + 1;
  }
  return -1;
}

/** Whether `[from, to)` opens no brace it does not close and closes none it did not open. */
function balanced(text: string, from: number, to: number): boolean {
  let depth = 0;
  for (let index = from; index < to; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === "%") {
      const end = text.indexOf("\n", index);
      if (end < 0 || end >= to) return false;
      index = end;
    } else if (char === "{") depth += 1;
    else if (char === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * Every `\name{…}` group in `text` whose name `names` matches (a regular
 * expression source). `options` also takes a `*` and one `[…]` before the
 * brace, as a sectioning command does.
 */
function commandGroups(text: string, names: string, options = false): Group[] {
  const pattern = new RegExp(`\\\\(${names})(?![A-Za-z@])${options ? "\\*?(?:\\[[^\\]\\n]*\\])?" : ""}[ \\t]*\\{`, "g");
  const groups: Group[] = [];
  for (const match of text.matchAll(pattern)) {
    const from = match.index;
    if (escaped(text, from) || commented(text, from)) continue;
    const open = from + match[0].length - 1;
    const to = groupEnd(text, open);
    if (to > 0) groups.push({ from, to, contentFrom: open + 1, contentTo: to - 1, name: match[1]! });
  }
  return groups;
}

/** Every `\begin{name}…\end{name}`; its content leaves out the newline after `\begin` and before `\end`. */
function environmentGroups(text: string, name: string): Group[] {
  const groups: Group[] = [];
  const open: number[] = [];
  const begin = `\\begin{${name}}`;
  const end = `\\end{${name}}`;
  const pattern = new RegExp(`\\\\(begin|end)\\{${name}\\}`, "g");
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (escaped(text, at) || commented(text, at)) continue;
    if (match[1] === "begin") {
      open.push(at);
      continue;
    }
    const from = open.pop();
    if (from === undefined) continue;
    let contentFrom = from + begin.length;
    if (text[contentFrom] === "\n") contentFrom += 1;
    let contentTo = at;
    if (contentTo > contentFrom && text[contentTo - 1] === "\n") contentTo -= 1;
    groups.push({ from, to: at + end.length, contentFrom, contentTo, name });
  }
  return groups.sort((a, b) => a.from - b.from);
}

/** The text around `[from, to)` and where it starts in the document. */
function windowAround(doc: Doc, from: number, to: number) {
  const offset = Math.max(0, from - REACH);
  return { text: doc.sliceString(offset, Math.min(doc.length, to + REACH)), offset };
}

/** `[from, to)` without the whitespace at its ends; all of it when it is only whitespace. */
function trimmed(text: string, from: number, to: number) {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(text[start]!)) start += 1;
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
  return start < end ? { from: start, to: end } : { from, to };
}

/**
 * The innermost group that holds `[from, to)`: the selection lies in its
 * content, or covers its command and nothing outside it (Visual mode hides the
 * command, so a selection dragged over a bold word may take it in).
 */
function enclosing(groups: readonly Group[], from: number, to: number): Group | null {
  let best: Group | null = null;
  for (const group of groups) {
    const holds = group.from <= from && to <= group.to
      && Math.max(from, group.contentFrom) < Math.min(to, group.contentTo);
    if (holds && (!best || group.to - group.from < best.to - best.from)) best = group;
  }
  return best;
}

/** `group` and the groups that wrap exactly it (`\textbf{\textbf{x}}`), outermost last. */
function stacked(groups: readonly Group[], group: Group): Group[] {
  const chain = [group];
  for (let outer = group; ;) {
    const parent = groups.find((candidate) => candidate.contentFrom === outer.from && candidate.contentTo === outer.to);
    if (!parent) return chain;
    chain.push(parent);
    outer = parent;
  }
}

/** Turn window edits into document edits and the selection after them. */
function finish(edits: TextEdit[], offset: number, length: number, select: (changes: ChangeSet) => { anchor: number; head: number }): FormatEdit {
  const changes = edits
    .filter((edit) => edit.from !== edit.to || edit.insert)
    .map((edit) => ({ from: edit.from + offset, to: edit.to + offset, insert: edit.insert }))
    .sort((a, b) => a.from - b.from);
  const set = ChangeSet.of(changes as ChangeSpec[], length);
  return { changes, selection: select(set) };
}

/**
 * Take `group` off `[from, to)` (window offsets). With `split`, a selection
 * inside part of the group's text leaves the rest formatted:
 * `\textbf{a b c}` with `b` selected becomes `\textbf{a} b \textbf{c}`.
 */
function removeGroup(text: string, groups: readonly Group[], group: Group, from: number, to: number, split: boolean): { edits: TextEdit[]; from: number; to: number } {
  const chain = stacked(groups, group);
  const outer = chain[chain.length - 1]!;
  let start = Math.max(from, group.contentFrom);
  let end = Math.min(to, group.contentTo);
  // A selection that opens or closes a brace of the group's text cannot be
  // cut out of it: the whole group loses the format instead.
  if (!split || !balanced(text, start, end)) {
    start = group.contentFrom;
    end = group.contentTo;
  }
  const opening = text.slice(group.from, group.contentFrom);
  // What stays formatted on either side keeps the space at the cut outside
  // it, and a side that is only space keeps no command at all.
  const kept = trimmed(text, group.contentFrom, start);
  const before = start > group.contentFrom && /\S/.test(text.slice(kept.from, kept.to));
  const keptAfter = trimmed(text, end, group.contentTo);
  const after = end < group.contentTo && /\S/.test(text.slice(keptAfter.from, keptAfter.to));
  const edits = [
    { from: outer.from, to: group.contentFrom, insert: before ? opening : "" },
    ...(before ? [{ from: kept.to, to: kept.to, insert: "}" }] : []),
    ...(after ? [{ from: keptAfter.from, to: keptAfter.from, insert: opening }] : []),
    { from: group.contentTo, to: outer.to, insert: after ? "}" : "" },
  ].filter((edit) => edit.insert !== text.slice(edit.from, edit.to));
  return { edits, from: start, to: end };
}

/**
 * Format `[from, to)` once with `open` … `close`. A group of the same format
 * the selection overlaps joins it, and every group of that format inside it
 * is taken off, so nothing nests: `\textbf{a} b` with all of it selected
 * becomes `\textbf{a b}`.
 */
function applyGroup(groups: readonly Group[], from: number, to: number, open: string, close: string): { edits: TextEdit[]; from: number; to: number } {
  let start = from;
  let end = to;
  for (let grown = true; grown;) {
    grown = false;
    for (const group of groups) {
      const overlaps = group.from < end && group.to > start;
      if (overlaps && (group.from < start || group.to > end)) {
        start = Math.min(start, group.from);
        end = Math.max(end, group.to);
        grown = true;
      }
    }
  }
  const edits: TextEdit[] = [];
  for (const group of groups) {
    if (group.from < start || group.to > end) continue;
    edits.push({ from: group.from, to: group.contentFrom, insert: "" }, { from: group.contentTo, to: group.to, insert: "" });
  }
  // The new command's ends join a deletion that starts or ends there, so one
  // change says what happens at each end.
  const first = edits.find((edit) => edit.from === start);
  if (first) first.insert = open;
  else edits.push({ from: start, to: start, insert: open });
  const last = edits.find((edit) => edit.to === end && edit !== first);
  if (last) last.insert = close;
  else edits.push({ from: end, to: end, insert: close });
  return { edits, from: start, to: end };
}

/**
 * Toggle `groups`' format on the selection `[from, to)` of the window `text`:
 * the shared rule behind every toggle here.
 */
function toggle(text: string, offset: number, length: number, groups: readonly Group[], range: { from: number; to: number }, open: string, close: string, split: boolean): FormatEdit {
  const from = range.from - offset;
  const to = range.to - offset;
  if (from === to) {
    // An empty pair the caret sits in goes; elsewhere the caret gets one to type into.
    const empty = groups.find((group) => group.contentFrom === from && group.contentTo === from);
    if (empty) return finish([{ from: empty.from, to: empty.to, insert: "" }], offset, length, () => ({ anchor: empty.from + offset, head: empty.from + offset }));
    const caret = range.from + open.length;
    return finish([{ from, to, insert: open + close }], offset, length, () => ({ anchor: caret, head: caret }));
  }
  const selected = trimmed(text, from, to);
  const group = enclosing(groups, selected.from, selected.to);
  // The text that keeps (or takes) the format stays selected: mapped from
  // just before what opens it to just after what closes it, then stepped in.
  if (group) {
    const removed = removeGroup(text, groups, group, selected.from, selected.to, split);
    return finish(removed.edits, offset, length, (changes) => ({
      anchor: changes.mapPos(removed.from + offset, 1),
      head: changes.mapPos(removed.to + offset, -1),
    }));
  }
  const applied = applyGroup(groups, selected.from, selected.to, open, close);
  return finish(applied.edits, offset, length, (changes) => ({
    anchor: changes.mapPos(applied.from + offset, -1) + open.length,
    head: changes.mapPos(applied.to + offset, 1) - close.length,
  }));
}

const inlineNames = (format: LatexInlineFormat) => INLINE_FORMATS[format].reads.join("|");

/** Bold, italic and their like on the selection, on or off (see the module comment). */
export function toggleLatexInline(doc: Doc, from: number, to: number, format: LatexInlineFormat): FormatEdit {
  const { text, offset } = windowAround(doc, from, to);
  return toggle(text, offset, doc.length, commandGroups(text, inlineNames(format)), { from, to }, `\\${INLINE_FORMATS[format].write}{`, "}", true);
}

/** A `quote` environment around the selection, on or off; it never splits. */
export function toggleLatexQuote(doc: Doc, from: number, to: number): FormatEdit {
  const { text, offset } = windowAround(doc, from, to);
  return toggle(text, offset, doc.length, environmentGroups(text, "quote"), { from, to }, "\\begin{quote}\n", "\n\\end{quote}", false);
}

/**
 * Make the selection a heading at `command`'s level. Inside a heading of that
 * level it stops being one; inside one of another level it changes level,
 * where it used to nest one heading in another.
 */
export function setLatexHeading(doc: Doc, from: number, to: number, command: string): FormatEdit {
  const { text, offset } = windowAround(doc, from, to);
  const groups = commandGroups(text, HEADING_COMMANDS.join("|"), true);
  const selected = trimmed(text, from - offset, to - offset);
  const heading = from === to ? null : enclosing(groups, selected.from, selected.to);
  if (heading && heading.name !== command) {
    const name = { from: heading.from + 1 + offset, to: heading.from + 1 + heading.name.length + offset, insert: command };
    const shift = command.length - heading.name.length;
    return {
      changes: [name],
      selection: { anchor: heading.contentFrom + offset + shift, head: heading.contentTo + offset + shift },
    };
  }
  return toggle(text, offset, doc.length, groups, { from, to }, `\\${command}{`, "}", false);
}

/** Inline math (`$…$`) on the selection, on or off. Off only when the selection is the whole formula or its body. */
export function toggleLatexMath(doc: Doc, from: number, to: number): FormatEdit {
  const { text, offset } = windowAround(doc, from, to);
  const start = from - offset;
  const end = to - offset;
  const single = (at: number) => text[at] === "$" && !escaped(text, at) && text[at - 1] !== "$" && text[at + 1] !== "$";
  const body = (at: number, until: number) => !text.slice(at, until).includes("$");
  if (start < end && single(start - 1) && single(end) && body(start, end)) {
    return {
      changes: [{ from: from - 1, to: from, insert: "" }, { from: to, to: to + 1, insert: "" }],
      selection: { anchor: from - 1, head: to - 1 },
    };
  }
  if (end - start >= 2 && single(start) && single(end - 1) && body(start + 1, end - 1)) {
    return {
      changes: [{ from, to: from + 1, insert: "" }, { from: to - 1, to, insert: "" }],
      selection: { anchor: from, head: to - 2 },
    };
  }
  const caret = from + 1;
  return {
    changes: [{ from, to, insert: `$${doc.sliceString(from, to)}$` }],
    selection: { anchor: caret, head: caret + (to - from) },
  };
}

/** What the selection already is, for the toolbar's pressed buttons. */
export type LatexSelectionFormats = {
  inline: ReadonlySet<LatexInlineFormat>;
  /** The sectioning command of the heading the selection is in, or null. */
  heading: string | null;
  quote: boolean;
  /** The selection is a link's text. */
  link: boolean;
};

/**
 * The formats `[from, to)` is wholly in. Reads only the text near the
 * selection, so it is cheap enough for every selection change.
 */
export function latexSelectionFormats(doc: Doc, from: number, to: number): LatexSelectionFormats {
  // No format holds a selection this long (select all in a long chapter), and
  // reading one would scan all of it on every selection change.
  if (to - from > REACH) return { inline: new Set(), heading: null, quote: false, link: false };
  const { text, offset } = windowAround(doc, from, to);
  const selected = trimmed(text, from - offset, to - offset);
  const inside = (groups: readonly Group[]) => selected.from < selected.to ? enclosing(groups, selected.from, selected.to) : null;
  const inline = new Set<LatexInlineFormat>();
  for (const format of ["bold", "italic", "underline", "strikethrough"] as const) {
    if (inside(commandGroups(text, inlineNames(format)))) inline.add(format);
  }
  return {
    inline,
    heading: inside(commandGroups(text, HEADING_COMMANDS.join("|"), true))?.name ?? null,
    quote: Boolean(inside(environmentGroups(text, "quote"))),
    link: Boolean(inside(linkGroups(text))),
  };
}

/**
 * Every `\href{url}{text}`: the text is its content, and `name` holds the
 * url, which starts right after `\href{` (the only spelling the toolbar reads).
 */
function linkGroups(text: string): Group[] {
  const links: Group[] = [];
  for (const target of commandGroups(text, "href")) {
    if (target.contentFrom !== target.from + "\\href{".length) continue;
    let open = target.to;
    while (text[open] === " " || text[open] === "\t") open += 1;
    const end = text[open] === "{" ? groupEnd(text, open) : -1;
    if (end > 0) links.push({ from: target.from, to: end, contentFrom: open + 1, contentTo: end - 1, name: text.slice(target.contentFrom, target.contentTo) });
  }
  return links;
}

/**
 * Link the selection to `url`. Inside a link's text it changes where the
 * link goes, where it used to nest a second `\href` in the first.
 */
export function setLatexLink(doc: Doc, from: number, to: number, url: string): FormatEdit {
  const { text, offset } = windowAround(doc, from, to);
  const links = linkGroups(text);
  const selected = trimmed(text, from - offset, to - offset);
  const link = from === to ? null : enclosing(links, selected.from, selected.to);
  if (link) {
    const target = { from: link.from + "\\href{".length, to: link.from + "\\href{".length + link.name.length };
    const shift = url.length - link.name.length;
    return {
      changes: [{ from: target.from + offset, to: target.to + offset, insert: url }],
      selection: { anchor: link.contentFrom + offset + shift, head: link.contentTo + offset + shift },
    };
  }
  const open = `\\href{${url}}{`;
  const edit = { from, to, insert: `${open}${doc.sliceString(from, to)}}` };
  return { changes: [edit], selection: { anchor: from + open.length, head: to + open.length } };
}
