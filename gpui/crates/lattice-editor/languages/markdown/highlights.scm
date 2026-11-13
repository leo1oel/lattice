; Markdown's block structure, styled as the Tauri app's Markdown source mode
; styles it (`markdownHighlightStyle` in src/editor/editor-languages.ts, over
; @lezer/markdown's tags). The capture names are lattice-ui's editor theme
; keys (`editor_theme::syntax`):
;
;   markup.heading    a heading, and a table's header row: the function colour at 600
;   markup.meta       syntax marks (`#`, `>`, list markers, fences, `|`): the keyword colour
;   markup.raw        code: the string colour
;   markup.link       a link's destination: the special-variable colour
;   markup.quote      a block quote: the documentation-comment colour, in italic
;   markup.separator  a thematic break: the bracket colour
;
; Inline text (emphasis, code spans, links) is the inline grammar's, injected
; per run (`injections.scm`, `../markdown-inline/highlights.scm`). Front
; matter stays in the ink: lezer reads its `---` lines as a rule and a
; heading, which the app never meant.

(atx_heading) @markup.heading
(setext_heading) @markup.heading
(pipe_table_header) @markup.heading

[
  (atx_h1_marker)
  (atx_h2_marker)
  (atx_h3_marker)
  (atx_h4_marker)
  (atx_h5_marker)
  (atx_h6_marker)
  (setext_h1_underline)
  (setext_h2_underline)
  (block_quote_marker)
  (list_marker_plus)
  (list_marker_minus)
  (list_marker_star)
  (list_marker_dot)
  (list_marker_parenthesis)
  (task_list_marker_checked)
  (task_list_marker_unchecked)
  (fenced_code_block_delimiter)
  (pipe_table_delimiter_row)
] @markup.meta

(pipe_table_header "|" @markup.meta)
(pipe_table_row "|" @markup.meta)

(block_quote) @markup.quote

(thematic_break) @markup.separator

[
  (code_fence_content)
  (indented_code_block)
  (link_title)
] @markup.raw

(link_destination) @markup.link
