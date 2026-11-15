# Finding things in the project

One of the features [the GPUI app](../README.md) has so far.

Finds things in the project as the Tauri app does: quick open (⌘P) lists the files visited this session first and ranks a typed name, `:42` goes to a line of the file on screen and `@` to a section or label; Go to line (⌘G) goes to a typed line of the file on screen, and Go to symbol (⌘⇧O) to one of the manuscript's sections or the project's labels, read from the unsaved buffer; Find in project (⌘⇧F) searches the project's files and its papers library, the hits gathered under each file, F3 stepping through them; ⌘[ and ⌘] go back and forward over the places visited; Replace in project (⌘⇧H) previews every match, then rewrites them through lattice-core, which records the replacement in the project's history.

## Find in the open file

⌘F / Ctrl+F in a source (a `.tex`, Markdown, `.bib` or other text file) opens the Tauri app's find panel above the text (`editor_panel/find_bar.rs`, the port of CodeMirror's search panel as `compactSearchPanel` and `.cm-panel.cm-search` have it).
Its query is seeded from a selection of up to 100 characters and selected whole; every match is marked as the query is typed, the one the selection is in the current match's colour, and the counter beside the field reads `current/total`.
Enter, ↓ and F3 select the next match, Shift+Enter, ↑, Shift+F3 and ⌘⇧G the previous, round the ends of the file and centred in the view; Select all makes every match a selection.
Aa, .* and W are Match case, Regular expression and Whole word; outside a regular expression `\n`, `\t` and `\\` in the query or the replacement read as the characters, as CodeMirror reads them, and a regular expression's replacement takes `$1` and `$&`.
Replace (or Enter in the replacement) replaces the selected match and selects the next, Replace all replaces every match as one undoable edit, and Escape or × closes the panel and gives the keys back to the text; F3 with the panel closed goes on with the last query.
From 520px wide its two rows share one grid, as the panel's container query has them; narrower, each row wraps within itself, the query field kept at least 120px wide.

In the e2e scenario (`scenario/e2e/find_in_file.rs`) native ⌘F opens the panel with its query focused, the typed query finds every match of a scratch file with the counter following, Enter, Shift+Enter, F3, Shift+F3 and ⌘⇧G step round the file, the three toggles narrow the matches, Replace and Replace all rewrite the text with a regular expression's group, and native Escape closes the panel and gives the keys back to the text.
The parity harness's `find` screen (`LATTICE_PARITY_SCREEN=find`, `scenario/parity_find.rs`) compares the panel, open on the tutorial's `main.tex` with "attention" found, with the Tauri app's.
