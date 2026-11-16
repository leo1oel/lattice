; JavaScript as @codemirror/lang-javascript tags it, in the code theme's
; names: keywords keywords, a variable a variable, a function where it is
; declared or called a function, a property a property, a class name a type,
; strings and numbers theirs (booleans as numbers), comments comments.

(identifier) @variable

(property_identifier) @property

(shorthand_property_identifier) @property

(function_declaration
  name: (identifier) @function)

(call_expression
  function: (identifier) @function)

(class_declaration
  name: (identifier) @type)

[
  (string)
  (template_string)
] @string

(number) @number

[
  (true)
  (false)
] @number

(comment) @comment

[
  "as"
  "async"
  "await"
  "break"
  "case"
  "catch"
  "class"
  "const"
  "continue"
  "debugger"
  "default"
  "delete"
  "do"
  "else"
  "export"
  "extends"
  "finally"
  "for"
  "from"
  "function"
  "get"
  "if"
  "import"
  "in"
  "instanceof"
  "let"
  "new"
  "of"
  "return"
  "set"
  "static"
  "switch"
  "throw"
  "try"
  "typeof"
  "var"
  "void"
  "while"
  "with"
  "yield"
] @keyword

[
  "+"
  "-"
  "*"
  "/"
  "%"
  "="
  "=="
  "==="
  "!="
  "!=="
  "<"
  ">"
  "<="
  ">="
  "&&"
  "||"
  "!"
  "+="
  "-="
  "++"
  "--"
  "??"
] @operator

[
  "{"
  "}"
  "("
  ")"
  "["
  "]"
] @punctuation.bracket
