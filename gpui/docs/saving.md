# Saving and outside edits

One of the features [the GPUI app](../README.md) has so far.

Saves as the Tauri app does: after a pause in typing, on leaving the editor, and before a tab or window closes, another project opens in its window or the app quits, merging an edit made outside Lattice since the file was loaded rather than writing over it; an outside edit reloads a clean buffer, and a file moved or deleted outside Lattice is followed, closed or held with its edits.
