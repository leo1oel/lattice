# The Project tree

One of the features [the GPUI app](../README.md) has so far.

Opens a project folder as the Tauri app does (a folder Lattice did not create is adopted the same way), with the Project tree on the left: the same files shown and hidden, a chain of single folders flattened into one row, New file, New folder, Import files… (names the folder already has asked about once, Keep both, Replace or Skip), Rename, a dragged row moved into a folder, ⌘C / ⌘V duplicating a row (⌘V with an image on the clipboard instead, or a folder's Paste clipboard image as figure, saving it into that folder as `clipboard-<time>.png` (a JPEG or WebP keeping its own extension), into `figures/` from the project root), Delete (of any file but the primary bibliography, where it says why), Set as main document, Show hidden files, and each changed file's Git status (its colour and letter, a dot on the folders above it).

Files dragged in from Finder land in the folder under the pointer (the project root off the rows), as Import files… brings them in; a row dragged onto a folder moves into it.
Either way the whole folder is lit while it is aimed at: its row, ringed and raised, and the rows shown inside it, or the whole tree, washed, for the project root.
A file's row dragged out of the Project panel becomes its own tab, carried by the layout's drag, and lands where the layout's drop targets say: beside a panel's edge, in a seam, on a tab strip or in a panel; let go nowhere, or back over the Project panel, it closes again.
Finder files dropped on a document open there: sources (documents, code and config files) are copied into the project root and open, figures are copied into `figures/` and open in their preview (over a LaTeX or Markdown editor, they go in as figures instead; see [Figures and tables](figures-and-tables.md)); a mix of both, or a file no editor opens, says what to drop instead.

## In the e2e scenario

Drops (`scenario/e2e/drops.rs`), with the platform's own file-drop and pointer events: a Finder drop on a folder's row right after typing, lit and landing there; a drag off the rows aiming at the project root; a split divider's drag after a Finder drag left lighting no folder and no editor; a Finder figure dropped on a LaTeX editor's second line going in there; a figure's row from the tree drawing the drop caret over the editor; a Finder source opening; a mix refused; and a file's row dragged out of the Project panel landing in the documents, and one let go before the layout takes it closing again at the next move.
