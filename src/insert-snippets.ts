import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

export type InsertGroup =
  | "Environment"
  | "Structure"
  | "Math"
  | "Greek"
  | "Operators"
  | "Relations"
  | "Arrows"
  | "Sets"
  | "Delimiters"
  | "Accents"
  | "Symbols";

export type InsertSnippet = {
  id: string;
  group: InsertGroup;
  /**
   * Name shown on the tile. A plain string only for entries whose name *is* a
   * LaTeX command (`\alpha`); everything a reader would translate is a
   * descriptor resolved against the active catalog at render time.
   */
  label: string | MessageDescriptor;
  detail: MessageDescriptor;
  insert: string;
  cursorOffset?: number;
  /** Visible glyph shown in the palette (Unicode). */
  glyph?: string;
  /** KaTeX source used for the preview tile when glyph is not enough. */
  mathPreview?: string;
  /** Short code preview for environments/snippets. */
  codePreview?: string;
};

/** Symbol entries are a command plus a Unicode glyph plus a translated name. */
type SymbolEntry = [command: string, glyph: string, name: MessageDescriptor];

function env(
  id: string,
  label: MessageDescriptor,
  detail: MessageDescriptor,
  insert: string,
  cursorOffset?: number,
): InsertSnippet {
  return {
    id,
    group: "Environment",
    label,
    detail,
    insert,
    cursorOffset,
    codePreview: insert.trim().split("\n").slice(0, 3).join("\n"),
  };
}

function structure(
  id: string,
  label: MessageDescriptor,
  detail: MessageDescriptor,
  insert: string,
  cursorOffset?: number,
): InsertSnippet {
  return {
    id,
    group: "Structure",
    label,
    detail,
    insert,
    cursorOffset,
    codePreview: insert.trim(),
  };
}

function math(
  id: string,
  label: MessageDescriptor,
  detail: MessageDescriptor,
  insert: string,
  mathPreview: string,
  cursorOffset?: number,
): InsertSnippet {
  return { id, group: "Math", label, detail, insert, mathPreview, cursorOffset };
}

function greek(command: string, glyph: string, name: MessageDescriptor): InsertSnippet {
  return {
    id: `greek-${command.replace("\\", "")}`,
    group: "Greek",
    label: command,
    detail: name,
    insert: command,
    glyph,
    mathPreview: command,
  };
}

function op(
  command: string,
  glyph: string,
  name: MessageDescriptor,
  group: InsertGroup = "Operators",
): InsertSnippet {
  return {
    id: `${group.toLowerCase()}-${command.replace(/\\/g, "")}`,
    group,
    label: command,
    detail: name,
    insert: command,
    glyph,
    mathPreview: command,
  };
}

export const INSERT_GROUPS: InsertGroup[] = [
  "Environment",
  "Structure",
  "Math",
  "Greek",
  "Operators",
  "Relations",
  "Arrows",
  "Sets",
  "Delimiters",
  "Accents",
  "Symbols",
];

/**
 * Groups whose entries are single commands with a glyph: they render as a dense
 * glyph grid rather than as description cards, because the command and the
 * glyph already say everything the name would repeat.
 */
export const INSERT_SYMBOL_GROUPS: InsertGroup[] = [
  "Greek",
  "Operators",
  "Relations",
  "Arrows",
  "Sets",
  "Delimiters",
  "Accents",
  "Symbols",
];

