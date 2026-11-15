# Not yet

What the Tauri app has that the GPUI app does not port yet, one item per line.
A feature that lands deletes its own line (only that line, so features landing side by side merge cleanly), and a gap found adds one.

- [ ] Overleaf's tracked changes in the visual LaTeX editor (their marks, cards and margin review items).

- [ ] Wrapping a selection in an environment and renaming an environment (⌘⇧E, ⌘⌥R) in the Visual editor.

- [ ] Ctrl-M's jump to the matching math delimiter (`matchingMathDelimiter`) where no environment encloses the caret.

- [ ] The LaTeX source's typing rules: `$` pairing, `\begin` closed by its `\end`, `\item` continued, `\left` closed by `\right`.

- [ ] Margin review's J/K walk between items.

- [ ] Overlay exit motion for the menus and popovers GPUI Kit's popover opens, and for a dialog closed by a button of its own.

- [ ] The editor's change wash on lines an outside edit landed (`lattice_ui::attention` has its timing).

- [ ] The Agent: its annotation tools, recording proposals and questions from the conversation into the open round.

- [ ] The Revision rounds sheet, comparing a round's versions (and the round saved toast's Compare).

- [ ] The Annotations panel's Export review PDF….

- [ ] The PDF: its annotations.

- [ ] The PDF: its comment column.

- [ ] The PDF: its review export.

- [ ] The PDF: its citation hover cards.

- [ ] Settings: the sections' product icons' hover gestures (they rest as the Tauri app's resting frames).

- [ ] Settings: Editor & builds › Your name saying which Git or Overleaf name signs comments ahead of it.

- [ ] Settings: App updates' automatic updates and Check for updates (the GPUI app shows its version and GitHub Releases).

- [ ] The paper reader's selection actions: Copy source link and Add to note, on the full text and on the original PDF.

- [ ] The shortcut sheet's Check references group (the review queue has no keys yet), and the LaTeX keys the source editor does not bind yet (the citation card, the symbol palette, Proofread), which join the sheet's LaTeX group once bound.

- [ ] The app updater's release channel (it ships off) and the outdated-version hint on a failure's notice.

- [ ] Overleaf: the live channel joining again when the network comes back (it does when the window comes forward).

- [ ] Overleaf: Review changes' "Could not render these changes" state.

- [ ] Overleaf: the "Opening the Overleaf project…" transition when a downloaded project opens.

- [ ] Overleaf: a compile after a resolved conflict (the watcher's build stands in).

- [ ] The visual Markdown editor: Overleaf's tracked changes painted in it.

- [ ] A Finder drop of a drawing (`.svg`, `.drawio`) onto the editor as an editable figure.

- [ ] A paper dragged from Papers into the editor as a citation.

- [ ] The Project tree's type-to-filter, sticky folders and expand motion.

- [ ] The Project panel's + and ⋯ menus' New spreadsheet, New board and New presentation, and Find in project.

- [ ] Preview tabs, pinned tabs and tab eviction.

- [ ] The workspace switch's sliding plate, drag to reorder and keyboard.

- [ ] Export figures for a journal….

- [ ] New project's My templates and Save a local template….

- [ ] Each file's editor and PDF place kept across launches.

- [ ] The palette's New LaTeX file, New Markdown file, New spreadsheet, New board and New presentation (the Project panel cannot make a typed file yet).

- [ ] Papers' hover prewarm of a paper the pointer is likely to open.

- [ ] Papers' notice when the browser could not open an article (GPUI's opener reports no failure).
