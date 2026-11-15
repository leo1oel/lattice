# Not yet

What the Tauri app has that the GPUI app does not port yet, one item per line.
A feature that lands deletes its own line (only that line, so features landing side by side merge cleanly), and a gap found adds one.

- [ ] The visual LaTeX editor, in part: margin review and Overleaf's tracked changes in Visual.

- [ ] Wrapping a selection in an environment and renaming an environment (⌘⇧E, and in the source editor too).

- [ ] The LaTeX source's typing rules: `$` pairing, `\begin` closed by its `\end`, `\item` continued, `\left` closed by `\right`.

- [ ] Margin review's J/K walk between items.

- [ ] Overlay exit motion for the menus and popovers GPUI Kit's popover opens, and for a dialog closed by a button of its own.

- [ ] The 13 animated product icons.

- [ ] The editor's change wash on lines an outside edit landed, and an accepted suggestion's strike, fold and settle (`lattice_ui::attention` has their timing).

- [ ] The minor motions.

- [ ] The Agent: a Papers selection in its context.

- [ ] The Agent: reviewing the proposals its annotation tools record.

- [ ] The accepted proofread's old words folding their width away (they leave at once).

- [ ] The highlight's colour swatch before `\colorbox` in the source.

- [ ] The custom highlight colour's two-dimensional picker (the hex field and the offered colours stand in).

- [ ] The PDF: its annotations.

- [ ] The PDF: its comment column.

- [ ] The PDF: its review export.

- [ ] The PDF: its citation hover cards.

- [ ] Settings: the sections' product icons' hover gestures (they rest as the Tauri app's resting frames).

- [ ] Settings: Editor & builds › Your name saying which Git or Overleaf name signs comments ahead of it.

- [ ] Settings: App updates' automatic updates and Check for updates (the GPUI app shows its version and GitHub Releases).

- [ ] The paper reader's selection actions: Copy source link and Add to note, on the full text and on the original PDF.

- [ ] The shortcut sheet's Check references group (the review queue has no keys yet), and the LaTeX keys the source editor does not bind yet (inline math, the wrap, rename and select environment keys, sorting and case, the citation card, the symbol palette, Proofread), which join the sheet's LaTeX group once bound.

- [ ] The app updater's release channel (it ships off) and the outdated-version hint on a failure's notice.

- [ ] File › Export ZIP….

- [ ] Overleaf: the live channel joining again when the network comes back (it does when the window comes forward).

- [ ] Overleaf: the titlebar control's animated cloud-upload icon (the icon is still).

- [ ] Overleaf: Review changes' "Could not render these changes" state.

- [ ] Overleaf: the "Opening the Overleaf project…" transition when a downloaded project opens.

- [ ] Overleaf: a compile after a resolved conflict (the watcher's build stands in).

- [ ] The visual Markdown editor: Overleaf's tracked changes painted in it.

- [ ] A Finder drop onto the Agent panel attaching its files (the drop hook is `shell/drops.rs`'s `agent_drop_target`).

- [ ] A Finder drop of a drawing (`.svg`, `.drawio`) onto the editor as an editable figure.

- [ ] A paper dragged from Papers into the editor as a citation.

- [ ] The Project tree's multi-select, type-to-filter, sticky folders and expand motion.

- [ ] The Project tree's expanded folders and Show hidden files kept per project.

- [ ] The Project tree revealing and selecting what an import brought in.

- [ ] The Project panel's + and ⋯ menus' New spreadsheet, New board and New presentation, and Find in project.

- [ ] Preview tabs, pinned tabs and tab eviction.

- [ ] The workspace switch's sliding plate, drag to reorder and keyboard.

- [ ] Export ZIP and Export for arXiv… in the project and File menus, and Export figures for a journal….

- [ ] New project's My templates and Save a local template….

- [ ] Each file's editor and PDF place kept across launches.
