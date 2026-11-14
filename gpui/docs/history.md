# History

One of the features [the GPUI app](../README.md) has so far.

Keeps the project's history as the Tauri app does, in its History tool panel (the titlebar's History button, or Open project history in the palette), opened as a tab of the documents' panel: Lattice's own activity and the project's Git versions on one timeline by day (Everything, Versions, Activity with its You / Agent / Citations filter), each run of automatic versions folded into one line, a row's tools behind its time until the pointer reaches it.
A row opens in place: a version's files, the open file's changes read as prose passages (↑ ↓ between them) or as its source diff (GPUI Kit's diff, Pierre's look), Compare with now and the restores (a file, or the project, saved as a version first, after asking); an activity entry's diff and its restores.
Save version names a version; version tracking starts from the panel.
Compare… compares any two versions (the From / To picker, the changed words counted, each passage under its section and line) and exports the PDF with those changes marked through latexdiff, beside a preview of the marked page.
A file Git leaves with conflict markers is offered to the conflict resolver (also Resolve conflicts… in the palette), which keeps one side, the other or both in each spot (1, 2, 3), lets the result be edited before saving, and writes it only over the text it was resolved against.

## In the e2e scenario

The project's history (`scenario/e2e/history.rs`): History opened from the titlebar's command as a tab of the documents' panel, version tracking started and a named version saved, that version's file changes read as prose passages, Compare… against now, a restore of the project that asks first and puts the saved text back, the conflict resolver writing the chosen side without markers, and a merge Git stops on raising the conflict notice, which goes once the merge is aborted.
