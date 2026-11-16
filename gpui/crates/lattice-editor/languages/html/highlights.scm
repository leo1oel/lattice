; HTML as @codemirror/lang-html tags it, in the code theme's names: a tag
; name is a type (lezer's tagName), an attribute's name an attribute and its
; value a string with its quotes, a comment a comment, the doctype the
; theme's doc comment (documentMeta), the angle brackets brackets.

[
  (tag_name)
  (erroneous_end_tag_name)
] @type

(attribute_name) @attribute

[
  (attribute_value)
  (quoted_attribute_value)
] @string

(comment) @comment

(doctype) @comment.doc

[
  "<"
  ">"
  "</"
  "/>"
] @punctuation.bracket
