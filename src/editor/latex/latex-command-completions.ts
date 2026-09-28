/**
 * Built-in LaTeX vocabulary for completion and hover when TexLab has no
 * answer (it is optional, and only runs for `.tex` files): common commands,
 * environments, math symbols, packages and document classes.
 *
 * A command's `template` is what completion inserts; the caret lands in its
 * first empty `{}`. Environment completion inside `\begin{…}` also writes the
 * matching `\end{…}`, like pressing Enter after a typed `\begin{…}` does.
 */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { pickedCompletion } from "@codemirror/autocomplete";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { shouldInsertCommandBraces } from "./latex-symbols";
import { mathRegionAt } from "./math-region";

type Entry = { name: string; detail: string; template?: string; package?: string };

const COMMANDS: Entry[] = [
  { name: "\\documentclass", detail: "Choose the document class", template: "\\documentclass{}" },
  { name: "\\usepackage", detail: "Load a package", template: "\\usepackage{}" },
  { name: "\\begin", detail: "Start an environment", template: "\\begin{}" },
  { name: "\\end", detail: "End an environment", template: "\\end{}" },
  { name: "\\part", detail: "Part heading", template: "\\part{}" },
  { name: "\\chapter", detail: "Chapter heading", template: "\\chapter{}" },
  { name: "\\section", detail: "Section heading", template: "\\section{}" },
  { name: "\\subsection", detail: "Subsection heading", template: "\\subsection{}" },
  { name: "\\subsubsection", detail: "Subsubsection heading", template: "\\subsubsection{}" },
  { name: "\\paragraph", detail: "Paragraph heading", template: "\\paragraph{}" },
  { name: "\\subparagraph", detail: "Subparagraph heading", template: "\\subparagraph{}" },
  { name: "\\title", detail: "Document title", template: "\\title{}" },
  { name: "\\author", detail: "Document authors", template: "\\author{}" },
  { name: "\\date", detail: "Document date", template: "\\date{}" },
  { name: "\\maketitle", detail: "Typeset the title block" },
  { name: "\\tableofcontents", detail: "Table of contents" },
  { name: "\\appendix", detail: "Start the appendices" },
  { name: "\\label", detail: "Name this place for cross-references" },
  { name: "\\ref", detail: "Number of a labelled item" },
  { name: "\\eqref", detail: "Equation number in parentheses", package: "amsmath" },
  { name: "\\pageref", detail: "Page of a labelled item" },
  { name: "\\autoref", detail: "Reference with its type name", package: "hyperref" },
  { name: "\\cref", detail: "Reference with its type name", package: "cleveref" },
  { name: "\\cite", detail: "Cite bibliography entries" },
  { name: "\\citep", detail: "Parenthetical citation", package: "natbib" },
  { name: "\\citet", detail: "Textual citation", package: "natbib" },
  { name: "\\parencite", detail: "Parenthetical citation", package: "biblatex" },
  { name: "\\textcite", detail: "Textual citation", package: "biblatex" },
  { name: "\\input", detail: "Insert another file's source" },
  { name: "\\include", detail: "Include a file on a new page" },
  { name: "\\includegraphics", detail: "Insert an image", template: "\\includegraphics[width=\\linewidth]{}", package: "graphicx" },
  { name: "\\caption", detail: "Caption of a figure or table", template: "\\caption{}" },
  { name: "\\centering", detail: "Center the rest of this group" },
  { name: "\\item", detail: "List item" },
  { name: "\\footnote", detail: "Footnote", template: "\\footnote{}" },
  { name: "\\emph", detail: "Emphasized text", template: "\\emph{}" },
  { name: "\\textbf", detail: "Bold text", template: "\\textbf{}" },
  { name: "\\textit", detail: "Italic text", template: "\\textit{}" },
  { name: "\\texttt", detail: "Monospaced text", template: "\\texttt{}" },
  { name: "\\textsc", detail: "Small capitals", template: "\\textsc{}" },
  { name: "\\textsf", detail: "Sans-serif text", template: "\\textsf{}" },
  { name: "\\textrm", detail: "Roman text", template: "\\textrm{}" },
  { name: "\\underline", detail: "Underlined text", template: "\\underline{}" },
  { name: "\\textcolor", detail: "Colored text", template: "\\textcolor{}{}", package: "xcolor" },
  { name: "\\url", detail: "Typeset a URL", template: "\\url{}", package: "url" },
  { name: "\\href", detail: "Hyperlink with text", template: "\\href{}{}", package: "hyperref" },
  { name: "\\newcommand", detail: "Define a command", template: "\\newcommand{}{}" },
  { name: "\\renewcommand", detail: "Redefine a command", template: "\\renewcommand{}{}" },
  { name: "\\newenvironment", detail: "Define an environment", template: "\\newenvironment{}{}{}" },
  { name: "\\newtheorem", detail: "Define a theorem-like environment", template: "\\newtheorem{}{}" },
  { name: "\\bibliography", detail: "BibTeX bibliography files", template: "\\bibliography{}" },
  { name: "\\bibliographystyle", detail: "BibTeX bibliography style", template: "\\bibliographystyle{}" },
  { name: "\\addbibresource", detail: "biblatex bibliography file", template: "\\addbibresource{}", package: "biblatex" },
  { name: "\\printbibliography", detail: "Typeset the bibliography", package: "biblatex" },
  { name: "\\hline", detail: "Horizontal rule in a table" },
  { name: "\\toprule", detail: "Top table rule", package: "booktabs" },
  { name: "\\midrule", detail: "Middle table rule", package: "booktabs" },
  { name: "\\bottomrule", detail: "Bottom table rule", package: "booktabs" },
  { name: "\\multicolumn", detail: "Cell spanning columns", template: "\\multicolumn{}{}{}" },
  { name: "\\vspace", detail: "Vertical space", template: "\\vspace{}" },
  { name: "\\hspace", detail: "Horizontal space", template: "\\hspace{}" },
  { name: "\\newpage", detail: "Start a new page" },
  { name: "\\clearpage", detail: "Flush floats and start a new page" },
  { name: "\\noindent", detail: "No indent for this paragraph" },
  { name: "\\linewidth", detail: "Width of the current line" },
  { name: "\\textwidth", detail: "Width of the text block" },
  { name: "\\today", detail: "Today's date" },
  { name: "\\LaTeX", detail: "The LaTeX logo" },
  { name: "\\ldots", detail: "Ellipsis" },
  { name: "\\text", detail: "Text inside math", template: "\\text{}", package: "amsmath" },
  { name: "\\frac", detail: "Fraction", template: "\\frac{}{}" },
  { name: "\\sqrt", detail: "Square root", template: "\\sqrt{}" },
  { name: "\\sum", detail: "Summation" },
  { name: "\\prod", detail: "Product" },
  { name: "\\int", detail: "Integral" },
  { name: "\\lim", detail: "Limit" },
  { name: "\\infty", detail: "Infinity" },
  { name: "\\partial", detail: "Partial derivative" },
  { name: "\\left", detail: "Sized opening delimiter" },
  { name: "\\right", detail: "Sized closing delimiter" },
];

