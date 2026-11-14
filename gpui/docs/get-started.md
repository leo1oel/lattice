# Get started

One of the features [the GPUI app](../README.md) has so far.

Walks a first paper with Get started, as the Tauri app does: opening the guided tutorial shows the checklist beside Project (the palette's Show Get started panel brings it back), its six steps in the order a first paper needs them, each with its one sentence of why and the keys it names drawn as keys, the current one open with its actions (Install LaTeX or Recheck, Show me, Skip, New project, Open folder, From Overleaf, and how to connect Claude Code or Codex).
A step is done where it really happens: LaTeX when the TeX check finds it, the build when the sample builds under a title of the writer's own, the jump at a SyncTeX jump either way, the last step when another project opens; the progress is the writer's, kept as `get-started.json` in the app's state folder. While the checklist is on screen, a build that finds no TeX is its first step's to report, from a fresh check, not the setup dialog's. Show me brings the step's place forward and rings it (following it as panels move, with its hint), until a press anywhere, Escape or eight seconds; another project's layout leaves the checklist out.
The cite step can only be skipped here, since this app has no cite command yet, and the Agent step is not yet marked by an Agent turn, so it too is skipped for now.

## In the e2e scenario

Get started (`scenario/e2e/get_started.rs`): the palette's Show Get started panel bringing the checklist up beside the documents, the fixture having marked its last step, Skip passing a step over, Show me bringing main.tex forward with the ring drawn over it, Escape and a press each taking the ring down, a SyncTeX jump marking its step, the tutorial opening with the checklist shown and the fixture, opened again, leaving it out. With `LATTICE_E2E_SHOTS=DIR` and the `offscreen-shots` feature it saves the window with the checklist up and with the Show me ring drawn.
