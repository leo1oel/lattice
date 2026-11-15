; CSS as @codemirror/lang-css tags it, in the code theme's names: a type or
; class selector is a type, an id a label, a pseudo-class a constant, a
; property a property (a custom one a variable), an at-rule and `!important`
; keywords, numbers numbers, strings strings, operators and brackets theirs.

(comment) @comment

[
  (tag_name)
  (class_name)
] @type

(id_name) @label

(keyframes_name) @label

(pseudo_class_selector
  (class_name) @constant)

(pseudo_element_selector
  (tag_name) @constant)

[
  (property_name)
  (feature_name)
] @property

((property_name) @variable
  (#match? @variable "^--"))

((plain_value) @variable
  (#match? @variable "^--"))

(attribute_name) @attribute

[
  (integer_value)
  (float_value)
] @number

(string_value) @string

[
  (at_keyword)
  (to)
  (from)
  (important)
  "@media"
  "@import"
  "@charset"
  "@namespace"
  "@supports"
  "@keyframes"
  "not"
  "only"
] @keyword

[
  "~"
  ">"
  "+"
  "-"
  "*"
  "/"
  "="
  "^="
  "|="
  "~="
  "$="
  "*="
  "and"
  "or"
  (nesting_selector)
  (universal_selector)
] @operator

[
  "{"
  "}"
  "("
  ")"
  "["
  "]"
] @punctuation.bracket
