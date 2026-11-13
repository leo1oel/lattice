; Each run of inline text goes to the inline grammar; a fenced block names
; its own language (LaTeX is the one the app has, as `latex` or `tex`).
((inline) @injection.content
  (#set! injection.language "markdown-inline"))

(fenced_code_block
  (info_string
    (language) @injection.language)
  (code_fence_content) @injection.content)
