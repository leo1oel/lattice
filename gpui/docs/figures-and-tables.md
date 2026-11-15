# Figures and tables

One of the features [the GPUI app](../README.md) has so far.

Inserts figures and tables as the Tauri app does.
Insert table (the palette, in a LaTeX file) opens the table generator over the window: data pasted as CSV or TSV (auto-detected, or chosen) replaces the grid; rows, columns, decimal places, booktabs rules and a `table` float with its caption and label are set beside it; each column's alignment heads it and each cell is plain text, escaped for LaTeX, or LaTeX as written.
Review source changes shows the diff before Insert table writes it at the caret on a line of its own.
The table it writes is managed: its grid rides above it as a `% lattice-table-v1` comment, byte for byte the Tauri app's, so the caret in it opens it again to Update table; a table edited by hand, or a hand-written one, is left to the source editor, and an edit made while the generator is open refuses its write.
A figure goes in at the start of the line under the pointer when it is dropped: a figure or other binary file's row dragged from the Project tree onto the editor (a text file's row inserts nothing), which lights the editor and draws the drop caret where the pointer is, or figures dragged in from Finder, which are copied into `figures/` first.
⌘V with an image (and no text) on the clipboard, or the palette's Paste clipboard image as figure (which saves the image into `figures/` first), puts one at the start of the caret's line.
In a LaTeX file, lattice-core prepares it (an SVG as PDF, a WebP as PNG) and Insert figure asks its width, placement, caption and label; in a Markdown file it goes in at once as an image linked from the file.

## In the e2e scenario

Inserting tables and figures (`scenario/e2e/insert.rs`): Insert table opening the generator on a chapter, a 2 by 2 table reviewed and written as a managed table on a line of its own, the caret in it opening it again to edit, an edit made meanwhile refusing the write, a table edited by hand left to the source editor; a project image inserted through Insert figure; and ⌘V with an image in the editor saving it into `figures/` and offering it as a figure.
With `LATTICE_E2E_SHOTS=DIR` and the `offscreen-shots` feature it saves the window at the generator, its review, its refusal and unsupported messages, the Insert figure dialog and the pasted figure.
