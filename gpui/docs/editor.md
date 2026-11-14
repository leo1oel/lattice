# The source editor

One of the features [the GPUI app](../README.md) has so far.

Edits sources in Zed's editor with LaTeX highlighting in Lattice's code themes, search (Zed's buffer search bar) and an optional Vim mode (Zed's Vim); in a `.tex` file, a card for the citation key or `\ref` label under the pointer, completion of commands, citation keys and labels, and TexLab's diagnostics (when `texlab` is installed), through Lattice's editor adapter (below).
The source gutter is the Tauri app's: four-digit line numbers and a fold column whose chevrons show over the gutter and fold a LaTeX environment, section, preamble, brace group or comment block, so the text starts where CodeMirror's does.
A `.tex` file has the outline rail on the editor's right edge (its sections' marks, the one being read in the accent; resting on it opens the outline with numbers and PDF pages, and a row jumps there), and the Source / Visual switch in its strip, where Visual says it is not in the GPUI preview yet.

## In the e2e scenario

In `main.tex` it checks the editor adapter: the citation and reference cards open when native mouse moves rest on a key or label and close when the pointer leaves, remote carets draw and name themselves and fade, a block widget pushes the lines below it down, a gutter mark set on a line is painted there and opens its card, TexLab's diagnostic for an unknown `\ref` shows as a mark whose card opens and clears once the reference goes, and with the bibliography unlinked, TexLab's diagnostic on the cited key opens its lint card under the citation card (both skipped without `texlab`), a card opens over its range's last character and not from the space past its line's end, a `.tex` file renamed to `.txt` is never synced to TexLab, and native keys complete a citation key, `\textbf`, and a package in the middle of `\usepackage`'s list (prefix matches first, the bare name inserted). With `LATTICE_E2E_SHOTS=DIR` (macOS) it saves the window at each card, the carets and the completion menus.
