/**
 * Built-in LaTeX vocabulary for completion and hover when TexLab has no
 * answer (it is optional, and only runs for `.tex` files): common commands,
 * environments, math symbols, packages and document classes.
 *
 * Most entries come from the insert palette's snippets, whose descriptions
 * are already translated; the rest are listed here. A command's `template`
 * is what completion inserts, with the caret in its first empty `{}`.
 * Environment completion inside `\begin{…}` also writes the matching
 * `\end{…}`, like pressing Enter after a typed `\begin{…}` does.
 */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { pickedCompletion } from "@codemirror/autocomplete";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Text, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { i18n } from "../../i18n";
import { INSERT_SNIPPETS } from "../insert/insert-snippets";
import { beginEnvironmentClose } from "./latex-environments";
import { shouldInsertCommandBraces } from "./latex-symbols";
import { mathRegionAt } from "./math-region";

type Entry = { name: string; detail: MessageDescriptor; template?: string; package?: string; math?: boolean };

const COMMANDS: Entry[] = [
  { name: "\\documentclass", detail: msg`Choose the document class`, template: "\\documentclass{}" },
  { name: "\\usepackage", detail: msg`Load a package`, template: "\\usepackage{}" },
  { name: "\\begin", detail: msg`Start an environment`, template: "\\begin{}" },
  { name: "\\end", detail: msg`End an environment`, template: "\\end{}" },
  { name: "\\part", detail: msg`Part heading`, template: "\\part{}" },
  { name: "\\chapter", detail: msg`Chapter heading`, template: "\\chapter{}" },
  { name: "\\subparagraph", detail: msg`Subparagraph heading`, template: "\\subparagraph{}" },
  { name: "\\title", detail: msg`Document title`, template: "\\title{}" },
  { name: "\\author", detail: msg`Document authors`, template: "\\author{}" },
  { name: "\\date", detail: msg`Document date`, template: "\\date{}" },
  { name: "\\maketitle", detail: msg`Typeset the title block` },
  { name: "\\tableofcontents", detail: msg`Table of contents` },
  { name: "\\appendix", detail: msg`Start the appendices` },
  { name: "\\pageref", detail: msg`Page of a labeled item` },
  { name: "\\autoref", detail: msg`Reference with its type name`, package: "hyperref" },
  { name: "\\cref", detail: msg`Reference with its type name`, package: "cleveref" },
  { name: "\\cite", detail: msg`Cite bibliography entries` },
  { name: "\\citet", detail: msg`Textual citation`, package: "natbib" },
  { name: "\\parencite", detail: msg`Parenthetical citation`, package: "biblatex" },
  { name: "\\textcite", detail: msg`Textual citation`, package: "biblatex" },
  { name: "\\caption", detail: msg`Caption of a figure or table`, template: "\\caption{}" },
  { name: "\\centering", detail: msg`Center the rest of this group` },
  { name: "\\item", detail: msg`List item` },
  { name: "\\textit", detail: msg`Italic text`, template: "\\textit{}" },
  { name: "\\texttt", detail: msg`Monospaced text`, template: "\\texttt{}" },
  { name: "\\textsc", detail: msg`Small capitals`, template: "\\textsc{}" },
  { name: "\\textsf", detail: msg`Sans-serif text`, template: "\\textsf{}" },
  { name: "\\textrm", detail: msg`Roman text`, template: "\\textrm{}" },
  { name: "\\textcolor", detail: msg`Colored text`, template: "\\textcolor{}{}", package: "xcolor" },
  { name: "\\url", detail: msg`Typeset a URL`, template: "\\url{}", package: "url" },
  { name: "\\href", detail: msg`Hyperlink with text`, template: "\\href{}{}", package: "hyperref" },
  { name: "\\newcommand", detail: msg`Define a command`, template: "\\newcommand{}{}" },
  { name: "\\renewcommand", detail: msg`Redefine a command`, template: "\\renewcommand{}{}" },
  { name: "\\newenvironment", detail: msg`Define an environment`, template: "\\newenvironment{}{}{}" },
  { name: "\\newtheorem", detail: msg`Define a theorem-like environment`, template: "\\newtheorem{}{}" },
  { name: "\\bibliography", detail: msg`BibTeX bibliography files`, template: "\\bibliography{}" },
  { name: "\\bibliographystyle", detail: msg`BibTeX bibliography style`, template: "\\bibliographystyle{}" },
  { name: "\\addbibresource", detail: msg`biblatex bibliography file`, template: "\\addbibresource{}", package: "biblatex" },
  { name: "\\printbibliography", detail: msg`Typeset the bibliography`, package: "biblatex" },
  { name: "\\hline", detail: msg`Horizontal rule in a table` },
  { name: "\\toprule", detail: msg`Top table rule`, package: "booktabs" },
  { name: "\\midrule", detail: msg`Middle table rule`, package: "booktabs" },
  { name: "\\bottomrule", detail: msg`Bottom table rule`, package: "booktabs" },
  { name: "\\multicolumn", detail: msg`Cell spanning columns`, template: "\\multicolumn{}{}{}" },
  { name: "\\vspace", detail: msg`Vertical space`, template: "\\vspace{}" },
  { name: "\\hspace", detail: msg`Horizontal space`, template: "\\hspace{}" },
  { name: "\\newpage", detail: msg`Start a new page` },
  { name: "\\clearpage", detail: msg`Flush floats and start a new page` },
  { name: "\\noindent", detail: msg`No indent for this paragraph` },
  { name: "\\linewidth", detail: msg`Width of the current line` },
  { name: "\\textwidth", detail: msg`Width of the text block` },
  { name: "\\today", detail: msg`Today's date` },
  { name: "\\LaTeX", detail: msg`The LaTeX logo` },
  { name: "\\ldots", detail: msg`Ellipsis` },
  { name: "\\left", detail: msg`Sized opening delimiter`, math: true },
  { name: "\\right", detail: msg`Sized closing delimiter`, math: true },
  { name: "\\mathbf", detail: msg`Bold math`, template: "\\mathbf{}", math: true },
  { name: "\\operatorname", detail: msg`Named operator`, template: "\\operatorname{}", package: "amsmath", math: true },
  { name: "\\cdots", detail: msg`Centered ellipsis`, math: true },
  { name: "\\sum", detail: msg`Summation`, math: true },
  { name: "\\prod", detail: msg`Product`, math: true },
  { name: "\\int", detail: msg`Integral`, math: true },
  { name: "\\lim", detail: msg`Limit`, math: true },
  { name: "\\max", detail: msg`Maximum operator`, math: true },
  { name: "\\min", detail: msg`Minimum operator`, math: true },
  { name: "\\log", detail: msg`Logarithm`, math: true },
  { name: "\\exp", detail: msg`Exponential`, math: true },
  { name: "\\arg", detail: msg`Argument`, math: true },
];