const GREEK_LETTERS: SymbolEntry[] = [
  ["\\alpha", "α", msg`Alpha`],
  ["\\beta", "β", msg`Beta`],
  ["\\gamma", "γ", msg`Gamma`],
  ["\\delta", "δ", msg`Delta`],
  ["\\epsilon", "ϵ", msg`Epsilon`],
  ["\\varepsilon", "ε", msg`Variant epsilon`],
  ["\\zeta", "ζ", msg`Zeta`],
  ["\\eta", "η", msg`Eta`],
  ["\\theta", "θ", msg`Theta`],
  ["\\vartheta", "ϑ", msg`Variant theta`],
  ["\\iota", "ι", msg`Iota`],
  ["\\kappa", "κ", msg`Kappa`],
  ["\\lambda", "λ", msg`Lambda`],
  ["\\mu", "μ", msg`Mu`],
  ["\\nu", "ν", msg`Nu`],
  ["\\xi", "ξ", msg`Xi`],
  ["\\pi", "π", msg`Pi`],
  ["\\varpi", "ϖ", msg`Variant pi`],
  ["\\rho", "ρ", msg`Rho`],
  ["\\varrho", "ϱ", msg`Variant rho`],
  ["\\sigma", "σ", msg`Sigma`],
  ["\\varsigma", "ς", msg`Final sigma`],
  ["\\tau", "τ", msg`Tau`],
  ["\\upsilon", "υ", msg`Upsilon`],
  ["\\phi", "ϕ", msg`Phi`],
  ["\\varphi", "φ", msg`Variant phi`],
  ["\\chi", "χ", msg`Chi`],
  ["\\psi", "ψ", msg`Psi`],
  ["\\omega", "ω", msg`Omega`],
  ["\\Gamma", "Γ", msg`Capital gamma`],
  ["\\Delta", "Δ", msg`Capital delta`],
  ["\\Theta", "Θ", msg`Capital theta`],
  ["\\Lambda", "Λ", msg`Capital lambda`],
  ["\\Xi", "Ξ", msg`Capital xi`],
  ["\\Pi", "Π", msg`Capital pi`],
  ["\\Sigma", "Σ", msg`Capital sigma`],
  ["\\Upsilon", "Υ", msg`Capital upsilon`],
  ["\\Phi", "Φ", msg`Capital phi`],
  ["\\Psi", "Ψ", msg`Capital psi`],
  ["\\Omega", "Ω", msg`Capital omega`],
];

const OPERATORS: SymbolEntry[] = [
  ["\\pm", "±", msg`Plus-minus`],
  ["\\mp", "∓", msg`Minus-plus`],
  ["\\times", "×", msg`Times / cross product`],
  ["\\div", "÷", msg`Division`],
  ["\\cdot", "·", msg`Centered dot`],
  ["\\ast", "∗", msg`Asterisk operator`],
  ["\\star", "⋆", msg`Star operator`],
  ["\\circ", "∘", msg`Composition / ring`],
  ["\\bullet", "•", msg`Bullet`],
  ["\\oplus", "⊕", msg`Circled plus`],
  ["\\ominus", "⊖", msg`Circled minus`],
  ["\\otimes", "⊗", msg`Circled times / tensor`],
  ["\\oslash", "⊘", msg`Circled slash`],
  ["\\odot", "⊙", msg`Circled dot`],
  ["\\dagger", "†", msg`Dagger`],
  ["\\ddagger", "‡", msg`Double dagger`],
  ["\\amalg", "⨿", msg`Amalgamation`],
  ["\\cap", "∩", msg`Intersection`],
  ["\\cup", "∪", msg`Union`],
  ["\\sqcap", "⊓", msg`Square cap`],
  ["\\sqcup", "⊔", msg`Square cup`],
  ["\\uplus", "⊎", msg`Multiset union`],
  ["\\vee", "∨", msg`Logical or`],
  ["\\wedge", "∧", msg`Logical and`],
  ["\\setminus", "∖", msg`Set minus`],
  ["\\wr", "≀", msg`Wreath product`],
  ["\\diamond", "⋄", msg`Diamond operator`],
  ["\\bigtriangleup", "△", msg`Big triangle up`],
  ["\\bigtriangledown", "▽", msg`Big triangle down`],
  ["\\triangleleft", "◁", msg`Triangle left`],
  ["\\triangleright", "▷", msg`Triangle right`],
  ["\\lhd", "⊲", msg`Left normal subgroup`],
  ["\\rhd", "⊳", msg`Right normal subgroup`],
  ["\\unlhd", "⊴", msg`Left normal subgroup eq`],
  ["\\unrhd", "⊵", msg`Right normal subgroup eq`],
];

