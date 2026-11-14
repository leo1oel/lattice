# The LuaLaTeX live preview

One of the features [the GPUI app](../README.md) has so far.

Previews a LuaLaTeX project live, as the Tauri app does, with rtex (its pinned release downloaded once and verified by lattice-core, run on the writer's own TeX Live): the paragraph being typed is painted over its page of the built PDF within moments, a page rtex has laid out again is drawn whole from its display list (or its layout's fallback PDF), and the build's PDF takes over once it shows the edits.
rtex's display lists are drawn natively (OpenType, Type 1 and virtual TeX fonts, rules, colours, images), off the main thread, into a layer over the PDF's pages; the pill at the pages' bottom left says each stage (setting up, starting, the first layout, a layout catching up, stopped with a restart), down to its dot while all is live, and its dot pulses while the save's build, which waits for a pause in typing, runs quietly.
Settings › Editor & builds holds the project's switch and removing the downloaded engine.

## In the e2e scenario

The live preview (`scenario/e2e/live_preview.rs`): no live preview for the pdfLaTeX fixture; switched to LuaLaTeX, the pinned rtex downloaded into the scratch HOME and started with the pill saying each stage, the separate window showing the paper's own PDF without the live layer and the panel keeping it when the PDF returns, a typed paragraph painted over its page, the save's build waiting for the pause and running quietly before its PDF takes over, and Settings' switch turning it off; where rtex cannot run (not a Mac, or no working LuaLaTeX) it checks only that no pill shows. The project's engine and text are put back after.