const ENVIRONMENTS: Entry[] = [
  { name: "document", detail: msg`The document body` },
  { name: "figure*", detail: msg`Full-width floating figure` },
  { name: "table*", detail: msg`Full-width floating table` },
  { name: "tabular", detail: msg`Table body` },
  { name: "quotation", detail: msg`Long quotation` },
  { name: "split", detail: msg`Split one equation`, package: "amsmath" },
  { name: "matrix", detail: msg`Matrix`, package: "amsmath" },
  { name: "array", detail: msg`Math array` },
  { name: "lemma", detail: msg`Lemma` },
  { name: "definition", detail: msg`Definition` },
  { name: "tikzpicture", detail: msg`TikZ drawing`, package: "tikz" },
  { name: "frame", detail: msg`Beamer slide`, package: "beamer" },
  { name: "thebibliography", detail: msg`Hand-written bibliography` },
  { name: "minted", detail: msg`Highlighted code`, package: "minted" },
];

const PACKAGES = [
  "amsmath", "amssymb", "amsthm", "mathtools", "graphicx", "xcolor", "hyperref", "cleveref", "booktabs", "geometry",
  "natbib", "biblatex", "tikz", "pgfplots", "listings", "minted", "algorithm", "algpseudocode", "subcaption", "caption",
  "float", "multirow", "tabularx", "enumitem", "microtype", "siunitx", "fontenc", "inputenc", "babel", "url",
  "xspace", "array", "longtable", "wrapfig", "fancyhdr", "setspace", "csquotes", "bm", "physics", "todonotes",
];
const DOCUMENT_CLASSES = ["article", "report", "book", "letter", "beamer", "memoir", "amsart", "scrartcl", "scrreprt", "standalone"];

/** A command-shaped snippet: its name, and a template when all it adds is empty arguments. */
const SNIPPET_COMMAND = /^(\\[A-Za-z]+)(?:\[[^\]]*\])?(?:\{\})*$/;
const SNIPPET_ENVIRONMENT = /\\begin\{([^}]+)\}/;

/** Palette snippets first (their names are what the palette shows), then the entries above. */
function vocabulary() {
  const commands = new Map<string, Entry>();
  const environments = new Map<string, Entry>();
  for (const snippet of INSERT_SNIPPETS) {
    const insert = snippet.insert.trim();
    const environment = SNIPPET_ENVIRONMENT.exec(insert)?.[1];
    if (environment) {
      if (!environments.has(environment)) environments.set(environment, { name: environment, detail: snippet.detail });
      continue;
    }
    const command = SNIPPET_COMMAND.exec(insert);
    if (!command || commands.has(command[1])) continue;
    commands.set(command[1], {
      name: command[1],
      detail: snippet.detail,
      template: insert === command[1] ? undefined : insert,
      math: snippet.group !== "Structure",
    });
  }
  for (const entry of COMMANDS) if (!commands.has(entry.name)) commands.set(entry.name, entry);
  for (const entry of ENVIRONMENTS) if (!environments.has(entry.name)) environments.set(entry.name, entry);
  return { commands, environments };
}

const { commands: COMMAND_INDEX, environments: ENVIRONMENT_INDEX } = vocabulary();

const detailOf = (entry: Entry) => {
  const detail = i18n._(entry.detail);
  return entry.package ? `${detail} · ${entry.package}` : detail;
};

