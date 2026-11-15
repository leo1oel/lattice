# Builds

One of the features [the GPUI app](../README.md) has so far.

Builds with lattice-core's latexmk build on one click (or ⌘S / Ctrl+S, which saves and builds, as in the Tauri app; ⇧-click rebuilds clean), once when a project is entered (whatever Settings › Editor & builds says), and after each save (the Tauri app's default automatic builds), and reloads the PDF in place.
A write the window's open editors do not own (the Agent, a terminal, another editor, an Overleaf pull) to a build input builds once the writes pause for 1.5 s, and so does an outside edit of an open file; files only a build writes (its aux, log and synctex files, the root document's PDF, bbl and -blx.bib, `_minted`/`svg-inkscape`, the atomic-write temporary, `.git`, and whatever the last pass's recorder named) start no build.
After a build that stalled, automatic builds wait until an input changes; Build still runs on request.
A successful build of an Overleaf-linked project becomes an "Auto-saved version" git commit, at most every 2 minutes.
The Build button's hover card lists the passes latexmk ran; a build can be stopped, and the build files cleaned; a quiet (live-preview) build's success shows the chip's check without the flourish.
The build's diagnostics are the Tauri app's card over the PDF (or docked under it, a choice kept for every project and imported from the Tauri app's): TeX's messages in plain words with the failing line quoted, Lattice's own build advice in the interface language (copies and logs stay in English), a typo's one-click fix, a missing package's install, the whole raw log, and errors that jump to their line (F8 / ⇧F8 step through them).
Each open editor underlines the whole line of each of the build's diagnostics while its text is the text the build compiled, so the marks go on an edit and come back on its undo.

## In the e2e scenario

The `watched_builds` module (`scenario/e2e/watched_builds.rs`): a write to a file no editor has open building once the writes pause, a burst of such writes building once after the last of them, an outside edit of an open file waiting for the pause too, a file only a build writes starting no build (nor, open in an editor, making the PDF older when it reloads), and the card's docked or floating choice kept in the settings.
The `build_marks` module (`scenario/e2e/build_marks.rs`): the broken build's error underlined in the editor whose text it compiled, gone on an edit and back on its undo.
