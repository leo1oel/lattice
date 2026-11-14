# The Terminal panel

One of the features [the GPUI app](../README.md) has so far.

Has the Tauri app's Terminal panel, on Zed's alacritty-based terminal (`src/terminal.rs` and `crates/lattice-gpui/src/terminal/`): ⌃` (the Panels menu, View ▸ Terminal or the palette) opens it across the foot of the whole workspace with the writer's login shell in the project folder, started with Lattice's environment (lattice-core's `shell_launch`: TeX on the search path, `TERM_PROGRAM=Lattice`), and hides it again with its shells running.
The screen is drawn as the Tauri app's xterm.js draws it: the code theme's ground, ink, caret and selection, the ANSI colours from the design system's status and file-glyph colours, a program's colours lifted to 4.5:1, the editor's face at 12px, a blinking 1px caret, Lattice's scrollbar, the input method's composition at the caret, ⌘-click on a link.
New terminal (the strip's +, its ⋯ menu) opens another as a tab, renamed by a double-click; ⌘F finds in the scrollback; ⌘W closes the tab in front, and a tab, the panel or a switch to another project asks first while a command still runs there. A shell that exits cleanly takes its tab with it, the last one the panel; any other exit says how it ended.

## In the e2e scenario

On macOS the scenario checks the Terminal panel (`scenario/e2e/terminal/`, `terminal_focus.rs`; Windows' PowerShell is checked by hand): ⌃` opening it with the login shell in the project folder naming Lattice, native keys typed into the shell, a program's colours, ⌘F in the scrollback, a second terminal's tab strip and a rename, ⌘W asking first over a running command, the shells kept while it is hidden, where the keyboard goes as it hides, a shell starts or exits on its own, or a tab's rename (a name with a space, typed with Vim's keymap loaded) is left for the document, Space on a tab selecting it at once after Vim is turned off, an unfocused caret kept still when the shell asks for a blinking one, a failed shell saying how it ended, the last clean exit closing the panel, and closing the panel ending its shells; with `LATTICE_TERMINAL_SHOTS=DIR` it saves the window at several of them.
