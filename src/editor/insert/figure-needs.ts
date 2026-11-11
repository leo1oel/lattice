/**
 * What an editable figure's entry file needs in the preamble once its
 * drawing changes (docs/editable-figures.md, "When the drawing changes"). A
 * figure pasted without compound numbers needs only `graphicx`; marks added
 * later make the drawing program write a `tikzpicture` with `\cmpd` into the
 * same entry, and a document whose preamble was completed at paste time no
 * longer builds. The entry says what it needs in its leading comment lines,
 * and the packages its code plainly uses are added to that.
 */
import { definesAll, isDefinitionsOnly, knownGraphicsPath, missingPreambleInsertions } from "./editable-figure";

// eslint-disable-next-line lingui/no-unlocalized-strings -- the comment lines a drawing program writes into the entry file, part of the format
const HEADER = "% editable-figure ";
/** The leading comment block is short: a longer one is not read past this. */
const MAX_HEADER_LINES = 200;
const MAX_HEADER_LINE = 1024;
const PACKAGE_NAME = /^[A-Za-z0-9-]+$/;

export type FigureNeeds = { packages: string[]; preamble: string[] };

/** Packages an entry's own code shows it uses, whatever its header says. */
const USED_PACKAGES: readonly [RegExp, string][] = [
  [/\\includegraphics\b/, "graphicx"],
  [/\\begin\s*\{tikzpicture\}/, "tikz"],
  [/\\cmpd\b/, "chemnum"],
];

const blankComments = (text: string) => text.replace(/(?<!\\)%.*$/gm, "");

/**
 * The needs an entry file states and shows: `% editable-figure packages: a b`
 * and one `% editable-figure preamble: <line>` per preamble line, read from its
 * leading `% editable-figure` lines, with the packages its code uses. Null for
 * a file that is not an entry (its first line names no source).
 */
export function figureNeedsOf(entryText: string): FigureNeeds | null {
  const lines = entryText.split(/\r?\n/, MAX_HEADER_LINES);
  if (!lines[0]?.startsWith(`${HEADER}source: `)) return null;
  const packages = new Set<string>();
  const preamble: string[] = [];
  for (const line of lines) {
    if (!line.startsWith(HEADER) || line.length > MAX_HEADER_LINE) break;
    const field = line.slice(HEADER.length);
    if (field.startsWith("packages:")) {
      for (const name of field.slice("packages:".length).split(/[\s,]+/)) if (PACKAGE_NAME.test(name)) packages.add(name);
    } else if (field.startsWith("preamble: ")) {
      preamble.push(field.slice("preamble: ".length));
    }
  }
  const code = blankComments(entryText);
  for (const [use, name] of USED_PACKAGES) if (use.test(code)) packages.add(name);
  return { packages: [...packages], preamble };
}

const DEFINER = String.raw`\\(?:providecommand|newcommand|renewcommand|DeclareRobustCommand|DeclareMathOperator|NewDocumentCommand|ProvideDocumentCommand|RenewDocumentCommand|DeclareDocumentCommand|def)\*?\s*\{?`;
const DEFINED = new RegExp(`${DEFINER}(\\\\[A-Za-z@]+)`, "g");
const escaped = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/**
 * Whether `text` has the block already: every command it defines (by any
 * definer, so an older version of the same block counts), or, for a block
 * that defines nothing, each of its lines as written.
 */
function hasBlock(text: string, block: readonly string[]): boolean {
  const commands = [...block.join("\n").matchAll(DEFINED)].map((match) => match[1]);
  if (!commands.length) return definesAll(text, block) && block.every((line) => !line.trim() || text.includes(line.trim()));
  const code = blankComments(text);
  return commands.every((command) => new RegExp(`${DEFINER}${escaped(command)}(?![A-Za-z@])`).test(code));
}

/** The entry's folder, as `\graphicspath` lists it: `figures/`, or empty for the project root. */
const folderOf = (entryPath: string) => entryPath.slice(0, entryPath.lastIndexOf("/") + 1);

export type PreambleCompletion = {
  /** The root document with what it lacks added; null when it lacks nothing it may get unasked. */
  text: string | null;
  /** The lines added. */
  added: string[];
  /** Preamble lines it lacks that do more than define, so are not added unasked: an entry may come from anyone. */
  withheld: string[];
  /**
   * The entry's folder, when the `\graphicspath` a preamble file sets does not
   * list it. A second `\graphicspath` in the root would override that one, so
   * the folder is named for the author to add there.
   */
  unlisted: string | null;
};

/** Whether the root document's own preamble sets `\graphicspath`. */
const setsGraphicsPath = (rootText: string) => {
  const begin = rootText.search(/^[^%\n]*\\begin\s*\{document\}/m);
  return begin >= 0 && /\\graphicspath\s*\{/.test(blankComments(rootText.slice(0, begin)));
};

/**
 * What a root document lacks for a figure's needs, added as a paste adds it:
 * the packages after the last package line, the definitions before
 * `\begin{document}`. `known` is the text of files its preamble loads: the
 * packages and `\graphicspath` they set count as the root's own.
 */
export function completePreamble(rootText: string, known: string, entryPath: string, needs: FigureNeeds): PreambleCompletion {
  const folder = folderOf(entryPath);
  const insertions = missingPreambleInsertions(rootText, needs.packages, folder, known);
  const unlisted = folder && !setsGraphicsPath(rootText) && knownGraphicsPath(known, folder) === "unlisted" ? folder : null;
  const block = needs.preamble.length && !hasBlock(`${rootText}\n${known}`, needs.preamble) ? needs.preamble : [];
  const safe = block.length > 0 && isDefinitionsOnly(block);
  const begin = rootText.search(/^[^%\n]*\\begin\s*\{document\}/m);
  if (safe && begin >= 0) insertions.push({ from: begin, insert: `${block.join("\n")}\n` });
  const withheld = safe ? [] : block;
  if (!insertions.length) return { text: null, added: [], withheld, unlisted };
  let text = rootText;
  // From the end, so each offset still points where it did.
  for (const { from, insert } of [...insertions].sort((a, b) => b.from - a.from)) text = text.slice(0, from) + insert + text.slice(from);
  const added = insertions.flatMap(({ insert }) => insert.split("\n").filter((line) => line.trim()));
  return { text, added, withheld, unlisted };
}
