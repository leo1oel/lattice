import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

/**
 * Groups whose entries are single commands with a glyph: they render as a dense
 * glyph grid rather than as description cards, because the command and the
 * glyph already say everything the name would repeat.
 */
/* eslint-disable lingui/no-unlocalized-strings -- group keys; the palette's useGroupLabels translates them */
export const INSERT_SYMBOL_GROUPS = ["Greek", "Operators", "Relations", "Arrows", "Sets", "Delimiters", "Accents", "Symbols"] as const;
export const INSERT_GROUPS = ["Environment", "Structure", "Math", ...INSERT_SYMBOL_GROUPS] as const;
/* eslint-enable lingui/no-unlocalized-strings */
export type InsertGroup = (typeof INSERT_GROUPS)[number];
type SymbolGroup = (typeof INSERT_SYMBOL_GROUPS)[number];

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

type CodeRow = [id: string, label: MessageDescriptor, detail: MessageDescriptor, insert: string, cursorOffset?: number];
type MathRow = [...CodeRow, mathPreview: string];
/** `preview` defaults to the inserted command; accents need a sample letter to render. */
type SymbolRow = [insert: string, glyph: string, name: MessageDescriptor, preview?: string];

const ENVIRONMENTS: CodeRow[] = [
  ["env-figure", msg`Figure`, msg`Floating figure with image, caption, and label (requires graphicx)`, "\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${1:path/to/figure.pdf}}\n  \\caption{${2:Caption}}\n  \\label{${3:fig:name}}\n\\end{figure}\n"],
  ["env-table", msg`Table`, msg`Floating table with ruled rows (requires booktabs)`, "\\begin{table}[t]\n  \\centering\n  \\caption{${1:Caption}}\n  \\label{${2:tab:name}}\n  \\begin{tabular}{lcc}\n    \\toprule\n    Method & Score & Notes \\\\\n    \\midrule\n    Ours & 90 &  \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n"],
  ["env-equation", msg`Equation`, msg`Numbered single-line equation`, "\\begin{equation}\n  ${1:}\n  \\label{${2:eq:name}}\n\\end{equation}\n"],
  ["env-equation-star", msg`Equation*`, msg`Unnumbered single-line equation`, "\\begin{equation*}\n  ${1:}\n\\end{equation*}\n"],
  ["env-align", msg`Align`, msg`Multi-line aligned equations`, "\\begin{align}\n  a &= b \\\\\n  c &= d\n\\end{align}\n", 14],
  ["env-align-star", msg`Align*`, msg`Unnumbered aligned equations`, "\\begin{align*}\n  a &= b \\\\\n  c &= d\n\\end{align*}\n", 15],
  ["env-gather", msg`Gather`, msg`Centered multi-line equations`, "\\begin{gather}\n  a = b \\\\\n  c = d\n\\end{gather}\n", 15],
  ["env-gather-star", msg`Gather*`, msg`Unnumbered centered equations`, "\\begin{gather*}\n  a = b \\\\\n  c = d\n\\end{gather*}\n", 16],
  ["env-subequations", msg`Subequations`, msg`Grouped numbered equations`, "\\begin{subequations}\n  \\begin{align}\n    a &= b \\\\\n    c &= d\n  \\end{align}\n\\end{subequations}\n", 36],
  ["env-bmatrix", msg`Bmatrix`, msg`Bracketed matrix`, "\\begin{bmatrix}\n  a & b \\\\\n  c & d\n\\end{bmatrix}", 18],
  ["env-vmatrix", msg`Vmatrix`, msg`Determinant-style matrix`, "\\begin{vmatrix}\n  a & b \\\\\n  c & d\n\\end{vmatrix}", 18],
  // eslint-disable-next-line lingui/no-unlocalized-strings -- snippet id
  ["env-Bmatrix", msg`Curly matrix`, msg`Brace-delimited matrix`, "\\begin{Bmatrix}\n  a & b \\\\\n  c & d\n\\end{Bmatrix}", 18],
  ["env-multline", msg`Multline`, msg`Long equation broken across lines`, "\\begin{multline}\n  a + b + c \\\\\n  + d + e\n\\end{multline}\n", 17],
  ["env-cases", msg`Cases`, msg`Piecewise definition`, "\\begin{cases}\n  a & \\text{if } x > 0 \\\\\n  b & \\text{otherwise}\n\\end{cases}", 14],
  ["env-itemize", msg`Itemize`, msg`Bulleted list`, "\\begin{itemize}\n  \\item \n\\end{itemize}\n", 24],
  ["env-enumerate", msg`Enumerate`, msg`Numbered list`, "\\begin{enumerate}\n  \\item \n\\end{enumerate}\n", 26],
  ["env-description", msg`Description`, msg`Labeled description list`, "\\begin{description}\n  \\item[Term] Definition\n\\end{description}\n", 28],
  ["env-quote", msg`Quote`, msg`Block quotation`, "\\begin{quote}\n  \n\\end{quote}\n", 14],
  ["env-abstract", msg`Abstract`, msg`Abstract environment`, "\\begin{abstract}\n  \n\\end{abstract}\n", 17],
  ["env-theorem", msg`Theorem`, msg`Theorem block (requires amsthm and a \\newtheorem declaration)`, "\\begin{theorem}\n  \n\\end{theorem}\n", 16],
  ["env-proof", msg`Proof`, msg`Proof environment (requires amsthm)`, "\\begin{proof}\n  \n\\end{proof}\n", 14],
  ["env-verbatim", msg`Verbatim`, msg`Literal code / text block`, "\\begin{verbatim}\n\n\\end{verbatim}\n", 17],
  ["env-algorithm", msg`Algorithm`, msg`Algorithm block (requires algorithm and algpseudocode)`, "\\begin{algorithm}\n  \\caption{Caption}\n  \\label{alg:name}\n  \\begin{algorithmic}[1]\n    \\State \n  \\end{algorithmic}\n\\end{algorithm}\n", 93],
  ["env-lstlisting", msg`Code listing`, msg`Syntax-highlighted listing (listings)`, "\\begin{lstlisting}[language=Python]\n\n\\end{lstlisting}\n", 36],
  ["env-minipage", msg`Minipage`, msg`Side-by-side column block`, "\\begin{minipage}{0.48\\linewidth}\n  \n\\end{minipage}\n", 35],
  ["env-center", msg`Center`, msg`Centered block`, "\\begin{center}\n  \n\\end{center}\n", 15],
];

