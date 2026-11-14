# Finding things in the project

One of the features [the GPUI app](../README.md) has so far.

Finds things in the project as the Tauri app does: quick open (⌘P) lists the files visited this session first and ranks a typed name, `:42` goes to a line of the file on screen and `@` to a section or label; Find in project (⌘⇧F) searches the project's files and its papers library, the hits gathered under each file, F3 stepping through them; ⌘[ and ⌘] go back and forward over the places visited; Replace in project (⌘⇧H) previews every match, then rewrites them through lattice-core, which records the replacement in the project's history.