/** Insert `text` for a picked completion, placing the caret at `caret` and marking it as a completion. */
function insertCompletion(view: EditorView, completion: Completion, from: number, to: number, text: string, caret: number) {
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + caret },
    userEvent: "input.complete",
    annotations: pickedCompletion.of(completion),
    scrollIntoView: true,
  });
}

function commandCompletion(entry: Entry): Completion {
  const { template } = entry;
  return {
    label: entry.name,
    detail: detailOf(entry),
    type: "keyword",
    // Commands whose braces the editor adds itself (citations, references,
    // labels, includes) insert their bare name so that path stays in charge.
    apply: !template || shouldInsertCommandBraces(entry.name) ? entry.name : (view, completion, from, to) => {
      const group = template.indexOf("{}");
      insertCompletion(view, completion, from, to, template, group < 0 ? template.length : group + 1);
    },
  };
}

function environmentCompletion(entry: Entry, opening: boolean): Completion {
  return {
    label: entry.name,
    detail: detailOf(entry),
    type: "class",
    apply: (view, completion, from, to) => {
      const end = view.state.sliceDoc(to, to + 1) === "}" ? to + 1 : to;
      if (!opening) {
        insertCompletion(view, completion, from, end, `${entry.name}}`, entry.name.length + 1);
        return;
      }
      const line = view.state.doc.lineAt(from);
      const indent = /^\s*/.exec(line.text)?.[0] ?? "";
      const name = `${entry.name}}`;
      const before = view.state.sliceDoc(line.from, from) + name;
      const inserted = view.state.doc.replace(from, end, Text.of([name]));
      const close = beginEnvironmentClose(before, inserted, indent);
      insertCompletion(view, completion, from, end, name + (close?.insert ?? ""), name.length + (close?.cursorOffset ?? 0));
    },
  };
}

type Options = { text: Completion[]; math: Completion[]; begin: Completion[]; end: Completion[] };
/** Options carry translated details, so they are rebuilt when the app locale changes. */
let cachedOptions: { locale: string; options: Options } | null = null;

function currentOptions(): Options {
  if (cachedOptions?.locale === i18n.locale) return cachedOptions.options;
  const commands = [...COMMAND_INDEX.values()];
  const environments = [...ENVIRONMENT_INDEX.values()];
  const options = {
    text: commands.filter((entry) => !entry.math).map(commandCompletion),
    math: commands.map(commandCompletion),
    begin: environments.map((entry) => environmentCompletion(entry, true)),
    end: environments.map((entry) => environmentCompletion(entry, false)),
  };
  cachedOptions = { locale: i18n.locale, options };
  return options;
}

const PACKAGE_OPTIONS: Completion[] = PACKAGES.map((label) => ({ label, type: "namespace" }));
const CLASS_OPTIONS: Completion[] = DOCUMENT_CLASSES.map((label) => ({ label, type: "namespace" }));

/** Completion for built-in commands, environment names, packages and document classes. */
export function latexCommandCompletions(context: CompletionContext): CompletionResult | null {
  const argument = context.matchBefore(/\\(begin|end|usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\])?\{[^{}]*$/);
  if (argument) {
    const kind = /^\\(\w+)/.exec(argument.text)![1];
    const word = context.matchBefore(/[^{},\s]*$/)!;
    const choices = kind === "begin" ? currentOptions().begin
      : kind === "end" ? currentOptions().end
        : kind === "documentclass" ? CLASS_OPTIONS
          : PACKAGE_OPTIONS;
    return { from: word.from, options: choices, validFor: /^[^{},\s]*$/ };
  }
  const word = context.matchBefore(/\\[A-Za-z@]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const inMath = mathRegionAt(context.state.doc.toString(), context.pos) !== null;
  return { from: word.from, options: inMath ? currentOptions().math : currentOptions().text, validFor: /^\\[A-Za-z@]*$/ };
}

/** The command or environment name at `pos`, with the range it covers. */
function wordAt(state: EditorState, pos: number): { from: number; to: number; entry: Entry } | null {
  const line = state.doc.lineAt(pos);
  const offset = pos - line.from;
  for (const match of line.text.matchAll(/\\(?:begin|end)\s*\{([^{}]+)\}|\\[A-Za-z@]+/g)) {
    if (offset < match.index || offset > match.index + match[0].length) continue;
    const entry = match[1] ? ENVIRONMENT_INDEX.get(match[1].trim()) : COMMAND_INDEX.get(match[0]);
    return entry ? { from: line.from + match.index, to: line.from + match.index + match[0].length, entry } : null;
  }
  return null;
}

/** Hover card for a built-in command or environment; TexLab's own answer takes precedence. */
export function latexCommandHover(state: EditorState, pos: number) {
  const hit = wordAt(state, pos);
  if (!hit) return null;
  return {
    pos: hit.from,
    end: hit.to,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "texlab-hover-card";
      dom.textContent = `${hit.entry.name}\n${detailOf(hit.entry)}`;
      return { dom };
    },
  };
}