const STRUCTURES: CodeRow[] = [
  ["sec-section", msg`Section`, msg`Top-level section heading`, "\\section{}\n", 9],
  ["sec-subsection", msg`Subsection`, msg`Second-level heading`, "\\subsection{}\n", 12],
  ["sec-subsubsection", msg`Subsubsection`, msg`Third-level heading`, "\\subsubsection{}\n", 15],
  ["sec-paragraph", msg({ message: "Paragraph", context: "LaTeX heading" }), msg`Run-in paragraph heading`, "\\paragraph{}\n", 11],
  ["sec-label", msg`Label`, msg`Cross-reference label`, "\\label{}", 7],
  ["sec-ref", msg`Reference`, msg`Reference an existing label`, "\\ref{}", 5],
  ["sec-eqref", msg`Equation reference`, msg`Reference an equation label`, "\\eqref{}", 7],
  ["sec-cite", msg`Citation`, msg`Bibliographic citation (requires natbib or compatible package)`, "\\citep{}", 7],
  ["sec-textbf", msg`Bold`, msg`Bold text command`, "\\textbf{}", 8],
  ["sec-emph", msg`Emphasis`, msg`Emphasized text command`, "\\emph{}", 6],
  ["sec-footnote", msg`Footnote`, msg`Footnote at the cursor`, "\\footnote{}", 10],
  ["sec-includegraphics", msg`Include graphics`, msg`Insert an image path (requires graphicx)`, "\\includegraphics[width=\\linewidth]{}", 35],
  ["sec-input", msg`Input file`, msg`Inline another TeX file`, "\\input{}", 7],
  ["sec-include", msg`Include file`, msg`Include another TeX file`, "\\include{}", 9],
];

