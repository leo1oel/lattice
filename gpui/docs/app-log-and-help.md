# The app's log and Help

One of the features [the GPUI app](../README.md) has so far.

Keeps the app's log and Help, as the Tauri app does.
Every notice the window shows is logged with its source and level, and each build as one operation (its start with its trigger, "queued" for one that waited behind another, then how it ended, with its time and counts), newest first, at most 300 entries, with common credential forms redacted before anything is kept or shown; the entries outlive the app in its state folder and each is also a line in `logs/lattice.log` there.
Settings › Logs lists them like a terminal (oldest first, following the newest while the reader stays at the bottom), an operation's entries under one row, with a search, a level filter, Clear, Open log folder and Export…, whose JSON keeps only allowlisted metadata and counts unless the raw text or the runtime logs are asked for, then copies it or saves it.
Help ▸ Report a Problem… (and the palette's Report a problem) saves that redacted export in the log folder's `reports/`, shows it in Finder and opens a new bug report whose address carries only the Lattice and macOS versions; the GPUI preview has no updater, so it never first offers an update.
Help ▸ What's New in Lattice (and the palette) opens the release notes bundled at build time from `src/release-notes/`, at the running version, with a stepper back through older releases; the first launch after an update raises one notice offering it.

## In the e2e scenario

The log and Help (`scenario/e2e/help.rs`): the scenario's builds logged as operations (each start and its success under one id), a notice logged with its source, listed by Settings › Logs and narrowed by its level filter and search, its Export… keeping the notice's text out unless raw text is asked for; Report a problem's saved file and form address (the browser and Finder are not opened); What's new at the running version's notes, paged to an older release and closed; a build asked for while another runs logged with the trigger "queued"; Settings › Logs still following the newest entry once the log is full at 300; and Clear emptying the log.
