# Bibliography check

Check the project's `.bib` files from the command palette (⌘K › Check
bibliography): duplicate keys and DOIs, missing required fields and malformed
years, each a diagnostic you can jump to. A malformed DOI offers a confirmed
"Normalize DOI" fix.

## What it can reach

- **The project's bibliography** (`project-read = ["bibliography"]`): the
  parsed entries of the project's `.bib` files.

It has no network access, and nothing from the project leaves the machine. A
fix changes the file only after you confirm it.

## Licence

MIT (see `LICENSE`).