const MATH: MathRow[] = [
  ["math-inline", msg`Inline math`, msg`Math inside a sentence`, "$ $", 1, "x"],
  // eslint-disable-next-line lingui/no-unlocalized-strings -- KaTeX preview source
  ["math-display", msg`Display math`, msg`Centered display equation`, "\\[\n  \n\\]\n", 4, "x^{2}"],
  ["math-frac", msg`Fraction`, msg`a over b`, "\\frac{}{}", 6, "\\frac{a}{b}"],
  ["math-dfrac", msg`Display fraction`, msg`Larger fraction`, "\\dfrac{}{}", 7, "\\dfrac{a}{b}"],
  ["math-sqrt", msg`Square root`, msg`Radical`, "\\sqrt{}", 6, "\\sqrt{x}"],
  ["math-sqrtn", msg`Nth root`, msg`Root with index`, "\\sqrt[]{}", 6, "\\sqrt[n]{x}"],
  ["math-sum", msg`Summation`, msg`Sum with limits`, "\\sum_{i=1}^{n} ", 15, "\\sum_{i=1}^{n}"],
  ["math-prod", msg`Product`, msg`Product with limits`, "\\prod_{i=1}^{n} ", 16, "\\prod_{i=1}^{n}"],
  ["math-int", msg`Integral`, msg`Integral with limits`, "\\int_{a}^{b} ", 13, "\\int_{a}^{b}"],
  ["math-iint", msg`Double integral`, msg`Surface / area integral`, "\\iint ", 6, "\\iint"],
  ["math-oint", msg`Contour integral`, msg`Closed-path integral`, "\\oint ", 6, "\\oint"],
  ["math-lim", msg`Limit`, msg`Limit expression`, "\\lim_{n \\to \\infty} ", 20, "\\lim_{n \\to \\infty}"],
  ["math-max", msg`Max`, msg`Maximum operator`, "\\max_{x} ", 8, "\\max_{x}"],
  ["math-min", msg`Min`, msg`Minimum operator`, "\\min_{x} ", 8, "\\min_{x}"],
  ["math-mathbb", msg`Blackboard bold`, msg`Number sets like R, N`, "\\mathbb{}", 8, "\\mathbb{R}"],
  ["math-mathcal", msg`Calligraphic`, msg`Script letters`, "\\mathcal{}", 9, "\\mathcal{L}"],
  ["math-mathrm", msg`Roman math`, msg`Upright text in math`, "\\mathrm{}", 8, "\\mathrm{d}x"],
  ["math-text", msg`Text in math`, msg`Words inside math mode`, "\\text{}", 6, "\\text{if}"],
  ["math-overline", msg`Overline`, msg`Bar over an expression`, "\\overline{}", 10, "\\overline{x}"],
  ["math-underline", msg`Underline`, msg`Line under an expression`, "\\underline{}", 11, "\\underline{x}"],
  ["math-hat", msg`Hat accent`, msg`Estimator / unit vector mark`, "\\hat{}", 5, "\\hat{x}"],
  ["math-bar", msg`Bar accent`, msg`Mean / conjugate mark`, "\\bar{}", 5, "\\bar{x}"],
  ["math-vec", msg`Vector accent`, msg`Vector arrow over a symbol`, "\\vec{}", 5, "\\vec{x}"],
  ["math-dot", msg`Dot accent`, msg`Time derivative mark`, "\\dot{}", 5, "\\dot{x}"],
  ["math-binom", msg`Binomial`, msg`Binomial coefficient`, "\\binom{}{}", 7, "\\binom{n}{k}"],
  ["math-matrix", msg`Matrix`, msg`Parenthesized matrix`, "\\begin{pmatrix}\n  a & b \\\\\n  c & d\n\\end{pmatrix}", 18, "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}"],
];

