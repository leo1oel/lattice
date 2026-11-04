# Coding in a research project

Lattice already uses CodeMirror language grammars to display code and includes
an xterm.js terminal backed by a real native pseudo-terminal. Open the Terminal
panel with **Ctrl+`**. It starts a login shell in the project directory and uses
your own environment, including installed Python environments and tools.

The terminal header's **Run current file** button opens a run configuration.
Choose a program such as `python3`, an absolute interpreter path such as a
project's `.venv/bin/python`, and optional JSON arrays of program and script
arguments. Python defaults to `python3`, JavaScript to `node`, and shell scripts
to `sh`. TypeScript and other languages depend on the program/runtime you select;
Lattice does not install those tools or silently compile a project.

**Save and run** first saves the active file and starts a dedicated terminal only
if the same document and project are still active. The selected program and arguments are started directly in a dedicated PTY,
without shell interpolation or queued terminal keystrokes. The backend uses its
configured tool search path; an explicit interpreter path is supported. Its output and exit status
stay visible after it exits successfully. **Interrupt command** sends Ctrl-C;
closing the terminal ends its process group. Opening a project or a run dialog
never executes project code by itself.

There is no bundled Python environment, debugger, language server, package
manager, or VS Code extension host in this feature. Language highlighting and
basic completion do not imply cross-file type checking or debugger support.
The existing desktop browser-handoff host still cannot open a terminal; remote
Linux terminals require the separately authenticated headless transport.
