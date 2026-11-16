; A <script>'s text is JavaScript and a <style>'s CSS, as lang-html nests
; @codemirror/lang-javascript and lang-css in them.
((script_element
  (raw_text) @injection.content)
  (#set! injection.language "javascript"))

((style_element
  (raw_text) @injection.content)
  (#set! injection.language "css"))
