# Notices

One of the features [the GPUI app](../README.md) has so far.

Tells the writer what happened in the Tauri app's toast stack (`src/telemetry/toast-stack.tsx` and the store behind it), drawn at the place Settings › Appearance gives it.
At most four cards show, the newest in front; a fifth pushes the oldest out, and a repeat of a notice still showing updates its card in place under its key (or its source and title) and restarts its clock.
An error stays 9 s and anything else 6 s, unless the notice asks for its own time or to stay until dismissed; a running operation has no clock, shows a bar (swept until it can say how far it is) and the infinity loader, and the notice that says how it ended replaces it.
Every clock holds while the stack is hovered or focused, and while no Lattice window is in front.
Collapsed, the cards behind the front one show an 8px sliver each, 5% smaller and at the front card's height, with a fourth waiting unseen; hovering fans them out into a list 8px apart.
A card drops in its own height from the stack's edge and lifts back out on the exit tweens; it swipes off toward the edge or to the right past 40px, F6 reaches the stack and Escape there dismisses the front card.
An error carries Copy (its title and detail unless it says what to copy), and a copy with nothing else to show says so for 1.8 s.

A daily check, a minute after launch, asks the TeX repository for package updates and reminds the writer at most once a day when there are some: Lattice's BasicTeX gets Update TeX packages (whose progress then has a notice of its own), another TeX the command with Copy; Later keeps it away three days, and a running build holds it back.
An import that outlasts 400 ms shows its progress, which its outcome replaces.
A file past the editor's size limit does not open in a modal: an error notice gives its size and the limit, with Show in Finder, and any other failure to open shows as an error notice as it came.

## In the e2e scenario

The `notices` module (`scenario/e2e/notices.rs`): five notices leave four, newest in front; a repeat stacks no copy; the collapsed pile's slivers, scale and hidden fourth card; the fan-out under the native pointer; a 1 s clock held while hovered and running out once the pointer leaves; a native swipe to the right dismissing the front card with its exit; an error's Copy text and a running notice's bar replaced by its outcome; and the TeX reminder's Update and Later, its update reported to the end on the stand-in installer.
The `open_failure` module (`scenario/e2e/open_failure.rs`): a 9 MiB `.tex` file does not open and is named too large in an error notice, a missing file is an error notice not called too large, and Atkinson Hyperlegible and OpenDyslexic resolve from the bundle and set the source editor when chosen.