const RELATIONS: SymbolEntry[] = [
  ["\\leq", "≤", msg`Less than or equal`],
  ["\\geq", "≥", msg`Greater than or equal`],
  ["\\neq", "≠", msg`Not equal`],
  ["\\approx", "≈", msg`Approximately equal`],
  ["\\equiv", "≡", msg`Equivalent / congruent`],
  ["\\sim", "∼", msg`Similar to`],
  ["\\simeq", "≃", msg`Similar or equal`],
  ["\\cong", "≅", msg`Congruent`],
  ["\\propto", "∝", msg`Proportional to`],
  ["\\models", "⊨", msg`Models / entails`],
  ["\\prec", "≺", msg`Precedes`],
  ["\\succ", "≻", msg`Succeeds`],
  ["\\preceq", "⪯", msg`Precedes or equal`],
  ["\\succeq", "⪰", msg`Succeeds or equal`],
  ["\\subset", "⊂", msg`Subset`],
  ["\\supset", "⊃", msg`Superset`],
  ["\\subseteq", "⊆", msg`Subset or equal`],
  ["\\supseteq", "⊇", msg`Superset or equal`],
  ["\\sqsubset", "⊏", msg`Square subset`],
  ["\\sqsupset", "⊐", msg`Square superset`],
  ["\\sqsubseteq", "⊑", msg`Square subset eq`],
  ["\\sqsupseteq", "⊒", msg`Square superset eq`],
  ["\\in", "∈", msg`Element of`],
  ["\\ni", "∋", msg`Contains as member`],
  ["\\notin", "∉", msg`Not an element of`],
  ["\\vdash", "⊢", msg`Proves / turnstile`],
  ["\\dashv", "⊣", msg`Reverse turnstile`],
  ["\\smile", "⌣", msg`Smile relation`],
  ["\\frown", "⌢", msg`Frown relation`],
  ["\\mid", "∣", msg`Divides / conditioned on`],
  ["\\parallel", "∥", msg`Parallel`],
  ["\\perp", "⊥", msg`Perpendicular`],
  ["\\bowtie", "⋈", msg`Natural join / bowtie`],
];

const ARROWS: SymbolEntry[] = [
  ["\\leftarrow", "←", msg`Left arrow`],
  ["\\rightarrow", "→", msg`Right arrow`],
  ["\\leftrightarrow", "↔", msg`Left-right arrow`],
  ["\\Leftarrow", "⇐", msg`Left double arrow`],
  ["\\Rightarrow", "⇒", msg`Right double arrow / implies`],
  ["\\Leftrightarrow", "⇔", msg`Left-right double arrow / iff`],
  ["\\mapsto", "↦", msg`Maps to`],
  ["\\hookleftarrow", "↩", msg`Hook left arrow`],
  ["\\hookrightarrow", "↪", msg`Hook right arrow`],
  ["\\leftharpoonup", "↼", msg`Left harpoon up`],
  ["\\rightharpoonup", "⇀", msg`Right harpoon up`],
  ["\\rightleftharpoons", "⇌", msg`Equilibrium arrows`],
  ["\\uparrow", "↑", msg`Up arrow`],
  ["\\downarrow", "↓", msg`Down arrow`],
  ["\\updownarrow", "↕", msg`Up-down arrow`],
  ["\\Uparrow", "⇑", msg`Up double arrow`],
  ["\\Downarrow", "⇓", msg`Down double arrow`],
  ["\\Updownarrow", "⇕", msg`Up-down double arrow`],
  ["\\nearrow", "↗", msg`North-east arrow`],
  ["\\searrow", "↘", msg`South-east arrow`],
  ["\\swarrow", "↙", msg`South-west arrow`],
  ["\\nwarrow", "↖", msg`North-west arrow`],
  ["\\to", "→", msg`To (short right arrow)`],
  ["\\gets", "←", msg`Gets (short left arrow)`],
  ["\\implies", "⟹", msg`Implies`],
  ["\\iff", "⟺", msg`If and only if`],
];

const SETS: SymbolEntry[] = [
  ["\\emptyset", "∅", msg`Empty set`],
  ["\\varnothing", "∅", msg`Empty set (variant)`],
];

