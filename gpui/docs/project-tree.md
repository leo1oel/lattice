# The Project tree

One of the features [the GPUI app](../README.md) has so far.

Opens a project folder as the Tauri app does (a folder Lattice did not create is adopted the same way), with the Project tree on the left: the same files shown and hidden, a chain of single folders flattened into one row, New file, New folder, Import files… (names the folder already has asked about once, Keep both, Replace or Skip), Rename, a dragged row moved into a folder, ⌘C / ⌘V duplicating a row (⌘V with an image on the clipboard instead, or a folder's Paste clipboard image as figure, saving it into that folder as `clipboard-<time>.png` (a JPEG or WebP keeping its own extension), into `figures/` from the project root), Delete (of any file but the primary bibliography, where it says why), Set as main document, Show hidden files, and each changed file's Git status (its colour and letter, a dot on the folders above it).

Rows are selected as the Tauri app's are.
A click selects one row, ⌘-click adds or removes a row, ⇧-click takes the rows shown from the last one clicked, and the arrow keys move a lone selection row by row.
A drag, Delete ("Delete 2 selected items from this project?") and ⌘C ("2 paths copied") take the whole selection when the row is in it, a row inside a selected folder going with its folder.
Enter names the one selected row anew, as Rename does.
Opening a file selects its row alone, opens its folders down to it and brings it into view, and what an import brings in is selected the same way.
Which folders are open is kept for each project, and Show hidden files for all of them, across runs, in `project-tree.json` in the app's state folder; until it is on, a template's `.sty` and `.bst` files stay out of the tree as well.

A letter or digit typed in the tree opens a filter field over the rows, seeded with it, as the Tauri app's tree does.
Only the rows whose project-relative path holds the query (any case) and the folders on the way show, opened; nothing matching leaves the tree empty.
↑ and ↓ move among the matches, Enter picks one as a click does, and Escape, a click on a row, a rename or focus leaving the tree closes it, with the folders that were open before back and the picked row's folders opened.
While the query holds text a row cannot be dragged.
An open folder scrolled past stays pinned at the top, one under another down the open folders, pushed up as its last row goes; a click on a pinned folder closes it and brings its row back under the top.
A folder opening or closing moves for 160 ms: its chevron sweeps a quarter turn, the rows below slide, and the rows it shows are uncovered top-down, or the rows it hid wiped bottom-up; a scroll, a key or a press ends it, and with reduced motion nothing moves.

Files dragged in from Finder land in the folder under the pointer (the project root off the rows), as Import files… brings them in; a row dragged onto a folder moves into it.
Either way the whole folder is lit while it is aimed at: its row, ringed and raised, and the rows shown inside it, or the whole tree, washed, for the project root.
A file's row dragged out of the Project panel becomes its own tab, carried by the layout's drag, and lands where the layout's drop targets say: beside a panel's edge, in a seam, on a tab strip or in a panel; let go nowhere, or back over the Project panel, it closes again.
Finder files dropped on a document open there: sources (documents, code and config files) are copied into the project root and open, figures are copied into `figures/` and open in their preview (over a LaTeX or Markdown editor, they go in as figures instead; see [Figures and tables](figures-and-tables.md)); a mix of both, or a file no editor opens, says what to drop instead.

## In the e2e scenario

Drops (`scenario/e2e/drops.rs`), with the platform's own file-drop and pointer events: a Finder drop on a folder's row right after typing, lit and landing there; a drag off the rows aiming at the project root; a split divider's drag after a Finder drag left lighting no folder and no editor; a Finder figure dropped on a LaTeX editor's second line going in there; a figure's row from the tree drawing the drop caret over the editor; a Finder source opening; a mix refused; and a file's row dragged out of the Project panel landing in the documents, and one let go before the layout takes it closing again at the next move.

Selection (`scenario/e2e/tree_selection.rs`), with the platform's own pointer and key events: opening a file in a closed folder revealing and selecting it; ⌘-click and ⇧-click; ⌘C of several paths; Enter renaming only a lone selected row; Delete asking about two rows at once; a `.sty` hidden until Show hidden files; the project shown again keeping its open folders; a row reached with ↓ staying the selection after a rescan; switching to another project and back keeping each one's open folders; a move of two rows that fails part-way still moving the tab of the one that went; and a Finder drop's file selected.

Filter, sticky folders and motion (`scenario/e2e/tree_view.rs`), with the platform's own key, pointer and wheel events: a letter typed opening the filter seeded with it, a query leaving only its file and folder, and one matching nothing leaving the tree empty; ↓ and Enter picking the second match and opening it, the field closing with its folder open; Escape bringing every row back, with a folder only the search opened closed again on screen and in `project-tree.json`; a pointer click on a filtered row picking exactly that row and closing the field; a folder scrolled past staying pinned at the top, and a click on it closing it and scrolling its row back; and a folder opening moving for the moderate tier, where reduced motion moves nothing.
