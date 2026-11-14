# Settings

One of the features [the GPUI app](../README.md) has so far.

Settings (⌘,): Appearance (interface language, the interface size, notification position, interface sounds, both editors' type, the theme's appearance, tint, accent and code theme, translucency, the title bar's tools) and Editor & builds (keymap, spell checking, your name, the project dictionary, the automatic build, cleaning, the project's engine, shell escape and halt on error, the live preview), searchable, applied as each choice is made, kept in `settings.json` and watched; the first run imports the Tauri app's own choices.
The interface size zooms every window as the Tauri app's webview zoom does (90% to 135%), from Settings, ⌘+ / ⌘= and ⌘− (with the size pill under the titlebar) and ⌘0, View ▸ Actual Size, Bigger and Smaller, and the palette.
Interface sounds are the Tauri app's two cues, synthesized from the same Cuelume recipes, for a build the writer asked for and a running notice that settles.
Spell checking marks Harper's spelling and grammar findings in `.tex`, `.md` and `.txt` files (a LaTeX document in another language against its Hunspell dictionary, downloaded on first need) with the lint card's fixes, Add to project dictionary and the project's ignores.
Translucency puts macOS's under-window vibrancy behind a frosted titlebar, gutters, Project and Papers, as the Tauri app does (off while Reduce transparency is on).

## In the e2e scenario

The `settings` module opens Settings with ⌘, (native keys), searches it and opens the row found with Enter, checks that a tint, an accent, a code theme and the editor's size apply at once, that the keymap turns Vim and Emacs on, that the interface switches to Simplified Chinese and back, that with Manual only builds an edit made outside the app reloads the open file and starts no build, that turning the Git tool off under Title bar tools takes its button out of the title bar and turning it on puts it back, that an edit to the settings file made outside the app applies, and that Escape closes it.
The `live_controls` module (`scenario/e2e/live_controls.rs`) checks Settings' live controls: the interface size with ⌘= / ⌘− / ⌘0 as native keys (the window's layout and scale, the size pill) and from Settings, interface sounds heard for a build the writer asked for and a running notice settling and not heard when off, spell checking marking and carding a misspelling, adding it to the project's dictionary, off and on and in Simplified Chinese, and translucency's vibrancy and glass at each strength (or the reason there is none).
