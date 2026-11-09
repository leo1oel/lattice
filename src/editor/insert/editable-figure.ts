/**
 * Editable external figures (docs/editable-figures.md): a drawing program
 * copies a figure as HTML whose `data-editable-figure` attribute holds a JSON
 * manifest naming its source file and the files rendered from it, with the
 * line that includes it as plain text. Pasted into a LaTeX source, the files
 * are copied into the project (`import_editable_figure`), the include line
 * goes at the caret and the preamble gets the packages it lacks.
 */
import type { ChangeSpec } from "@codemirror/state";

/** One file of a figure: its name and base64 bytes. A paste is untrusted, so it can never name a path to read. */
type EditableFigureFile = { name: string; data: string };

export type EditableFigureManifest = {
  version: number;
  name?: string;
  source: EditableFigureFile;
  outputs: EditableFigureFile[];
  entry: string;
  packages?: string[];
  /** Definitions the entry needs in the preamble, whole lines; added once. */
  preamble?: string[];
};

/** Where `import_editable_figure` put the figure, relative to the project root. */
export type ImportedFigure = { directory: string; entry: string; source: string; packages: string[]; preamble?: string[] };

const isFile = (value: unknown): value is EditableFigureFile => {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return typeof file.name === "string" && typeof file.data === "string";
};

/** The manifest in a clipboard HTML fragment, or null when it holds none (or one this version cannot read). */
export function editableFigureFromHtml(html: string): EditableFigureManifest | null {
  if (!html.includes("data-editable-figure")) return null;
  const element = new DOMParser().parseFromString(html, "text/html").querySelector("[data-editable-figure]");
  let value: unknown;
  try {
    value = JSON.parse(element?.getAttribute("data-editable-figure") ?? "");
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1 || typeof manifest.entry !== "string" || !isFile(manifest.source)) return null;
  if (!Array.isArray(manifest.outputs) || !manifest.outputs.length || !manifest.outputs.every(isFile)) return null;
  if (manifest.packages !== undefined && !(Array.isArray(manifest.packages) && manifest.packages.every((name) => typeof name === "string"))) return null;
  if (manifest.preamble !== undefined && !(Array.isArray(manifest.preamble) && manifest.preamble.every((line) => typeof line === "string"))) return null;
  return value as EditableFigureManifest;
}

/** The line that includes an imported figure, from the project root. */
export function editableFigureInclude(figure: Pick<ImportedFigure, "directory" | "entry">): string {
  const directory = figureFolder(figure.directory);
  return `\\input{${directory}${figure.entry.replace(/\.tex$/i, "")}}`;
}

/** The figure's folder with its closing slash; empty for the project root. */
const figureFolder = (directory: string) => {
  const folder = directory.replace(/\\/g, "/").replace(/\/*$/, "");
  return folder ? `${folder}/` : "";
};

const PACKAGE_LOAD = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g;
const withoutComments = (line: string) => line.replace(/(^|[^\\])%.*$/, "$1");

/** The balanced group opening at `open`, as the offset just past its close; -1 when it never closes. */
function groupEnd(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === "{") depth += 1;
    else if (text[index] === "}" && --depth === 0) return index + 1;
  }
  return -1;
}

/** Commented text blanked, every offset unchanged. */
const blankComments = (text: string) => text.replace(/(?<!\\)%.*$/gm, (comment) => " ".repeat(comment.length));

