# frontend-polish-sweep — before/after

Each `NN-area-before.png` / `NN-area-after.png` pair is the same crop of the real app
(perf-bench in-memory backend, 1440×900 @2x, light, en) on 3f1f596e and on
fm/frontend-polish-sweep. 17-* is the Overleaf collaboration drawer rendered with
sample threads (its live state needs a connected Overleaf account).

- 01 papers no-match: lattice grid + dashed blue knot → a page whose lines stop at an empty lens
- 02 status bar: Comments/TODOs floated mid-bar → grouped before the counts
- 03 command palette: lost its width/padding to `.modal` → restored; borderless query row, one line per command with its shortcut at the end
- 04 settings › Appearance: "General" heading under "Appearance" removed; "Follow system (defa…" → "Match system"
- 05 settings › Logs: "Activity log" heading under "Logs" removed (TeX doctor likewise)
- 06 settings › Overleaf: duplicate cloud tile beside the cloud button removed
- 07 find in project: half-height gap between file and paper results removed; query terms highlighted; softer active row
- 08 history › Versions: bare sentence → shared empty state + drawing
- 09 editor comments: filters hidden while there are no comments; centered empty state; correct copy when filtered
- 10 file tree menu: grouped with rules; Delete apart
- 11 Panels menu: every item has its icon so labels align
- 12 agent unavailable: stacked/centered instead of squeezed beside Retry
- 13 TODOs: literal backticks → code chips inside one empty state
- 14 welcome: Install LaTeX tools joins the quiet secondary row
- 15 create project: room under the title
- 16 open from Overleaf: frame below the title and filling the dialog
- 17 Overleaf drawer (comments/changes/chat): space under the Comments/Changes/Chat switcher, tabs fill the track, quiet counts on inactive tabs, cards in a file group no longer touch, file paths not uppercased, softer own chat bubble