const SYMBOLS: SymbolEntry[] = [
  ["\\infty", "∞", msg`Infinity`],
  ["\\nabla", "∇", msg`Nabla / del`],
  ["\\partial", "∂", msg`Partial derivative`],
  ["\\forall", "∀", msg`For all`],
  ["\\exists", "∃", msg`There exists`],
  ["\\nexists", "∄", msg`Does not exist`],
  ["\\neg", "¬", msg`Negation / not`],
  ["\\top", "⊤", msg`Top / true`],
  ["\\bot", "⊥", msg`Bottom / false`],
  ["\\angle", "∠", msg`Angle`],
  ["\\triangle", "△", msg`Triangle`],
  ["\\square", "□", msg`Square`],
  ["\\blacksquare", "■", msg`Filled square`],
  ["\\diamondsuit", "♢", msg`Diamond suit`],
  ["\\heartsuit", "♡", msg`Heart suit`],
  ["\\clubsuit", "♣", msg`Club suit`],
  ["\\spadesuit", "♠", msg`Spade suit`],
  ["\\flat", "♭", msg`Flat`],
  ["\\natural", "♮", msg`Natural`],
  ["\\sharp", "♯", msg`Sharp`],
];

const TEXT_SYMBOLS: SymbolEntry[] = [
  ["\\ell", "ℓ", msg`Script l`],
  ["\\hbar", "ℏ", msg`H-bar / reduced Planck`],
  ["\\imath", "ı", msg`Dotless i`],
  ["\\jmath", "ȷ", msg`Dotless j`],
  ["\\wp", "℘", msg`Weierstrass p`],
  ["\\Re", "ℜ", msg`Real part`],
  ["\\Im", "ℑ", msg`Imaginary part`],
  ["\\aleph", "ℵ", msg`Aleph`],
  ["\\beth", "ℶ", msg`Beth`],
  ["\\gimel", "ℷ", msg`Gimel`],
  ["\\daleth", "ℸ", msg`Daleth`],
  ["\\prime", "′", msg`Prime`],
  ["\\backprime", "‵", msg`Back prime`],
  ["\\% ", "%", msg`Percent`],
  ["\\&", "&", msg`Ampersand`],
  ["\\_", "_", msg`Underscore`],
  ["\\S", "§", msg`Section sign`],
  ["\\P", "¶", msg`Pilcrow / paragraph`],
  ["\\dag", "†", msg`Dagger text symbol`],
  ["\\ddag", "‡", msg`Double dagger text symbol`],
  ["\\copyright", "©", msg`Copyright`],
  ["\\pounds", "£", msg`Pounds sterling`],
];

const DELIMITERS: SymbolEntry[] = [
  ["\\langle", "⟨", msg`Left angle bracket`],
  ["\\rangle", "⟩", msg`Right angle bracket`],
  ["\\lfloor", "⌊", msg`Left floor`],
  ["\\rfloor", "⌋", msg`Right floor`],
  ["\\lceil", "⌈", msg`Left ceiling`],
  ["\\rceil", "⌉", msg`Right ceiling`],
  ["\\lvert", "|", msg`Left vertical bar`],
  ["\\rvert", "|", msg`Right vertical bar`],
  ["\\lVert", "‖", msg`Left double vertical bar`],
  ["\\rVert", "‖", msg`Right double vertical bar`],
  ["\\{", "{", msg`Left brace`],
  ["\\}", "}", msg`Right brace`],
];

/** `[preview, glyph, name, insert]` — accents need a sample letter to render. */
const ACCENTS: [preview: string, glyph: string, name: MessageDescriptor, insert: string][] = [
  ["\\hat{a}", "â", msg`Hat accent example`, "\\hat{}"],
  ["\\check{a}", "ǎ", msg`Check accent example`, "\\check{}"],
  ["\\tilde{a}", "ã", msg`Tilde accent example`, "\\tilde{}"],
  ["\\acute{a}", "á", msg`Acute accent example`, "\\acute{}"],
  ["\\grave{a}", "à", msg`Grave accent example`, "\\grave{}"],
  ["\\dot{a}", "ȧ", msg`Dot accent example`, "\\dot{}"],
  ["\\ddot{a}", "ä", msg`Double-dot accent example`, "\\ddot{}"],
  ["\\breve{a}", "ă", msg`Breve accent example`, "\\breve{}"],
  ["\\bar{a}", "ā", msg`Bar accent example`, "\\bar{}"],
  ["\\vec{a}", "a⃗", msg`Vector accent example`, "\\vec{}"],
];

