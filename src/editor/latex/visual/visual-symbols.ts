/**
 * What Visual mode knows of LaTeX's vocabulary: which commands it draws and
 * how, and the characters escapes, accents and ligatures stand for. Anything
 * not named here stays as its source.
 */

/* eslint-disable lingui/no-unlocalized-strings -- LaTeX command names and the glyphs they stand for */

/** How a text-styling command draws its argument. */
export type TextStyle =
  | "bold" | "italic" | "emph" | "mono" | "underline" | "smallcaps" | "sans" | "roman" | "slanted" | "upright"
  | "footnote" | "link";

/** Commands whose one braced argument is styled text: `\textbf{…}`. */
export const STYLE_COMMANDS: ReadonlyMap<string, TextStyle> = new Map([
  ["textbf", "bold"], ["textit", "italic"], ["emph", "emph"], ["texttt", "mono"], ["underline", "underline"],
  ["uline", "underline"], ["textsc", "smallcaps"], ["textsf", "sans"], ["textrm", "roman"], ["textsl", "slanted"],
  ["textup", "upright"], ["textmd", "upright"], ["textnormal", "upright"], ["footnote", "footnote"], ["url", "link"],
]);

/** Old-style switches that style the rest of their group: `{\bf …}`, `{\em …}`. */
export const STYLE_SWITCHES: ReadonlyMap<string, TextStyle> = new Map([
  ["bf", "bold"], ["bfseries", "bold"], ["it", "italic"], ["itshape", "italic"], ["em", "emph"], ["tt", "mono"],
  ["ttfamily", "mono"], ["sc", "smallcaps"], ["scshape", "smallcaps"], ["sf", "sans"], ["sffamily", "sans"],
  ["sl", "slanted"], ["slshape", "slanted"], ["rm", "roman"], ["rmfamily", "roman"], ["upshape", "upright"],
]);

/** Sectioning commands and their depth: `\part` is 0, `\subparagraph` 6. */
export const HEADING_LEVELS: ReadonlyMap<string, number> = new Map([
  ["part", 0], ["chapter", 1], ["section", 2], ["subsection", 3], ["subsubsection", 4], ["paragraph", 5], ["subparagraph", 6],
]);

/** Cross-references, and how each prints its label's number. */
export const REFERENCE_COMMANDS: ReadonlyMap<string, "number" | "parenthesized" | "named" | "page"> = new Map([
  ["ref", "number"], ["eqref", "parenthesized"], ["cref", "named"], ["Cref", "named"], ["autoref", "named"],
  ["vref", "named"], ["Vref", "named"], ["nameref", "number"], ["pageref", "page"], ["cpageref", "page"],
]);

/** Citation commands (natbib, biblatex and plain LaTeX). */
export const CITATION_COMMANDS: ReadonlySet<string> = new Set([
  "cite", "citep", "citet", "citealp", "citealt", "citeauthor", "citeyear", "citeyearpar", "citenum", "Citep", "Citet",
  "Citealp", "Citealt", "Citeauthor", "parencite", "Parencite", "textcite", "Textcite", "autocite", "Autocite",
  "footcite", "smartcite", "supercite", "fullcite", "nocite",
]);

/** Commands that bring in another file, drawn as a link to it. */
export const INCLUDE_COMMANDS: ReadonlySet<string> = new Set(["input", "include", "subfile", "includeonly"]);

/** The `import` package's commands, which name a folder and a file in it: `\import{figures/}{scheme}`. */
export const IMPORT_COMMANDS: ReadonlySet<string> = new Set(["import", "subimport", "inputfrom", "subinputfrom", "includefrom", "subincludefrom"]);

/**
 * chemnum's commands that print compound numbers (`\cmpd{a,b}`, `\refcmpd{a}`),
 * and `\rcmpd`, which a drawing's `[[…]]` marks become: drawn as the numbers
 * the last build gave them. `\cmpd*` and `\labelcmpd` print nothing.
 */
export const COMPOUND_COMMANDS: ReadonlySet<string> = new Set(["cmpd", "refcmpd", "rcmpd"]);

/** List environments, whose `\item`s Visual mode draws as markers. */
export const LIST_ENVIRONMENTS: ReadonlySet<string> = new Set(["itemize", "enumerate", "description"]);

/** Display math environments: their whole body is set by KaTeX. */
export const DISPLAY_MATH_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "flalign", "flalign*",
  "alignat", "alignat*", "eqnarray", "eqnarray*", "displaymath", "dmath", "dmath*",
]);

/**
 * Environments kept whole as their source: literal text (verbatim, listings)
 * and what Visual mode does not draw yet (tables, TikZ, algorithms).
 */
export const SOURCE_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "verbatim", "verbatim*", "Verbatim", "Verbatim*", "BVerbatim", "LVerbatim", "lstlisting", "minted", "comment",
  "filecontents", "filecontents*", "tikzpicture", "forest", "algorithmic", "tabular", "tabular*", "tabularx",
  "longtable", "array",
]);

/** Floats whose `\includegraphics` and `\caption` Visual mode draws. */
export const FIGURE_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "figure", "figure*", "wrapfigure", "subfigure", "table", "table*",
  // The floats chemistry journals' classes add (achemso): a caption in one reads "Scheme 1:".
  "scheme", "scheme*", "chart", "chart*", "graph", "graph*",
]);

/** Environments drawn as a block with a heading of their name: `abstract`, quotes, theorems. */
export const BOXED_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "abstract", "quote", "quotation", "center", "theorem", "lemma", "proposition", "corollary", "definition", "remark",
  "proof", "example",
]);

/** Commands that print one fixed character or word. `\\` and `\newline` are line breaks, left as source. */
export const LITERALS: Readonly<Record<string, string>> = {
  "&": "&", "%": "%", "$": "$", "#": "#", "_": "_", "{": "{", "}": "}", " ": " ", ",": " ",
  ";": " ", ":": " ", "!": "", "-": "", "/": "", quad: " ", qquad: "  ",
  ldots: "…", dots: "…", textellipsis: "…", textendash: "–", textemdash: "—", textbackslash: "\\",
  textasciitilde: "~", textasciicircum: "^", textbar: "|", textless: "<", textgreater: ">", textbullet: "•",
  textdagger: "†", textdaggerdbl: "‡", textsection: "§", textparagraph: "¶", textdegree: "°",
  textquotedblleft: "“", textquotedblright: "”", textquoteleft: "‘", textquoteright: "’",
  S: "§", P: "¶", copyright: "©", textcopyright: "©", textregistered: "®", texttrademark: "™", pounds: "£",
  euro: "€", ss: "ß", o: "ø", O: "Ø", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", aa: "å", AA: "Å", l: "ł", L: "Ł",
  i: "ı", j: "ȷ", LaTeX: "LaTeX", TeX: "TeX", LaTeXe: "LaTeX 2ε", BibTeX: "BibTeX",
  "@": "",
};

/** Accent commands, as the combining mark each puts over (or under) its letter. */
export const ACCENTS: Readonly<Record<string, string>> = {
  "'": "́", "`": "̀", "^": "̂", "\"": "̈", "~": "̃", "=": "̄", ".": "̇",
  u: "̆", v: "̌", H: "̋", r: "̊", c: "̧", k: "̨", d: "̣", b: "̱",
};

/* eslint-enable lingui/no-unlocalized-strings */