const MATH_COMMANDS: Entry[] = [
  ...["alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta", "iota", "kappa",
    "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega", "Gamma",
    "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega"]
    .map((name) => ({ name: `\\${name}`, detail: "Greek letter" })),
  { name: "\\mathbb", detail: "Blackboard bold", template: "\\mathbb{}", package: "amssymb" },
  { name: "\\mathcal", detail: "Calligraphic letters", template: "\\mathcal{}" },
  { name: "\\mathbf", detail: "Bold math", template: "\\mathbf{}" },
  { name: "\\mathrm", detail: "Upright math", template: "\\mathrm{}" },
  { name: "\\operatorname", detail: "Named operator", template: "\\operatorname{}", package: "amsmath" },
  { name: "\\hat", detail: "Hat accent", template: "\\hat{}" },
  { name: "\\bar", detail: "Bar accent", template: "\\bar{}" },
  { name: "\\tilde", detail: "Tilde accent", template: "\\tilde{}" },
  { name: "\\vec", detail: "Vector arrow", template: "\\vec{}" },
  { name: "\\cdot", detail: "Centered dot" },
  { name: "\\cdots", detail: "Centered ellipsis" },
  { name: "\\times", detail: "Multiplication sign" },
  { name: "\\leq", detail: "Less than or equal" },
  { name: "\\geq", detail: "Greater than or equal" },
  { name: "\\neq", detail: "Not equal" },
  { name: "\\approx", detail: "Approximately equal" },
  { name: "\\equiv", detail: "Equivalent" },
  { name: "\\in", detail: "Element of" },
  { name: "\\subseteq", detail: "Subset or equal" },
  { name: "\\cup", detail: "Union" },
  { name: "\\cap", detail: "Intersection" },
  { name: "\\forall", detail: "For all" },
  { name: "\\exists", detail: "There exists" },
  { name: "\\to", detail: "Right arrow" },
  { name: "\\mapsto", detail: "Maps to" },
  { name: "\\Rightarrow", detail: "Implies" },
  { name: "\\nabla", detail: "Nabla" },
  { name: "\\log", detail: "Logarithm" },
  { name: "\\exp", detail: "Exponential" },
  { name: "\\max", detail: "Maximum" },
  { name: "\\min", detail: "Minimum" },
  { name: "\\arg", detail: "Argument" },
];