export const INSERT_SNIPPETS: InsertSnippet[] = [
  env(
    "env-figure",
    msg`Figure`,
    msg`Floating figure with image, caption, and label (requires graphicx)`,
    "\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${1:path/to/figure.pdf}}\n  \\caption{${2:Caption}}\n  \\label{${3:fig:name}}\n\\end{figure}\n",
  ),
  env(
    "env-table",
    msg`Table`,
    msg`Floating table with ruled rows (requires booktabs)`,
    "\\begin{table}[t]\n  \\centering\n  \\caption{${1:Caption}}\n  \\label{${2:tab:name}}\n  \\begin{tabular}{lcc}\n    \\toprule\n    Method & Score & Notes \\\\\n    \\midrule\n    Ours & 90 &  \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n",
  ),
  env(
    "env-equation",
    msg`Equation`,
    msg`Numbered single-line equation`,
    "\\begin{equation}\n  ${1:}\n  \\label{${2:eq:name}}\n\\end{equation}\n",
  ),
  env(
    "env-equation-star",
    msg`Equation*`,
    msg`Unnumbered single-line equation`,
    "\\begin{equation*}\n  ${1:}\n\\end{equation*}\n",
  ),
  env(
    "env-align",
    msg`Align`,
    msg`Multi-line aligned equations`,
    "\\begin{align}\n  a &= b \\\\\n  c &= d\n\\end{align}\n",
    14,
  ),
  env(
    "env-align-star",
    msg`Align*`,
    msg`Unnumbered aligned equations`,
    "\\begin{align*}\n  a &= b \\\\\n  c &= d\n\\end{align*}\n",
    15,
  ),
  env(
    "env-gather",
    msg`Gather`,
    msg`Centered multi-line equations`,
    "\\begin{gather}\n  a = b \\\\\n  c = d\n\\end{gather}\n",
    15,
  ),
  env(
    "env-gather-star",
    msg`Gather*`,
    msg`Unnumbered centered equations`,
    "\\begin{gather*}\n  a = b \\\\\n  c = d\n\\end{gather*}\n",
    16,
  ),
  env(
    "env-subequations",
    msg`Subequations`,
    msg`Grouped numbered equations`,
    "\\begin{subequations}\n  \\begin{align}\n    a &= b \\\\\n    c &= d\n  \\end{align}\n\\end{subequations}\n",
    36,
  ),
  env(
    "env-bmatrix",
    msg`Bmatrix`,
    msg`Bracketed matrix`,
    "\\begin{bmatrix}\n  a & b \\\\\n  c & d\n\\end{bmatrix}",
    18,
  ),
  env(
    "env-vmatrix",
    msg`Vmatrix`,
    msg`Determinant-style matrix`,
    "\\begin{vmatrix}\n  a & b \\\\\n  c & d\n\\end{vmatrix}",
    18,
  ),
  env(
    "env-Bmatrix",
    msg`Curly matrix`,
    msg`Brace-delimited matrix`,
    "\\begin{Bmatrix}\n  a & b \\\\\n  c & d\n\\end{Bmatrix}",
    18,
  ),
  env(
    "env-multline",
    msg`Multline`,
    msg`Long equation broken across lines`,
    "\\begin{multline}\n  a + b + c \\\\\n  + d + e\n\\end{multline}\n",
    17,
  ),
  env(
    "env-cases",
    msg`Cases`,
    msg`Piecewise definition`,
    "\\begin{cases}\n  a & \\text{if } x > 0 \\\\\n  b & \\text{otherwise}\n\\end{cases}",
    14,
  ),
  env(
    "env-itemize",
    msg`Itemize`,
    msg`Bulleted list`,
    "\\begin{itemize}\n  \\item \n\\end{itemize}\n",
    24,
  ),
  env(
    "env-enumerate",
    msg`Enumerate`,
    msg`Numbered list`,
    "\\begin{enumerate}\n  \\item \n\\end{enumerate}\n",
    26,
  ),
  env(
    "env-description",
    msg`Description`,
    msg`Labeled description list`,
    "\\begin{description}\n  \\item[Term] Definition\n\\end{description}\n",
    28,
  ),
  env(
    "env-quote",
    msg`Quote`,
    msg`Block quotation`,
    "\\begin{quote}\n  \n\\end{quote}\n",
    14,
  ),
  env(
    "env-abstract",
    msg`Abstract`,
    msg`Abstract environment`,
    "\\begin{abstract}\n  \n\\end{abstract}\n",
    17,
  ),
  env(
    "env-theorem",
    msg`Theorem`,
    msg`Theorem block (requires amsthm and a \\newtheorem declaration)`,
    "\\begin{theorem}\n  \n\\end{theorem}\n",
    16,
  ),
  env(
    "env-proof",
    msg`Proof`,
    msg`Proof environment (requires amsthm)`,
    "\\begin{proof}\n  \n\\end{proof}\n",
    14,
  ),
  env(
    "env-verbatim",
    msg`Verbatim`,
    msg`Literal code / text block`,
    "\\begin{verbatim}\n\n\\end{verbatim}\n",
    17,
  ),
  env(
    "env-algorithm",
    msg`Algorithm`,
    msg`Algorithm block (requires algorithm and algpseudocode)`,
    "\\begin{algorithm}\n  \\caption{Caption}\n  \\label{alg:name}\n  \\begin{algorithmic}[1]\n    \\State \n  \\end{algorithmic}\n\\end{algorithm}\n",
    93,
  ),
  env(
    "env-lstlisting",
    msg`Code listing`,
    msg`Syntax-highlighted listing (listings)`,
    "\\begin{lstlisting}[language=Python]\n\n\\end{lstlisting}\n",
    36,
  ),
  env(
    "env-minipage",
    msg`Minipage`,
    msg`Side-by-side column block`,
    "\\begin{minipage}{0.48\\linewidth}\n  \n\\end{minipage}\n",
    35,
  ),
  env(
    "env-center",
    msg`Center`,
    msg`Centered block`,
    "\\begin{center}\n  \n\\end{center}\n",
    15,
  ),

  structure("sec-section", msg`Section`, msg`Top-level section heading`, "\\section{}\n", 9),
  structure("sec-subsection", msg`Subsection`, msg`Second-level heading`, "\\subsection{}\n", 12),
  structure("sec-subsubsection", msg`Subsubsection`, msg`Third-level heading`, "\\subsubsection{}\n", 15),
  structure("sec-paragraph", msg`Paragraph`, msg`Run-in paragraph heading`, "\\paragraph{}\n", 11),
  structure("sec-label", msg`Label`, msg`Cross-reference label`, "\\label{}", 7),
  structure("sec-ref", msg`Reference`, msg`Reference an existing label`, "\\ref{}", 5),
  structure("sec-eqref", msg`Equation reference`, msg`Reference an equation label`, "\\eqref{}", 7),
  structure("sec-cite", msg`Citation`, msg`Bibliographic citation (requires natbib or compatible package)`, "\\citep{}", 7),
  structure("sec-textbf", msg`Bold`, msg`Bold text command`, "\\textbf{}", 8),
  structure("sec-emph", msg`Emphasis`, msg`Emphasized text command`, "\\emph{}", 6),
  structure("sec-footnote", msg`Footnote`, msg`Footnote at the cursor`, "\\footnote{}", 10),
  structure("sec-includegraphics", msg`Include graphics`, msg`Insert an image path (requires graphicx)`, "\\includegraphics[width=\\linewidth]{}", 35),
  structure("sec-input", msg`Input file`, msg`Inline another TeX file`, "\\input{}", 7),
  structure("sec-include", msg`Include file`, msg`Include another TeX file`, "\\include{}", 9),

  math("math-inline", msg`Inline math`, msg`Math inside a sentence`, "$ $", "x", 1),
  math("math-display", msg`Display math`, msg`Centered display equation`, "\\[\n  \n\\]\n", "x^{2}", 4),
  math("math-frac", msg`Fraction`, msg`a over b`, "\\frac{}{}", "\\frac{a}{b}", 6),
  math("math-dfrac", msg`Display fraction`, msg`Larger fraction`, "\\dfrac{}{}", "\\dfrac{a}{b}", 7),
  math("math-sqrt", msg`Square root`, msg`Radical`, "\\sqrt{}", "\\sqrt{x}", 6),
  math("math-sqrtn", msg`Nth root`, msg`Root with index`, "\\sqrt[]{}", "\\sqrt[n]{x}", 6),
  math("math-sum", msg`Summation`, msg`Sum with limits`, "\\sum_{i=1}^{n} ", "\\sum_{i=1}^{n}", 15),
  math("math-prod", msg`Product`, msg`Product with limits`, "\\prod_{i=1}^{n} ", "\\prod_{i=1}^{n}", 16),
  math("math-int", msg`Integral`, msg`Integral with limits`, "\\int_{a}^{b} ", "\\int_{a}^{b}", 13),
  math("math-iint", msg`Double integral`, msg`Surface / area integral`, "\\iint ", "\\iint", 6),
  math("math-oint", msg`Contour integral`, msg`Closed-path integral`, "\\oint ", "\\oint", 6),
  math("math-lim", msg`Limit`, msg`Limit expression`, "\\lim_{n \\to \\infty} ", "\\lim_{n \\to \\infty}", 20),
  math("math-max", msg`Max`, msg`Maximum operator`, "\\max_{x} ", "\\max_{x}", 8),
  math("math-min", msg`Min`, msg`Minimum operator`, "\\min_{x} ", "\\min_{x}", 8),
  math("math-mathbb", msg`Blackboard bold`, msg`Number sets like R, N`, "\\mathbb{}", "\\mathbb{R}", 8),
  math("math-mathcal", msg`Calligraphic`, msg`Script letters`, "\\mathcal{}", "\\mathcal{L}", 9),
  math("math-mathrm", msg`Roman math`, msg`Upright text in math`, "\\mathrm{}", "\\mathrm{d}x", 8),
  math("math-text", msg`Text in math`, msg`Words inside math mode`, "\\text{}", "\\text{if}", 6),
  math("math-overline", msg`Overline`, msg`Bar over an expression`, "\\overline{}", "\\overline{x}", 10),
  math("math-underline", msg`Underline`, msg`Line under an expression`, "\\underline{}", "\\underline{x}", 11),
  math("math-hat", msg`Hat accent`, msg`Estimator / unit vector mark`, "\\hat{}", "\\hat{x}", 5),
  math("math-bar", msg`Bar accent`, msg`Mean / conjugate mark`, "\\bar{}", "\\bar{x}", 5),
  math("math-vec", msg`Vector accent`, msg`Vector arrow over a symbol`, "\\vec{}", "\\vec{x}", 5),
  math("math-dot", msg`Dot accent`, msg`Time derivative mark`, "\\dot{}", "\\dot{x}", 5),
  math("math-binom", msg`Binomial`, msg`Binomial coefficient`, "\\binom{}{}", "\\binom{n}{k}", 7),
  math("math-matrix", msg`Matrix`, msg`Parenthesized matrix`, "\\begin{pmatrix}\n  a & b \\\\\n  c & d\n\\end{pmatrix}", "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", 18),

  ...GREEK_LETTERS.map(([command, glyph, name]) => greek(command, glyph, name)),
  ...OPERATORS.map(([command, glyph, name]) => op(command, glyph, name, "Operators")),
  ...RELATIONS.map(([command, glyph, name]) => op(command, glyph, name, "Relations")),
  ...ARROWS.map(([command, glyph, name]) => op(command, glyph, name, "Arrows")),
  ...SETS.map(([command, glyph, name]) => op(command, glyph, name, "Sets")),
  ...SYMBOLS.map(([command, glyph, name]) => op(command, glyph, name, "Symbols")),
  ...DELIMITERS.map(([command, glyph, name]) => op(command, glyph, name, "Delimiters")),

  ...ACCENTS.map(([preview, glyph, name, insert], index) => ({
    id: `accent-${index}`,
    group: "Accents" as const,
    label: insert,
    detail: name,
    insert,
    cursorOffset: insert.length - 1,
    glyph,
    mathPreview: preview,
  })),

  {
    id: "symbols-degree",
    group: "Symbols",
    label: "^{\\circ}",
    detail: msg`Degree`,
    insert: "^{\\circ}",
    glyph: "°",
    mathPreview: "90^{\\circ}",
  },

  ...TEXT_SYMBOLS.map(([command, glyph, name]) => op(command.trimEnd(), glyph, name, "Symbols")),
];