/** Where the preamble's existing `\graphicspath` takes `folder`, or null when it has one already or there is none. */
function graphicsPathAddition(source: string, begin: number, folder: string): { from: number; insert: string } | "listed" | null {
  const code = blankComments(source.slice(0, begin));
  const command = /\\graphicspath\s*(?=\{)/.exec(code);
  if (!command) return null;
  const open = command.index + command[0].length;
  const end = groupEnd(code, open);
  if (end < 0) return null;
  return code.slice(open, end).includes(`{${folder}}`) ? "listed" : { from: end - 1, insert: `{${folder}}` };
}

/**
 * What a root document's preamble lacks for a figure: the `\usepackage` lines
 * for `packages` (with `graphicx`, which `\graphicspath` needs), and its folder
 * on `\graphicspath`, so the entry file finds its PDF. New lines go after the
 * last package line, or before `\begin{document}`. Empty for a file that is
 * not a root document, or when nothing is missing.
 */
export function missingPreambleInsertions(source: string, packages: readonly string[], folder: string): { from: number; insert: string }[] {
  const begin = source.search(/^[^%\n]*\\begin\s*\{document\}/m);
  if (begin < 0) return [];
  const preamble = source.slice(0, begin);
  const loaded = new Set<string>();
  let lastLoadEnd = -1;
  let offset = 0;
  for (const line of preamble.split("\n")) {
    const code = withoutComments(line);
    for (const match of code.matchAll(PACKAGE_LOAD)) {
      for (const name of match[1].split(",")) loaded.add(name.trim());
      lastLoadEnd = offset + line.length;
    }
    offset += line.length + 1;
  }
  const missing = figurePackages(packages, folder).filter((name) => /^[A-Za-z0-9-]+$/.test(name) && !loaded.has(name));
  const lines = missing.map((name) => `\\usepackage{${name}}`);
  const path = folder ? graphicsPathAddition(source, begin, folder) : "listed";
  if (path === null) lines.push(graphicsPathLine(folder));
  const insertions = path && path !== "listed" ? [path] : [];
  if (!lines.length) return insertions;
  const text = lines.join("\n");
  const lineStart = source.lastIndexOf("\n", begin) + 1;
  return [...insertions, lastLoadEnd >= 0 ? { from: lastLoadEnd, insert: `\n${text}` } : { from: lineStart, insert: `${text}\n` }];
}

const figurePackages = (packages: readonly string[], folder: string) => [...new Set(folder ? ["graphicx", ...packages] : packages)];
const graphicsPathLine = (folder: string) => `\\graphicspath{{${folder}}}`;

const FIGURE_HOLDER = /\\(begin|end)\s*\{(figure|scheme|chart|graph|table|wrapfigure|SCfigure|sidewaysfigure|subfigure|minipage|tocentry)\*?\}/g;

/** Whether `position` is inside an environment that already holds a figure. */
export function insideFigureHolder(source: string, position: number): boolean {
  const code = blankComments(source.slice(0, position));
  const open: string[] = [];
  for (const [, edge, name] of code.matchAll(FIGURE_HOLDER)) {
    if (edge === "begin") open.push(name);
    else open.pop();
  }
  return open.length > 0;
}

/**
 * Whether a figure pasted over `selection` gets a float of its own: on an
 * empty line of the document's body, outside any environment holding a figure.
 */
export function pastesFigureBlock(source: string, selection: { from: number; to: number }): boolean {
  const lineStart = source.lastIndexOf("\n", selection.from - 1) + 1;
  const newline = source.indexOf("\n", selection.to);
  const lineEnd = newline < 0 ? source.length : newline;
  if (source.slice(lineStart, selection.from).trim() || source.slice(selection.to, lineEnd).trim()) return false;
  const begin = source.search(/^[^%\n]*\\begin\s*\{document\}/m);
  return selection.from > begin && !insideFigureHolder(source, selection.from);
}

/** The float for a pasted figure, as a CodeMirror snippet: the caption, then the label, then past the end. */
export function editableFigureBlockSnippet(figure: Pick<ImportedFigure, "directory" | "entry">): string {
  return [
    "\\begin{figure}",
    "\t\\centering",
    `\t${editableFigureInclude(figure)}`,
    "\t\\caption{${1}}",
    "\t\\label{fig:${2}}",
    "\\end{figure}${3}",
  ].join("\n");
}

/** The commands a block of preamble lines defines. */
const definedCommands = (block: readonly string[]) => [...block.join("\n").matchAll(/\\(?:providecommand|newcommand|renewcommand|DeclareRobustCommand)\*?\s*\{?(\\[A-Za-z]+)/g)].map((match) => match[1]);

/** Whether `text` already defines every command the block does, comments aside. */
function definesAll(text: string, block: readonly string[]): boolean {
  const code = blankComments(text);
  return definedCommands(block).every((command) => new RegExp(`\\\\(?:providecommand|newcommand|DeclareRobustCommand|def)\\*?\\s*\\{?\\${command}(?![A-Za-z])`).test(code));
}

/**
 * What a block may hold at its top level without being shown first, and the
 * arguments each takes: the command a definer defines (one control word, bare
 * or braced), then its brace groups, whose bodies run only if called. Where
 * TeX reads a group's text at once (a colour, a counter, a package), it must
 * be plain. Only definers of new commands take `*` and `[…]` digits. None of
 * them replaces a command the document has: `\DeclareRobustCommand` would,
 * silently, so it is shown first like any other line. `@` is a letter only
 * after `\makeatletter`, as TeX reads it: `\a@{…}` elsewhere is `\a`, then
 * `@`, and its group runs.
 */
type PreambleDefiner = { names: boolean; groups: number; options?: boolean; plain?: RegExp };
const COMMAND_DEFINER: PreambleDefiner = { names: true, groups: 1, options: true };
const DOCUMENT_COMMAND_DEFINER: PreambleDefiner = { names: true, groups: 2 };
const PREAMBLE_DEFINERS = new Map<string, PreambleDefiner>(Object.entries({
  providecommand: COMMAND_DEFINER,
  newcommand: COMMAND_DEFINER,
  DeclareMathOperator: COMMAND_DEFINER,
  NewDocumentCommand: DOCUMENT_COMMAND_DEFINER,
  ProvideDocumentCommand: DOCUMENT_COMMAND_DEFINER,
  definecolor: { names: false, groups: 3, plain: /^\{[\w.,\s-]*\}$/ },
  newcounter: { names: false, groups: 1, plain: /^\{[A-Za-z]+\}$/ },
  usepackage: { names: false, groups: 1, plain: /^\{\s*[A-Za-z0-9-]+(?:\s*,\s*[A-Za-z0-9-]+)*\s*\}$/ },
}));
const PREAMBLE_MODE = /^(?:makeatletter|makeatother|ExplSyntaxOn|ExplSyntaxOff)$/;
/** How TeX reads a control word, a command name and a braced one, by whether `@` is a letter. */
const READING = [
  { word: /^\\(?:[A-Za-z]+|[\s\S])/, name: /^\\[A-Za-z]+$/, braced: /^\{\s*\\[A-Za-z]+\s*\}$/ },
  { word: /^\\(?:[A-Za-z@]+|[\s\S])/, name: /^\\[A-Za-z@]+$/, braced: /^\{\s*\\[A-Za-z@]+\s*\}$/ },
];

/** Whether a manifest's preamble lines only define things: nothing at the top level runs but a definition. */
export function isDefinitionsOnly(block: readonly string[]): boolean {
  const code = blankComments(block.join("\n"));
  let definer: PreambleDefiner | undefined;
  // Arguments `definer` still takes, the command it defines first.
  let left = 0;
  let atLetter = false;
  let index = 0;
  while (index < code.length) {
    const char = code[index];
    const naming = Boolean(definer?.names) && left === (definer?.groups ?? 0) + 1;
    const reading: (typeof READING)[number] = READING[Number(atLetter)];
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "\\") {
      const word: string = reading.word.exec(code.slice(index))?.[0] ?? "\\";
      index += word.length;
      if (naming && reading.name.test(word)) {
        left -= 1;
        continue;
      }
      if (left > 0) return false;
      definer = PREAMBLE_DEFINERS.get(word.slice(1));
      if (definer) left = definer.groups + (definer.names ? 1 : 0);
      else if (!PREAMBLE_MODE.test(word.slice(1))) return false;
      else if (/^\\makeat(?:letter|other)$/.test(word)) atLetter = word.endsWith("letter");
    } else if (char === "{") {
      const end = groupEnd(code, index);
      if (!definer || left === 0 || end < 0) return false;
      const group = code.slice(index, end);
      if (naming ? !reading.braced.test(group) : definer.plain && !definer.plain.test(group)) return false;
      left -= 1;
      index = end;
    } else if (definer?.options && left > 0 && /[*[\]0-9]/.test(char)) {
      index += 1;
    } else {
      return false;
    }
  }
  return left === 0;
}

/** Whether pasting `figure` would add preamble lines that must be shown first. */
export function preambleNeedsConfirmation(source: string, known: string, figure: ImportedFigure): boolean {
  return Boolean(figure.preamble?.length) && !definesAll(`${source}\n${known}`, figure.preamble ?? []) && !isDefinitionsOnly(figure.preamble ?? []);
}

/** Project files a root document's preamble brings in, whose definitions count as its own. */
export function preambleFiles(source: string): string[] {
  const begin = source.search(/^[^%\n]*\\begin\s*\{document\}/m);
  if (begin < 0) return [];
  const code = blankComments(source.slice(0, begin));
  return [
    ...[...code.matchAll(/\\input\s*\{([^{}]+)\}/g)].map((match) => (/\.[a-z]+$/i.test(match[1]) ? match[1] : `${match[1]}.tex`)),
    ...[...code.matchAll(PACKAGE_LOAD)].flatMap((match) => match[1].split(",").map((name) => `${name.trim()}.sty`)),
  ];
}

/** The changes that put an imported figure into `view`: its include line at the selection, what it needs in the preamble. `known` is text already defining things. */
export function editableFigureChanges(source: string, selection: { from: number; to: number }, figure: ImportedFigure, known = ""): {
  changes: ChangeSpec[];
  /** Lines to add by hand: the file is not the root document. */
  unplaced: string[];
} {
  const changes: ChangeSpec[] = [{ from: selection.from, to: selection.to, insert: editableFigureInclude(figure) }];
  const folder = figureFolder(figure.directory);
  for (const insertion of missingPreambleInsertions(source, figure.packages, folder)) {
    if (!(insertion.from > selection.from && insertion.from < selection.to)) changes.push(insertion);
  }
  const isRoot = /^[^%\n]*\\begin\s*\{document\}/m.test(source);
  const block = figure.preamble?.length && !definesAll(`${source}\n${known}`, figure.preamble) ? figure.preamble : [];
  if (isRoot) {
    const begin = source.search(/^[^%\n]*\\begin\s*\{document\}/m);
    if (block.length && !(begin > selection.from && begin < selection.to)) changes.push({ from: begin, insert: `${block.join("\n")}\n` });
    return { changes, unplaced: [] };
  }
  const lines = figurePackages(figure.packages, folder).map((name) => `\\usepackage{${name}}`);
  return { changes, unplaced: [...lines, ...(folder ? [graphicsPathLine(folder)] : []), ...block] };
}

// eslint-disable-next-line lingui/no-unlocalized-strings -- the comment line a drawing program writes into the entry file, part of the format
const SOURCE_HEADER = "% editable-figure source: ";

/** A drawing's path, not a document: the first line of an entry is a short one. */
const MAX_SOURCE_LINE = 1024;

/**
 * The project path of the drawing an entry file was made from, from its first
 * line, `% editable-figure source: <path>` (relative to the entry file); null
 * for any other file, or a path that climbs out of the project.
 */
export function figureSourcePath(entryPath: string, entryText: string): string | null {
  // Read without a pattern over the whole line: a line of spaces made the
  // obvious `(.+?)\s*$` cost four times as much for twice its length, so any
  // .tex the watcher reported could hold the window for minutes.
  const first = entryText.split(/\r?\n/, 1)[0];
  if (first.length > MAX_SOURCE_LINE) return null;
  const name = first.startsWith(SOURCE_HEADER) ? first.slice(SOURCE_HEADER.length).trimEnd() : "";
  if (!name || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  const parts = entryPath.split("/").slice(0, -1);
  for (const part of name.split("/")) {
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

const INCLUDE_COMMAND = /\\(?:(?:sub)?import\{([^{}]*)\}\{([^{}]*)\}|(?:input|include)\{([^{}]*)\})/g;

/**
 * The project paths the includes on a source line may name: from the project
 * root and from the including file's folder, as `\input` and `\import` read them.
 */
export function includedTexPaths(line: string, fromPath: string): string[] {
  const folder = fromPath.slice(0, fromPath.lastIndexOf("/") + 1);
  const code = line.replace(/(?<!\\)%.*$/, "");
  const clean = (path: string) => path.split("/").filter((part) => part && part !== ".").join("/");
  return [...new Set([...code.matchAll(INCLUDE_COMMAND)].flatMap((match) => {
    const name = match[3] ?? `${match[1]}/${match[2]}`;
    const file = /\.tex$/i.test(name) ? name : `${name}.tex`;
    return [clean(file), clean(`${folder}${file}`)];
  }))];
}