const ENVIRONMENTS: Entry[] = [
  { name: "document", detail: "The document body" },
  { name: "abstract", detail: "Abstract" },
  { name: "itemize", detail: "Bulleted list" },
  { name: "enumerate", detail: "Numbered list" },
  { name: "description", detail: "Labelled list" },
  { name: "figure", detail: "Floating figure" },
  { name: "figure*", detail: "Full-width floating figure" },
  { name: "table", detail: "Floating table" },
  { name: "table*", detail: "Full-width floating table" },
  { name: "tabular", detail: "Table body" },
  { name: "center", detail: "Centered block" },
  { name: "quote", detail: "Short quotation" },
  { name: "quotation", detail: "Long quotation" },
  { name: "verbatim", detail: "Verbatim text" },
  { name: "minipage", detail: "Box with its own text width" },
  { name: "equation", detail: "Numbered equation" },
  { name: "equation*", detail: "Unnumbered equation", package: "amsmath" },
  { name: "align", detail: "Aligned equations", package: "amsmath" },
  { name: "align*", detail: "Unnumbered aligned equations", package: "amsmath" },
  { name: "gather", detail: "Centered equations", package: "amsmath" },
  { name: "multline", detail: "Equation over several lines", package: "amsmath" },
  { name: "split", detail: "Split one equation", package: "amsmath" },
  { name: "cases", detail: "Case distinction", package: "amsmath" },
  { name: "matrix", detail: "Matrix", package: "amsmath" },
  { name: "pmatrix", detail: "Matrix in parentheses", package: "amsmath" },
  { name: "bmatrix", detail: "Matrix in brackets", package: "amsmath" },
  { name: "array", detail: "Math array" },
  { name: "theorem", detail: "Theorem" },
  { name: "lemma", detail: "Lemma" },
  { name: "proof", detail: "Proof", package: "amsthm" },
  { name: "definition", detail: "Definition" },
  { name: "algorithm", detail: "Floating algorithm", package: "algorithm" },
  { name: "lstlisting", detail: "Code listing", package: "listings" },
  { name: "minted", detail: "Highlighted code", package: "minted" },
  { name: "tikzpicture", detail: "TikZ drawing", package: "tikz" },
  { name: "frame", detail: "Beamer slide", package: "beamer" },
  { name: "thebibliography", detail: "Hand-written bibliography" },
];

const PACKAGES = [
  "amsmath", "amssymb", "amsthm", "mathtools", "graphicx", "xcolor", "hyperref", "cleveref", "booktabs", "geometry",
  "natbib", "biblatex", "tikz", "pgfplots", "listings", "minted", "algorithm", "algpseudocode", "subcaption", "caption",
  "float", "multirow", "tabularx", "enumitem", "microtype", "siunitx", "fontenc", "inputenc", "babel", "url",
  "xspace", "array", "longtable", "wrapfig", "fancyhdr", "setspace", "csquotes", "bm", "physics", "todonotes",
];
const DOCUMENT_CLASSES = ["article", "report", "book", "letter", "beamer", "memoir", "amsart", "scrartcl", "scrreprt", "standalone"];

const COMMAND_INDEX = new Map([...COMMANDS, ...MATH_COMMANDS].map((entry) => [entry.name, entry]));
const ENVIRONMENT_INDEX = new Map(ENVIRONMENTS.map((entry) => [entry.name, entry]));

const detailOf = (entry: Entry) => entry.package ? `${entry.detail} · ${entry.package}` : entry.detail;

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
      const indent = /^\s*/.exec(view.state.doc.lineAt(from).text)?.[0] ?? "";
      const body = `${entry.name}}\n${indent}  \n${indent}\\end{${entry.name}}`;
      insertCompletion(view, completion, from, end, body, entry.name.length + 2 + indent.length + 2);
    },
  };
}

const COMMAND_OPTIONS = COMMANDS.map(commandCompletion);
const MATH_OPTIONS = [...COMMANDS, ...MATH_COMMANDS].map(commandCompletion);
const BEGIN_OPTIONS = ENVIRONMENTS.map((entry) => environmentCompletion(entry, true));
const END_OPTIONS = ENVIRONMENTS.map((entry) => environmentCompletion(entry, false));
const PACKAGE_OPTIONS: Completion[] = PACKAGES.map((label) => ({ label, type: "namespace" }));
const CLASS_OPTIONS: Completion[] = DOCUMENT_CLASSES.map((label) => ({ label, type: "namespace" }));

/** Completion for built-in commands, environment names, packages and document classes. */
export function latexCommandCompletions(context: CompletionContext): CompletionResult | null {
  const argument = context.matchBefore(/\\(begin|end|usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\])?\{[^{}]*$/);
  if (argument) {
    const kind = /^\\(\w+)/.exec(argument.text)![1];
    const word = context.matchBefore(/[^{},\s]*$/)!;
    const options = kind === "begin" ? BEGIN_OPTIONS
      : kind === "end" ? END_OPTIONS
        : kind === "documentclass" ? CLASS_OPTIONS
          : PACKAGE_OPTIONS;
    return { from: word.from, options, validFor: /^[^{},\s]*$/ };
  }
  const word = context.matchBefore(/\\[A-Za-z@]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const inMath = mathRegionAt(context.state.doc.toString(), context.pos) !== null;
  return { from: word.from, options: inMath ? MATH_OPTIONS : COMMAND_OPTIONS, validFor: /^\\[A-Za-z@]*$/ };
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
