# The app's log and Help

One of the features [the GPUI app](../README.md) has so far.

Keeps the app's log and Help, as the Tauri app does.
Every notice the window shows is logged with its source and level, and each build as one operation (its start with its trigger, "queued" for one that waited behind another, then how it ended, with its time and counts), newest first, at most 300 entries, with common credential forms redacted before anything is kept or shown; the entries outlive the app in its state folder and each is also a line in `logs/lattice.log` there.
Every error the app logs, and every warning of Lattice's own crates, reaches the log too, from the App source, as the Tauri app routes its page's uncaught errors and console errors there; a repeat updates its entry rather than adding a copy.
A panic is logged; on the main thread it is also written at once to `logs/lattice.log` and the open editors' unsaved text is written before the app ends, as a save writes it and within 3 seconds, as the Tauri app's crash save does; the next launch says Lattice quit unexpectedly, with the error's details to copy, Report a problem, and the panic in Settings › Logs.
Settings › Logs lists them like a terminal (oldest first, following the newest while the reader stays at the bottom), an operation's entries under one row, with a search, a level filter, Clear, Open log folder and Export…, whose JSON keeps only allowlisted metadata and counts unless the raw text or the runtime logs are asked for, then copies it or saves it.
Help ▸ Report a Problem… (and the palette's Report a problem) saves that redacted export in the log folder's `reports/`, shows it in Finder and opens a new bug report whose address carries only the Lattice and macOS versions; when the [app updater](updater.md) knows of a newer release, it first offers it ("You’re on vX; vY is available", Update now or Report anyway).
Help ▸ What's New in Lattice (and the palette) opens the release notes bundled at build time from `src/release-notes/`, at the running version, with a stepper back through older releases; the first launch after an update raises one notice offering it.

## In the e2e scenario

The log and Help (`scenario/e2e/help.rs`): the scenario's builds logged as operations (each start and its success under one id), a notice logged with its source, listed by Settings › Logs and narrowed by its level filter and search, its Export… keeping the notice's text out unless raw text is asked for; Report a problem's saved file and form address (the browser and Finder are not opened); What's new at the running version's notes, paged to an older release and closed; a build asked for while another runs logged with the trigger "queued"; Settings › Logs still following the newest entry once the log is full at 300; and Clear emptying the log.

The app's lifecycle (`scenario/e2e/shell_lifecycle.rs`): an error logged in the app reaching the log once, from App; the crash save writing an editor's unsaved text from what its edits handed over, and forgetting the editor once it is closed; and the notice and log entry the launch after a crash shows.
