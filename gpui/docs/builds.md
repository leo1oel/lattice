# Builds

One of the features [the GPUI app](../README.md) has so far.

Builds with lattice-core's latexmk build on one click (or ⌘B / Ctrl+B; ⇧-click rebuilds clean), and after each save and each outside edit it loads (the Tauri app's default automatic builds), and reloads the PDF in place. The Build button's hover card lists the passes latexmk ran; a build can be stopped, and the build files cleaned. The build's diagnostics are the Tauri app's card over the PDF (or docked under it): TeX's messages in plain words with the failing line quoted, a typo's one-click fix, a missing package's install, and errors that jump to their line (F8 / ⇧F8 step through them).
