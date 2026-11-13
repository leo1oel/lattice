; LaTeX highlighting for the latex-lsp tree-sitter grammar
; (codebook-tree-sitter-latex), with the token roles of Lattice's own LaTeX
; mode (src/editor/latex/latex-language.ts) as capture names, which
; lattice-ui's code themes colour:
;
;   keyword      a command, at medium weight
;   function     sectioning and the title block (\section, \title, \author)
;   type         an environment's name
;   variable     maths
;   string       a path or URL argument
;   label        a label or cross-reference and its keys
;   citation     a citation and its keys
;   operator     a control symbol (`\,`, `\%`); the grammar reads `&` and `~`
;                as part of the words around them, so those stay in the ink
;
; Structural commands Lattice draws as plain text, like the prose around them
; (\item, \caption, \maketitle, \newcommand, \includegraphics, ...), take no
; capture. Arguments stay in the ink unless a rule below names them: a
; package's options and key=value keys too, as the app's mode leaves them.

[
  (line_comment)
  (block_comment)
  (comment_environment)
] @comment

; Every other command, except the plain ones.
((command_name) @keyword
  (#not-any-of? @keyword
    "\\centering" "\\hline" "\\toprule" "\\midrule" "\\bottomrule" "\\multicolumn"
    "\\parbox" "\\setlength" "\\footnote" "\\endnote" "\\def" "\\let" "\\newtheorem"
    "\\theoremstyle" "\\textcolor" "\\colorbox" "\\hbox" "\\verb" "\\lstinline"
    "\\affil" "\\affiliation" "\\maketitle" "\\textsf" "\\textmd" "\\textrm"
    "\\textsuperscript" "\\textsubscript" "\\sout" "\\nameref" "\\newline"
    "\\noindent" "\\left" "\\right" "\\text"
    "\\date" "\\book")
  ; A control symbol (`\\`, `\,`, `\%`) is not a command word: see below.
  (#match? @keyword "^\\\\[A-Za-z@]"))

; Control symbols are operators (`\,`, `\%`, `\&`), except `\\`, a plain
; line break, which stays in the ink (latex-language.ts's `refineStyle`).
((command_name) @operator
  (#match? @operator "^\\\\[^A-Za-z@\\\\]"))

; Headings and the title block.
((command_name) @function
  (#any-of? @function "\\date" "\\book"))
(part command: _ @function)
(chapter command: _ @function)
(section command: _ @function)
(subsection command: _ @function)
(subsubsection command: _ @function)
(paragraph command: _ @function)
(subparagraph command: _ @function)
(title_declaration command: _ @function)
(author_declaration command: _ @function)
(bibtex_include command: _ @function)
(bibstyle_include command: _ @function)

; The document class, packages and environments.
(class_include command: _ @keyword)
(package_include command: _ @keyword)
(begin command: _ @keyword name: (curly_group_text (text) @type))
(end command: _ @keyword name: (curly_group_text (text) @type))

; Maths.
[
  (inline_formula)
  (displayed_equation)
] @variable
(math_environment
  begin: (begin name: (curly_group_text (text) @type)))

; Cross references and citations: the command and its keys read as one thing.
(label_definition command: _ @label name: (curly_group_label (label) @label))
(label_reference command: _ @label names: (curly_group_label_list (label) @label))
(citation command: _ @citation keys: (curly_group_text_list) @citation)

; Paths and URLs.
(latex_include path: (curly_group_path (path) @string))
(graphics_include path: (curly_group_path (path) @string))
(hyperlink uri: (curly_group_uri (uri) @string))

[
  "{"
  "}"
  "["
  "]"
] @punctuation.bracket
