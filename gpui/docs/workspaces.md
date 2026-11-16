# Named workspaces

One of the features [the GPUI app](../README.md) has so far.

Keeps named workspaces, shared by every project (a dot while the project's layout differs; "+", rename in place, save, revert, duplicate, move, delete with undo), the Writing, Reading and Bibliography presets and focus mode over them, and each project's own layout, restored when it opens again.

The switch's raised plate slides from the workspace left to the one chosen, in the moderate tier (it jumps with reduced motion), as the Tauri app's sliding pill does.
A tab pressed and moved 4px along the track is dragged: it takes the place of each tab whose middle the pointer passes, the order saved as it goes, drawn at 70% with the grabbing hand, and the press switches nothing.
The project's workspace is the track's one tab stop: ← and → (round the ends), Home and End switch workspaces and take the keyboard along, F2 renames, and ⇧F10 opens the workspace's menu under its tab.
The rename field holds at most 24 characters, cutting what is typed or pasted to the room left before it goes in (the input's `max_length`, as the Tauri field's `maxLength`), so ⌘Z undoes a cut paste as one step; a name another workspace has stays in editing, ringed as invalid with "Name already used" until the next keystroke, and the keyboard goes back to the tab when the field closes.

The `workspace_switch` e2e module (`scenario/e2e/workspace_switch.rs`), with the platform's own pointer and key events: a tab dragged past its neighbour's middle taking its place without switching; → End Home ← switching and taking the keyboard along, ← going round from the first; F2 renaming, a 30-character paste keeping its first 24 and ⌘Z and ⌘⇧Z undoing and redoing it, a taken name staying in editing marked, and Escape giving the keyboard back to the tab; and ⇧F10 opening the workspace's menu.