const SYMBOLS: Record<SymbolGroup, SymbolRow[]> = {
  Greek: [
    ["\\alpha", "α", msg`Alpha`], ["\\beta", "β", msg`Beta`], ["\\gamma", "γ", msg`Gamma`],
    ["\\delta", "δ", msg`Delta`], ["\\epsilon", "ϵ", msg`Epsilon`], ["\\varepsilon", "ε", msg`Variant epsilon`],
    ["\\zeta", "ζ", msg`Zeta`], ["\\eta", "η", msg`Eta`], ["\\theta", "θ", msg`Theta`],
    ["\\vartheta", "ϑ", msg`Variant theta`], ["\\iota", "ι", msg`Iota`], ["\\kappa", "κ", msg`Kappa`],
    ["\\lambda", "λ", msg`Lambda`], ["\\mu", "μ", msg`Mu`], ["\\nu", "ν", msg`Nu`],
    ["\\xi", "ξ", msg`Xi`], ["\\pi", "π", msg`Pi`], ["\\varpi", "ϖ", msg`Variant pi`],
    ["\\rho", "ρ", msg`Rho`], ["\\varrho", "ϱ", msg`Variant rho`], ["\\sigma", "σ", msg`Sigma`],
    ["\\varsigma", "ς", msg`Final sigma`], ["\\tau", "τ", msg`Tau`], ["\\upsilon", "υ", msg`Upsilon`],
    ["\\phi", "ϕ", msg`Phi`], ["\\varphi", "φ", msg`Variant phi`], ["\\chi", "χ", msg`Chi`],
    ["\\psi", "ψ", msg`Psi`], ["\\omega", "ω", msg`Omega`], ["\\Gamma", "Γ", msg`Capital gamma`],
    ["\\Delta", "Δ", msg`Capital delta`], ["\\Theta", "Θ", msg`Capital theta`], ["\\Lambda", "Λ", msg`Capital lambda`],
    ["\\Xi", "Ξ", msg`Capital xi`], ["\\Pi", "Π", msg`Capital pi`], ["\\Sigma", "Σ", msg`Capital sigma`],
    ["\\Upsilon", "Υ", msg`Capital upsilon`], ["\\Phi", "Φ", msg`Capital phi`], ["\\Psi", "Ψ", msg`Capital psi`],
    ["\\Omega", "Ω", msg`Capital omega`],
  ],
  Operators: [
    ["\\pm", "±", msg`Plus-minus`], ["\\mp", "∓", msg`Minus-plus`], ["\\times", "×", msg`Times / cross product`],
    ["\\div", "÷", msg`Division`], ["\\cdot", "·", msg`Centered dot`], ["\\ast", "∗", msg`Asterisk operator`],
    ["\\star", "⋆", msg`Star operator`], ["\\circ", "∘", msg`Composition / ring`], ["\\bullet", "•", msg`Bullet`],
    ["\\oplus", "⊕", msg`Circled plus`], ["\\ominus", "⊖", msg`Circled minus`], ["\\otimes", "⊗", msg`Circled times / tensor`],
    ["\\oslash", "⊘", msg`Circled slash`], ["\\odot", "⊙", msg`Circled dot`], ["\\dagger", "†", msg`Dagger`],
    ["\\ddagger", "‡", msg`Double dagger`], ["\\amalg", "⨿", msg`Amalgamation`], ["\\cap", "∩", msg`Intersection`],
    ["\\cup", "∪", msg`Union`], ["\\sqcap", "⊓", msg`Square cap`], ["\\sqcup", "⊔", msg`Square cup`],
    ["\\uplus", "⊎", msg`Multiset union`], ["\\vee", "∨", msg`Logical or`], ["\\wedge", "∧", msg`Logical and`],
    ["\\setminus", "∖", msg`Set minus`], ["\\wr", "≀", msg`Wreath product`], ["\\diamond", "⋄", msg`Diamond operator`],
    ["\\bigtriangleup", "△", msg`Big triangle up`], ["\\bigtriangledown", "▽", msg`Big triangle down`],
    ["\\triangleleft", "◁", msg`Triangle left`], ["\\triangleright", "▷", msg`Triangle right`],
    ["\\lhd", "⊲", msg`Left normal subgroup`], ["\\rhd", "⊳", msg`Right normal subgroup`],
    ["\\unlhd", "⊴", msg`Left normal subgroup eq`], ["\\unrhd", "⊵", msg`Right normal subgroup eq`],
  ],
  Relations: [
    ["\\leq", "≤", msg`Less than or equal`], ["\\geq", "≥", msg`Greater than or equal`], ["\\neq", "≠", msg`Not equal`],
    ["\\approx", "≈", msg`Approximately equal`], ["\\equiv", "≡", msg`Equivalent / congruent`], ["\\sim", "∼", msg`Similar to`],
    ["\\simeq", "≃", msg`Similar or equal`], ["\\cong", "≅", msg`Congruent`], ["\\propto", "∝", msg`Proportional to`],
    ["\\models", "⊨", msg`Models / entails`], ["\\prec", "≺", msg`Precedes`], ["\\succ", "≻", msg`Succeeds`],
    ["\\preceq", "⪯", msg`Precedes or equal`], ["\\succeq", "⪰", msg`Succeeds or equal`], ["\\subset", "⊂", msg`Subset`],
    ["\\supset", "⊃", msg`Superset`], ["\\subseteq", "⊆", msg`Subset or equal`], ["\\supseteq", "⊇", msg`Superset or equal`],
    ["\\sqsubset", "⊏", msg`Square subset`], ["\\sqsupset", "⊐", msg`Square superset`],
    ["\\sqsubseteq", "⊑", msg`Square subset eq`], ["\\sqsupseteq", "⊒", msg`Square superset eq`],
    ["\\in", "∈", msg`Element of`], ["\\ni", "∋", msg`Contains as member`], ["\\notin", "∉", msg`Not an element of`],
    ["\\vdash", "⊢", msg`Proves / turnstile`], ["\\dashv", "⊣", msg`Reverse turnstile`], ["\\smile", "⌣", msg`Smile relation`],
    ["\\frown", "⌢", msg`Frown relation`], ["\\mid", "∣", msg`Divides / conditioned on`], ["\\parallel", "∥", msg`Parallel`],
    ["\\perp", "⊥", msg`Perpendicular`], ["\\bowtie", "⋈", msg`Natural join / bowtie`],
  ],
  Arrows: [
    ["\\leftarrow", "←", msg`Left arrow`], ["\\rightarrow", "→", msg`Right arrow`], ["\\leftrightarrow", "↔", msg`Left-right arrow`],
    ["\\Leftarrow", "⇐", msg`Left double arrow`], ["\\Rightarrow", "⇒", msg`Right double arrow / implies`],
    ["\\Leftrightarrow", "⇔", msg`Left-right double arrow / iff`], ["\\mapsto", "↦", msg`Maps to`],
    ["\\hookleftarrow", "↩", msg`Hook left arrow`], ["\\hookrightarrow", "↪", msg`Hook right arrow`],
    ["\\leftharpoonup", "↼", msg`Left harpoon up`], ["\\rightharpoonup", "⇀", msg`Right harpoon up`],
    ["\\rightleftharpoons", "⇌", msg`Equilibrium arrows`], ["\\uparrow", "↑", msg`Up arrow`], ["\\downarrow", "↓", msg`Down arrow`],
    ["\\updownarrow", "↕", msg`Up-down arrow`], ["\\Uparrow", "⇑", msg`Up double arrow`], ["\\Downarrow", "⇓", msg`Down double arrow`],
    ["\\Updownarrow", "⇕", msg`Up-down double arrow`], ["\\nearrow", "↗", msg`North-east arrow`],
    ["\\searrow", "↘", msg`South-east arrow`], ["\\swarrow", "↙", msg`South-west arrow`], ["\\nwarrow", "↖", msg`North-west arrow`],
    ["\\to", "→", msg`To (short right arrow)`], ["\\gets", "←", msg`Gets (short left arrow)`],
    ["\\implies", "⟹", msg`Implies`], ["\\iff", "⟺", msg`If and only if`],
  ],
  Sets: [["\\emptyset", "∅", msg`Empty set`], ["\\varnothing", "∅", msg`Empty set (variant)`]],
  Delimiters: [
    ["\\langle", "⟨", msg`Left angle bracket`], ["\\rangle", "⟩", msg`Right angle bracket`],
    ["\\lfloor", "⌊", msg`Left floor`], ["\\rfloor", "⌋", msg`Right floor`],
    ["\\lceil", "⌈", msg`Left ceiling`], ["\\rceil", "⌉", msg`Right ceiling`],
    ["\\lvert", "|", msg`Left vertical bar`], ["\\rvert", "|", msg`Right vertical bar`],
    ["\\lVert", "‖", msg`Left double vertical bar`], ["\\rVert", "‖", msg`Right double vertical bar`],
    ["\\{", "{", msg`Left brace`], ["\\}", "}", msg`Right brace`],
  ],
  Accents: [
    ["\\hat{}", "â", msg`Hat accent example`, "\\hat{a}"], ["\\check{}", "ǎ", msg`Check accent example`, "\\check{a}"],
    ["\\tilde{}", "ã", msg`Tilde accent example`, "\\tilde{a}"], ["\\acute{}", "á", msg`Acute accent example`, "\\acute{a}"],
    ["\\grave{}", "à", msg`Grave accent example`, "\\grave{a}"], ["\\dot{}", "ȧ", msg`Dot accent example`, "\\dot{a}"],
    ["\\ddot{}", "ä", msg`Double-dot accent example`, "\\ddot{a}"], ["\\breve{}", "ă", msg`Breve accent example`, "\\breve{a}"],
    // eslint-disable-next-line lingui/no-unlocalized-strings -- accent glyph
    ["\\bar{}", "ā", msg`Bar accent example`, "\\bar{a}"], ["\\vec{}", "a⃗", msg`Vector accent example`, "\\vec{a}"],
  ],
  Symbols: [
    ["\\infty", "∞", msg`Infinity`], ["\\nabla", "∇", msg`Nabla / del`], ["\\partial", "∂", msg`Partial derivative`],
    ["\\forall", "∀", msg`For all`], ["\\exists", "∃", msg`There exists`], ["\\nexists", "∄", msg`Does not exist`],
    ["\\neg", "¬", msg`Negation / not`], ["\\top", "⊤", msg`Top / true`], ["\\bot", "⊥", msg`Bottom / false`],
    ["\\angle", "∠", msg`Angle`], ["\\triangle", "△", msg`Triangle`], ["\\square", "□", msg`Square`],
    ["\\blacksquare", "■", msg`Filled square`], ["\\diamondsuit", "♢", msg`Diamond suit`], ["\\heartsuit", "♡", msg`Heart suit`],
    ["\\clubsuit", "♣", msg`Club suit`], ["\\spadesuit", "♠", msg`Spade suit`], ["\\flat", "♭", msg`Flat`],
    ["\\natural", "♮", msg`Natural`], ["\\sharp", "♯", msg`Sharp`],
    // A baseline LaTeX expression: `\degree` needs gensymb.
    // eslint-disable-next-line lingui/no-unlocalized-strings -- LaTeX source and its KaTeX preview
    ["^{\\circ}", "°", msg`Degree`, "90^{\\circ}"],
    ["\\ell", "ℓ", msg`Script l`], ["\\hbar", "ℏ", msg`H-bar / reduced Planck`], ["\\imath", "ı", msg`Dotless i`],
    ["\\jmath", "ȷ", msg`Dotless j`], ["\\wp", "℘", msg`Weierstrass p`], ["\\Re", "ℜ", msg`Real part`],
    ["\\Im", "ℑ", msg`Imaginary part`], ["\\aleph", "ℵ", msg`Aleph`], ["\\beth", "ℶ", msg`Beth`],
    ["\\gimel", "ℷ", msg`Gimel`], ["\\daleth", "ℸ", msg`Daleth`], ["\\prime", "′", msg`Prime`],
    ["\\backprime", "‵", msg`Back prime`], ["\\%", "%", msg`Percent`], ["\\&", "&", msg`Ampersand`],
    ["\\_", "_", msg`Underscore`], ["\\S", "§", msg`Section sign`], ["\\P", "¶", msg`Pilcrow / paragraph`],
    ["\\dag", "†", msg`Dagger text symbol`], ["\\ddag", "‡", msg`Double dagger text symbol`],
    ["\\copyright", "©", msg`Copyright`], ["\\pounds", "£", msg`Pounds sterling`],
  ],
};

