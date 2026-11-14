# Commands, windows and project tabs

One of the features [the GPUI app](../README.md) has so far.

Reaches every command from the command palette (⌘K), the keymap, the shortcut sheet (⌘?) and the menu bar; opens projects in new windows or as tabs in one, from the title bar's project menu (the recent projects, each in a window of its own or in this one), File ▸ Open Recent or the palette.

The menu bar is the Tauri app's: Lattice (About Lattice, Settings…, Services, Hide, Quit), File (New Project…, Open…, Open Recent, dimmed with nothing to offer, Clone Repository…, Open from Overleaf…, Import Overleaf ZIP…, Export for arXiv…, dimmed without a project, Close Tab, Close Window), Edit, View (Actual Size, Bigger, Smaller, Enter Full Screen, and Margin Review's Auto, Markers Only and Off for a project linked to Overleaf, the choice checked), Window (Minimize, Zoom, Close Window) and Help (What's New, Report a Problem…, the Lattice website and GitHub).
About Lattice is AppKit's About panel with the version, the attribution Trellis's license asks for ("Uses Trellis by DanFessler - github.com/DanFessler/trellis") and the two links.

A launch's first window opens where the last one was left, on the display it was on (the main display when that one is gone), maximized or full screen as it was, unless too little of it would show on that display; new windows step down from the one in front, on its display.
View ▸ Enter Full Screen reads Exit Full Screen while the window in front is in full screen.
A window's minimum is its layout's, never below 640×680 and grown by the interface size, as the Tauri app's is; on macOS the app goes on once its last window closes, until ⌘Q, and the Dock icon opens a window again, reopening the project used last.
A launch's reopen that takes longer than a second shows the welcome screen while it goes on.

## In the e2e scenario

`scenario/e2e/shell_lifecycle.rs`: the window's minimum following its layout's, and the menu bar's menus and their items.
