# Selection toolbar and highlights

One of the features [the GPUI app](../README.md) has so far.

Selecting text in the source editor shows the Tauri app's selection toolbar over it, centred on the selection's first line (under it when that line is near the editor's top), and it grows in from the selection.
It waits while the pointer is still dragging the selection out, goes on a press outside it or Esc, and stays gone until the selection changes.
Pressing its buttons never takes the editor's focus or selection.

Over a LaTeX selection it has Bold, Italic, Underline, Strikethrough and Quote, each pressed when the selection already has that format, and pressing a pressed one takes the format off.
Then come Annotate, which opens the [annotation](annotations.md) composer on the selection, the agent's [Proofread, Polish and Rewrite](proofread.md), Link, whose URL field writes `\href`, the heading level menu, and the highlighter.
The pen applies the last highlighter at once, and its caret opens the highlighter palette.

Over a Markdown selection it has the block type menu (text, six heading levels, bulleted, numbered and task lists, quote and code block), then Bold, Italic, Underline, Strikethrough, inline code and Highlight written in Markdown's syntax, Insert link, inline math and Annotate.
Inside a fenced code block it has only the block menu and Annotate.

The highlighter palette offers six highlighters by what they mean, each drawn as "Aa" on its tint, applied with a click or its digit key.
Each meaning can be renamed where it sits, the pen's colour is marked, and the writer's own colours follow, then "+" for a custom colour.
The custom colour view offers the colours the document already uses, the writer's own colours, the paper tones and a hex field, and it says when a colour is too dark for black text.
Inside a highlight, Remove highlight takes it off.
The meanings, the pen's colour and the custom colours belong to the writer, not to a project, and are kept in `highlighters.json` in the app's state folder.

A highlight is written as `\colorbox[HTML]{…}{…}`, and the editor paints its passage in its colour, with the wrapper receding, as the Tauri app's source does.
Only `#RRGGBB` highlights are painted; a hand-typed `\colorbox{yellow}{…}` or soul's `\hl{…}` keeps the source's own colours.
In the light theme the passage takes the highlight's tint under dark ink; in the dark theme it takes an 18% wash of the colour with a 2px underline at 75%, since a pastel block would put light ink on a light ground.
The paint reads only the lines in view and 2,000 characters either side, as the Tauri app's does, and reads again once the lines in view go past them, whether the view scrolled, grew or folded.

## In the e2e scenario

Selection toolbar (`scenario/e2e/selection_toolbar.rs`): a word of the chapter selected shows the LaTeX toolbar; Bold wraps it in `\textbf` and shows pressed, and Bold again takes it off; the pen highlights it in the yellow highlighter, which the editor paints, and Remove highlight takes it off; then a Markdown selection shows the Markdown toolbar, whose Bold writes `**…**` and whose block menu makes the line a heading.