const codeSnippets = (group: InsertGroup, rows: CodeRow[]): InsertSnippet[] =>
  rows.map(([id, label, detail, insert, cursorOffset]) => ({
    id, group, label, detail, insert, cursorOffset,
    codePreview: insert.trim().split("\n").slice(0, 3).join("\n"),
  }));

export const INSERT_SNIPPETS: InsertSnippet[] = [
  /* eslint-disable lingui/no-unlocalized-strings -- group keys; the palette's useGroupLabels translates them */
  ...codeSnippets("Environment", ENVIRONMENTS),
  ...codeSnippets("Structure", STRUCTURES),
  /* eslint-enable lingui/no-unlocalized-strings */
  ...MATH.map(([id, label, detail, insert, cursorOffset, mathPreview]): InsertSnippet => ({
    id, group: "Math", label, detail, insert, cursorOffset, mathPreview,
  })),
  ...INSERT_SYMBOL_GROUPS.flatMap((group) => SYMBOLS[group].map(([insert, glyph, detail, preview]): InsertSnippet => ({
    id: `${group.toLowerCase()}-${insert.replace(/\\/g, "")}`,
    group,
    label: insert,
    detail,
    insert,
    // Accent commands take an argument: land inside the empty braces.
    cursorOffset: insert.endsWith("{}") ? insert.length - 1 : undefined,
    glyph,
    mathPreview: preview ?? insert,
  }))),
];
