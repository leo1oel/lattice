# Commands, windows and project tabs

One of the features [the GPUI app](../README.md) has so far.

Reaches every command from the command palette (⌘K), the keymap, the shortcut sheet (⌘?) and the menu bar; opens projects in new windows or as tabs in one, from the title bar's project menu (the recent projects, each in a window of its own or in this one), File ▸ Open Recent or the palette.

The palette lists what the Tauri app's does.
An empty query leads with the last three commands run from it (Recent, kept between launches; Clean rebuild, Clean aux files, Stop build, Reset panel layout, Revert to saved and the recent projects never among them), then the commands for the document in front ("In this document": Build project and Jump to PDF for a LaTeX source; Find in project and Quick open for Markdown; "In this paper" for a paper's reader), then four files opened recently, the one in front left out, then every command by section.
A typed query ranks the commands, the project's files, its Papers (title, authors and year) and every Settings row together; a Paper opens as its row in Papers does, a setting opens Settings at its row, and a query that finds nothing offers "Search the project for …", which opens Find in project on it.
A row shows its detail at its end: a recent project's folder, What's new's version.
The labels are the Tauri table's, in the interface language: Jump to PDF (from a LaTeX source only), Switch to the Writing, Reading or Bibliography layout (the one in use left out), Margin review under View, Open guided tutorial, and in focus mode Hide the PDF or Show the PDF beside the editor.

Export ZIP (File › Export ZIP…, the project menu or the palette's Export project ZIP) asks where to save `<project>.zip`, saves the open edits, then writes the project's sources there with the build's output left out, as the Tauri app's does; the project menu says "Exporting ZIP…" while it runs, and a failure shows its message.
The project menu lists what the Tauri one does, in the interface language: the recent projects, Open another folder, New project, Clone repository…, Open from Overleaf, Export ZIP, Export for arXiv…, Guided tutorial and Settings.

The shortcut sheet (⌘?, or Keyboard shortcuts in the palette) lists what the Tauri app's does, built from the keymap as it opens, so it shows only keys that run what they say where they work.
The command table's keyed commands come first, by section, a command with two keys showing both (Command palette, ⌘K / ⇧⌘P) and the workspaces by place a range (⌘1 – ⌘9), with Leave focus mode on ⎋ after Focus mode.
Then Panels and tabs (the workspace's tab, panel, maximize and zoomed-view keys), Text editing (the source editor's), LaTeX (the keys this app binds for a LaTeX source) and Visual Markdown (its editor's own table).
Its field filters by name or by key (⇧⌘J, or J), a group whose title matches keeping every row, and says when no shortcut matches.

Focus mode's bar keeps the window's controls, the document's name centred on the window, and at its end a Markdown, HTML or bibliography file's Edit, Split and Preview, the PDF toggle (Show the PDF or Hide the PDF) and Exit focus with ⎋; it fades in on the fast tier.
In focus mode Escape leaves it as the key's last meaning, as in the Tauri app: not when the document used it (collapsing a selection, closing its completions or its find bar), not from the palette, a sheet or a menu, which close on it instead, never with a modifier held, and never in Vim.

The menu bar is the Tauri app's: Lattice (About Lattice, Settings…, Services, Hide, Quit), File (New Project…, Open…, Open Recent, dimmed with nothing to offer, Clone Repository…, Open from Overleaf…, Import Overleaf ZIP…, Export ZIP… and Export for arXiv…, both dimmed without a project, Close Tab, Close Window), Edit, View (Actual Size, Bigger, Smaller, Enter Full Screen, and Margin Review's Auto, Markers Only and Off for a project linked to Overleaf, the choice checked), Window (Minimize, Zoom, Close Window) and Help (What's New, Report a Problem…, the Lattice website and GitHub).
About Lattice is AppKit's About panel with the version, the attribution Trellis's license asks for ("Uses Trellis by DanFessler - github.com/DanFessler/trellis") and the two links.

A launch's first window opens where the last one was left, on the display it was on (the main display when that one is gone), maximized or full screen as it was, unless too little of it would show on that display; new windows step down from the one in front, on its display.
View ▸ Enter Full Screen reads Exit Full Screen while the window in front is in full screen.
A window's minimum is its layout's, never below 640×680 and grown by the interface size, as the Tauri app's is; on macOS the app goes on once its last window closes, until ⌘Q, and the Dock icon opens a window again, reopening the project used last.
A launch's reopen that takes longer than a second shows the welcome screen while it goes on.

## In the e2e scenario

`scenario/e2e/shell_lifecycle.rs`: the window's minimum following its layout's, and the menu bar's menus and their items.
`scenario/e2e/palette.rs`: the palette's leading groups, a command run from it leading the next opening, What's new's detail, a Settings row found and opened, a paper found by its year or a run inside its title but never one only cited, the Find in project fallback, and the keyboard back in the document afterwards.
`scenario/e2e/export_zip.rs`: File › Export ZIP… beside Export for arXiv…, the palette row, and an export that holds an unsaved edit and leaves the build's output out.
`scenario/e2e/shortcut_sheet.rs`: the sheet's groups and rows (alternatives, ranges, the Esc row), its filter by key and its empty result, and Escape in focus mode collapsing a selection first, then leaving it, and closing the palette without leaving it.
The same module checks the focus bar's title centred on the window and its controls in order, the PDF toggle and Exit focus.
It also checks Escape in the PDF with text selected clearing the selection first, then leaving focus mode.
