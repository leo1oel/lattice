; BibTeX as the Tauri app's codemirror-lang-bib tags it (`styleTags` in its
; bibtex parser), in the code theme's names: the entry type (`@article`, and
; `@string`, `@preamble`, `@comment`) is a keyword, a field's or a string's
; name a property, a reference to a string a variable, a braced or quoted
; value a string with its delimiters, a number a number, `#` an operator.
; The citation key and the text between entries stay in the ink.

[
  (entry_type)
  (string_type)
  (preamble_type)
  (comment)
] @keyword

(field
  name: (identifier) @property)

(string
  name: (identifier) @property)

(token
  (identifier) @variable)

[
  (brace_word)
  (quote_word)
] @string

(token
  [
    "{"
    "}"
    "\""
  ] @string)

(number) @number

"#" @operator
