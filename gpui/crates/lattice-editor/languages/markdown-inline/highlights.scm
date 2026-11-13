; Markdown's inline text, styled as the Tauri app's Markdown source mode
; styles it (see ../markdown/highlights.scm for the capture names): emphasis
; in italic, strong at 700, code spans in the string colour, links and
; autolinks in the special-variable colour, and their marks in the keyword
; colour.

(emphasis) @emphasis
(strong_emphasis) @emphasis.strong

(code_span) @markup.raw

[
  (inline_link)
  (full_reference_link)
  (collapsed_reference_link)
  (shortcut_link)
  (image)
  (uri_autolink)
  (email_autolink)
] @markup.link

[
  (emphasis_delimiter)
  (code_span_delimiter)
] @markup.meta

(inline_link ["[" "]" "(" ")"] @markup.meta)
(image ["!" "[" "]" "(" ")"] @markup.meta)
(shortcut_link ["[" "]"] @markup.meta)
(full_reference_link ["[" "]"] @markup.meta)
