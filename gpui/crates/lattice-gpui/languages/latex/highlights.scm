; LaTeX highlighting for the latex-lsp tree-sitter grammar
; (codebook-tree-sitter-latex), written for Zed's theme capture names.

[
  (line_comment)
  (block_comment)
  (comment_environment)
] @comment

(command_name) @function

; Sectioning: the command, then the heading text.
(part command: _ @keyword text: (curly_group) @title)
(chapter command: _ @keyword text: (curly_group) @title)
(section command: _ @keyword text: (curly_group) @title)
(subsection command: _ @keyword text: (curly_group) @title)
(subsubsection command: _ @keyword text: (curly_group) @title)
(paragraph command: _ @keyword text: (curly_group) @title)
(subparagraph command: _ @keyword text: (curly_group) @title)

; Environments.
(begin command: _ @keyword name: (curly_group_text (text) @type))
(end command: _ @keyword name: (curly_group_text (text) @type))

; Math.
[
  (inline_formula)
  (displayed_equation)
] @string.special
(math_environment
  begin: (begin name: (curly_group_text (text) @type)))

; Cross references and citations.
(label_definition command: _ @keyword name: (curly_group_label (label) @label))
(label_reference command: _ @keyword names: (curly_group_label_list (label) @label))
(citation command: _ @keyword keys: (curly_group_text_list) @label)

; Includes and definitions.
(class_include command: _ @keyword path: (curly_group_path (path) @string))
(package_include command: _ @keyword paths: (curly_group_path_list (path) @string))
(latex_include command: _ @keyword path: (curly_group_path (path) @string))
(graphics_include command: _ @keyword path: (curly_group_path (path) @string))
(new_command_definition command: _ @keyword)
(environment_definition command: _ @keyword)

(enum_item command: _ @keyword)
(key_value_pair key: (text) @property)
(caption command: _ @keyword)

[
  "{"
  "}"
  "["
  "]"
] @punctuation.bracket
