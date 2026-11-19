# Zotero

Search the Zotero library on this Mac and cite or add the result, from the
command palette (⌘K › Search Zotero…).

## What it can reach

- **The project's bibliography** (`project-read = ["bibliography"]`): the keys
  already in your `.bib` files, so a result you already cite is marked and
  adding it again is refused.
- **Port 23119 on this Mac** (`network-local = [23119]`): Zotero's own local
  server. The plugin asks Better BibTeX's JSON-RPC for the search and the BibTeX
  export when it is installed, and Zotero 7's local API otherwise.

It has no other network access. Your search text goes only to the Zotero running
on this Mac, and nothing from the project leaves the machine.

Zotero must be running. With Better BibTeX, citation keys are Better BibTeX's;
without it, keys come from Zotero's own BibTeX export.

## Licence

MIT (see `LICENSE`).
