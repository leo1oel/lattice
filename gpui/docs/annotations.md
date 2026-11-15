# Annotations

One of the features [the GPUI app](../README.md) has so far.

Keeps the writer's notes on passages of the project's sources, as the Tauri app does, in `.research/annotations.json` beside the project, the file both apps read and write through lattice-core.
Annotate selection (the palette), or Annotate on the [selection toolbar](selection-toolbar.md), opens the note's composer beside the selected passage: the quote in the highlighter's amber with its file and line, a line for what should change, the intent chips (Rewrite, Shorten, Clarify, Add a citation, Fix) and Save (⌘↵).
Esc or a click outside closes it, and a note with words in it is offered back with "Note discarded" and Undo, on its passage, in the file it was written on.
In a project linked to Overleaf, either Annotate starts an Overleaf comment thread instead, as the Tauri app does.

Each open note's passage reads as an amber highlighter stroke, blue while the agent's proposal waits and violet while its question does, with its numbered pin in the gutter over the fold column on the line its passage starts (ringed when more notes start there).
The pointer resting on a passage shows its comment card: the pin, the author and the time, the note and its replies, Resolve and Reply….
A note finds its passage again after edits by its quote and the text around it, and is left unplaced when that text has gone or repeats.

The Annotations panel (the titlebar's Annotations button, with the count of open notes, the status bar's Annotations counter, or Show annotations in the palette) lists the notes by file and section, each with its pin, its quote as the PDF reads it, its note, its status and where and when it was made.
Open, Resolved and All filter it, and Filter annotations narrows it by the words, the quote, the file or the author.
A card opens its passage in the editor; resolving or reopening it, replying to it, and (for its author) editing or deleting it answer on the card, and a resolve, a reopen or a delete offers Undo in a toast.

The agent revises the passages the notes are on, a round at a time.
Revise from annotations (the panel's foot, ⇧⌘↵ in the panel, or the palette) asks it about every open note, and Save and revise now (⇧⌘↵ in the composer) about the note just written, three notes at a time, each in a read-only task of its own.
While it works, the note reads "Revising…" and the panel shows the round's progress.
Its answer is a proposal, kept with the note in `.research/annotations.json` and offered with Review N proposals, or a question, which waits on the note's card with a field for the answer and Answer and revise.
Reviewing a proposal opens its card under the passage: the passage read with the agent's edits (each a toggle, and any that would change protected LaTeX held back, a citation offered for "Add a citation"), and the agent's reason.
Accept (⌘↵) writes the edits still chosen as one undo step and resolves the note, Reject (⌫) keeps the passage, Try again… asks for another with what should change instead, and ↑ and ↓ move between the proposals waiting.
A round is a version: once no proposal waits, its files' text before and after it is kept, and the round is recorded in the project's history as one entry.

## In the e2e scenario

Local annotations (`scenario/e2e/annotations.rs`): a passage of the chapter selected and annotated from the palette's Annotate selection, the note typed with native keys and saved with ⌘↵ into `.research/annotations.json`; its passage marked, its pin drawn beside its line and the status bar counting it; Show annotations opening the panel, which lists it; a second note typed and closed with Esc offered back as "Note discarded"; and the first resolved, taking it from the open list and the counter.

Revision rounds (`scenario/e2e/annotation_rounds.rs`): a note saved with Save and revise now, whose stand-in reply from the agent is kept as its proposal in round 1; the proposal's card opened under its passage, ⌘↵ writing it, resolving the note and settling the round as a version, and ⌘Z taking it back; then the agent's question on a second note, the answer asking again, and ⌫ on the card rejecting the proposal.
