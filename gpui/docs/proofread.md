# Proofread, Polish and Rewrite

One of the features [the GPUI app](../README.md) has so far.

Asks the embedded agent to proofread, polish or rewrite a selection of a LaTeX source, as the Tauri app does, and shows its answer as edits to review in place.
Proofread (⌘⌥P, the selection toolbar, or Proofread selection in the palette) corrects errors and nothing else, and Polish also improves flow and clarity.
Rewrite with an instruction (the toolbar's Rewrite button, or Rewrite selection… in the palette) asks in the writer's own words, such as "Translate into academic English", and keeps the last five instructions for reuse, the writer's rather than a project's, in `selection-instructions.json` in the app's state folder.
With nothing selected, it asks for a selection first.

The card opens under the selection's last line, so the text below moves down rather than hiding behind it, and the passage it would replace is marked in the accent.
While the agent works, it shows skeleton lines where the answer will be, and Cancel.
The answer reads as the passage with each edit's old words struck and its new words marked, with a tag naming why, and the reason in its tooltip.
Clicking an edit keeps the original, and clicking it again makes the edit again.
Lattice holds back any edit that would change protected LaTeX (math, citations and references, comments, commands, environments, verbatim code or paragraph breaks) and says so.
Accept (⌘↵) applies the edits still made, in one undo step of its own, Accept all applies every offered one, and Discard (Esc) drops them.
Accepted edits are marked for a moment, one edit after another: the old words are struck through where they stood, then fold their width away a character at a time as they fade, and the new ones settle in on the success wash, which holds and fades (`lattice_ui::attention::accept`).
Under reduced motion the old words go at once and the new ones show with the wash.
The card's Proofread and Polish switch asks again at the other strength, and after an error Try again asks again.

The request goes to the agent service as one read-only text task, the same prompt the Tauri app sends, and the agent writes its notes in the interface's language.
An edit inside the passage while the agent worked is caught at Accept, which asks to proofread again rather than overwrite it.

## In the e2e scenario

Proofread (`scenario/e2e/proofread.rs`): a sentence selected and ⌘⌥P opens the card, which reads a stand-in reply from the agent as two edits; the first kept as it was, ⌘↵ applies the other in one undo step that ⌘Z takes back, and the words it replaced fold their width away; Polish asks again and Esc discards it; with no stand-in, the scratch run's missing agent shows the card's error; and Rewrite selection… opens the Rewrite menu, whose instruction asks in the writer's words.
