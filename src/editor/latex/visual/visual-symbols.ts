/**
 * What Visual mode knows of LaTeX's vocabulary: which commands it draws and
 * how, and the characters escapes, accents and ligatures stand for. Anything
 * not named here stays as its source.
 */

/* eslint-disable lingui/no-unlocalized-strings -- LaTeX command names and the glyphs they stand for */

/** How a text-styling command draws its argument. */
export type TextStyle =
  | "bold" | "italic" | "emph" | "mono" | "underline" | "strike" | "smallcaps" | "sans" | "roman" | "slanted" | "upright"
  | "footnote" | "link" | "small" | "large";

/** Commands whose one braced argument is styled text: `\textbf{…}`. */
export const STYLE_COMMANDS: ReadonlyMap<string, TextStyle> = new Map([
  ["textbf", "bold"], ["textit", "italic"], ["emph", "emph"], ["texttt", "mono"], ["underline", "underline"],
  ["uline", "underline"], ["sout", "strike"], ["textsc", "smallcaps"], ["textsf", "sans"], ["textrm", "roman"], ["textsl", "slanted"],
  ["textup", "upright"], ["textmd", "upright"], ["textnormal", "upright"], ["footnote", "footnote"], ["url", "link"],
]);

/** Old-style switches that style the rest of their group: `{\bf …}`, `{\em …}`. */
export const STYLE_SWITCHES: ReadonlyMap<string, TextStyle> = new Map([
  ["bf", "bold"], ["bfseries", "bold"], ["it", "italic"], ["itshape", "italic"], ["em", "emph"], ["tt", "mono"],
  ["ttfamily", "mono"], ["sc", "smallcaps"], ["scshape", "smallcaps"], ["sf", "sans"], ["sffamily", "sans"],
  ["sl", "slanted"], ["slshape", "slanted"], ["rm", "roman"], ["rmfamily", "roman"], ["upshape", "upright"],
]);

/** Size switches: at a group's start they size it (`{\small …}`); anywhere else they draw as nothing. */
export const SIZE_SWITCHES: ReadonlyMap<string, TextStyle> = new Map([
  ["tiny", "small"], ["scriptsize", "small"], ["footnotesize", "small"], ["small", "small"],
  ["large", "large"], ["Large", "large"], ["LARGE", "large"], ["huge", "large"], ["Huge", "large"],
]);

/**
 * Layout, spacing and setup commands, and how many braced arguments each
 * takes: they print no text, so Visual mode draws them as nothing (their
 * source stays as written, and shows when the caret reaches it).
 */
export const LAYOUT_COMMANDS: ReadonlyMap<string, number> = new Map([
  ["vspace", 1], ["hspace", 1], ["vskip", 0], ["newpage", 0], ["clearpage", 0], ["cleardoublepage", 0], ["pagebreak", 0],
  ["nopagebreak", 0], ["linebreak", 0], ["nolinebreak", 0], ["raggedbottom", 0], ["flushbottom", 0], ["raggedright", 0],
  ["raggedleft", 0], ["noindent", 0], ["indent", 0], ["par", 0], ["smallskip", 0], ["medskip", 0], ["bigskip", 0],
  ["vfill", 0], ["hfill", 0], ["FloatBarrier", 0], ["balance", 0], ["sloppy", 0], ["fussy", 0], ["frenchspacing", 0],
  ["onecolumn", 0], ["twocolumn", 0], ["normalsize", 0], ["normalfont", 0], ["selectfont", 0], ["pagestyle", 1],
  ["thispagestyle", 1], ["pagenumbering", 1], ["setcounter", 2], ["addtocounter", 2], ["setlength", 2], ["addtolength", 2],
  ["hypersetup", 1], ["captionsetup", 1], ["bibliographystyle", 1], ["graphicspath", 1], ["addcontentsline", 3],
  ["phantomsection", 0], ["allowdisplaybreaks", 0], ["protect", 0], ["relax", 0], ["makeatletter", 0], ["makeatother", 0],
  ["color", 1], ["nocite", 1], ["enlargethispage", 1], ["needspace", 1], ["afterpage", 1], ["urlstyle", 1], ["sisetup", 1],
  ["setcitestyle", 1], ["crefname", 3], ["Crefname", 3], ["newpage*", 0], ["bibpunct", 6], ["looseness", 0],
]);

/** Commands that begin a part of the document, drawn as a quiet bar with its name. */
export const MARKER_COMMANDS: ReadonlyMap<string, "appendix" | "references"> = new Map([
  ["appendix", "appendix"], ["bibliography", "references"], ["printbibliography", "references"],
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
  "longtable", "array", "tabulary", "longtable*", "tblr", "supertabular", "xtabular", "NiceTabular",
]);

/** Table environments: drawn as a table (in a float, or on their own). */
export const TABLE_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "tabular", "tabular*", "tabularx", "tabulary", "longtable", "longtable*", "array", "tblr", "supertabular", "xtabular", "NiceTabular",
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
  "proof", "example", "ack", "acks", "acknowledgments", "acknowledgements", "acknowledgment", "acknowledgement",
]);

/** The acknowledgments environments venue classes define (NeurIPS' `ack`, ACM's `acks`). */
export const ACKNOWLEDGMENT_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "ack", "acks", "acknowledgments", "acknowledgements", "acknowledgment", "acknowledgement",
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
