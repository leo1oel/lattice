# The welcome screen

One of the features [the GPUI app](../README.md) has so far.

Opens without a project on the welcome screen (the lattice field, the mark weaving in, New project, Open folder, Clone repository, the guided tutorial, the three recent projects on ⌘1 to ⌘3 laid on the desk with each one's first page and venue, Import ZIP, Install LaTeX tools), and reopens the project used last at launch, saying so there when its folder has gone. New project (⌘⇧N) creates one from any of the Tauri app's venue templates.
Under the venue, My templates lists the templates the writer saved (`welcome/local_templates.rs`), each with its version, source URL, compile root and engine under it and its files folded under Files; choosing one creates the project from it, through lattice-core's `templates::instantiate`, and choosing a built-in venue again leaves it.
Save a local template… opens a dialog over New project (`welcome/save_template.rs`) that reads a folder, a ZIP or the open project with `templates::inspect`, then asks the template's name and version (at most 300 characters each) and source URL, its compile root, engine and preview image, and which reusable files to copy; Save template waits for a name and the compile root ticked, and the template saved joins My templates, chosen.
The GPUI app keeps the templates in its own state folder (`templates/`), apart from the Tauri app's.

## In the e2e scenario

My templates (`scenario/e2e/local_templates.rs`): New project with no list while nothing is saved; Save a local template reading the open project, its hidden files left out and Save template held until it is named and its compile root ticked; the saved template joining My templates chosen; and a project created from it holding the compile root and no file left unticked.
With `LATTICE_E2E_SHOTS=DIR` and the `offscreen-shots` feature it saves the window at the save dialog and at New project with the template chosen.
