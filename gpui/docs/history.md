# History

One of the features [the GPUI app](../README.md) has so far.

Keeps the project's history as the Tauri app does, in its History tool panel (the titlebar's History button, or Open project history in the palette), opened as a tab of the documents' panel: Lattice's own activity and the project's Git versions on one timeline by day (Everything, Versions, Activity with its You / Agent / Citations filter), each run of automatic versions folded into one line, a row's tools behind its time until the pointer reaches it.
A row opens in place: a version's files, the open file's changes read as prose passages (↑ ↓ between them) or as its source diff (GPUI Kit's diff, Pierre's look), Compare with now and the restores (a file, or the project, saved as a version first, after asking); an activity entry's diff and its restores.
Save version names a version; version tracking starts from the panel.
Compare… compares any two versions (the From / To picker, the changed words counted, each passage under its section and line) and exports the PDF with those changes marked through latexdiff, beside a preview of the marked page.
A file Git leaves with conflict markers is offered to the conflict resolver (also Resolve conflicts… in the palette), which keeps one side, the other or both in each spot (1, 2, 3), lets the result be edited before saving, and writes it only over the text it was resolved against.
The Agent's checkpoints are rows of the timeline too, with the Agent's activity: each names its turn's files and the lines they gained and lost, opens on its thread and each file's kind and counts, and undoes the turn's file changes through the Agent, only for the thread the Agent panel has open (the others say to open that task first).
An Undo that kept newer edits where they overlap the Agent's change says so and opens the resolver on the first file it marked; each file it marked, however it is opened, resolves between the current text and the text from before the Agent.

## Track changes

The titlebar's Track changes turns on the project's local review mode, as the Tauri app's does: every `.tex` and `.bib` file is copied as its base into `.research/review/` (lattice-core's `project::review_mode`), the open file's unsaved text included, and from then on every difference between a file's base and its text is one of the writer's tracked changes.
The changes are worked out rather than recorded (`history/review_mode/diff.rs`): the changed lines, then the words inside them, so a corrected word reads as that word, Chinese a character at a time.
Each is marked in the source as Overleaf's suggestions are, in the writer's blue-violet: an insertion underlined over a tint, a deletion struck through at the point it left, with a hover card saying what was inserted, deleted or replaced and Accept and Reject for it.
The review bar over the editor counts them ("3 changes", or "2 of 3" at the caret), steps to the previous and next, accepts or rejects the one at the caret and then selects the next, accepts or rejects them all, shows the PDF with or without the changes marked, and stops tracking (asking first while changes wait); at 760px or less its text buttons keep only their icons, and at 520px or less the title keeps only its dot.
An accept moves the base, written to disk 400 ms later, and is an undo step like a reject: ⌘Z takes it back while nothing was typed or undone since.
Text a co-author's live edit puts in moves the base with it instead of reading as the writer's change, and when it lands in text the writer had changed the bar says "A co-author edited text you changed. Both versions are kept."; a sync that pulls or merges files moves their bases the same way.
While review mode is on, the PDF panel shows the PDF with the changes marked (latexdiff against the bases, built after each build of the paper and each accept, 600 ms later), with the "Marking changes…" pill while it builds; when it cannot be made, the paper's own PDF stays with the reason above it. The PDF in its own window shows the paper's own, and a double-click on the marked PDF jumps nowhere.
Stop tracking changes deletes the bases and leaves the files as they are.

## In the e2e scenario

The project's history (`scenario/e2e/history.rs`): History opened from the titlebar's command as a tab of the documents' panel, version tracking started and a named version saved, that version's file changes read as prose passages, Compare… against now, a restore of the project that asks first and puts the saved text back, the conflict resolver writing the chosen side without markers, and a merge Git stops on raising the conflict notice, which goes once the merge is aborted.
Track changes (`scenario/e2e/track_changes.rs`): the toggle copying the bases and putting up the bar, a word typed over another read as one change and a sentence added as a second, Accept at the caret written to the base on disk and taken back by ⌘Z, the PDF with the changes marked (or the reason without latexdiff), and Reject all and Stop tracking leaving the base's text and no bases behind.
The Agent's checkpoints (`scenario/e2e/agent_checkpoints.rs`): a thread's first snapshot listed and building nothing, a fresh checkpoint building the PDF and reporting the build to its turn, only the open thread's rows undoing, and an Undo's conflict markers opening the resolver on the Agent's sides.
