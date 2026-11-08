# Zotero, Heptabase and the Agent panel

For writers who read in Zotero, take notes in another app, and write in
Lattice. Two parts: bringing a Zotero collection into the Papers library, and
letting the Agent panel reach your Zotero library and your notes through MCP
servers.

## Import a Zotero collection into Papers

Nothing needs turning on in Zotero, and Zotero can be open or closed.

1. In Lattice, open **Papers → Add papers** and choose **Zotero…**.
2. Pick **My Library** or a collection. Its items fill the sheet as BibTeX:
   what Papers already holds (same DOI, arXiv id or citation key) is skipped,
   and the rest is added with **Add papers**.

Lattice finds the Zotero data folder the way Zotero does (the folder set in
Zotero's **Settings → Advanced → Files and Folders**, otherwise `~/Zotero`) and
reads a private copy of its `zotero.sqlite`, never the live file. If the library
lives somewhere Lattice cannot find, choose its folder with **Choose Zotero
folder…**. Only your personal library is read; group libraries are not.

Citation keys stay the ones you cite with: a Better BibTeX key is used when
Better BibTeX keeps one, then a key in the item's Citation Key field or pinned in
its Extra field as `Citation Key: …`, otherwise a key in the shape of Zotero's
own export (`lastname_firstword_year`). An item with an arXiv id brings its full
text from arXiv; otherwise its PDF attachment, when the file is on this Mac,
becomes the paper's readable text. Items without either are added as citations
only.

To bring in a library from another Mac, export the collection from Zotero (or
with Better BibTeX) as a `.bib` file and paste the whole file into **Add papers**,
or link it with **Linked library…** to take in later changes after review.

The import only reads from Zotero; nothing is written back.

## Let the Agent use Zotero and your notes

The Agent panel runs your own agent CLI, so it can use the MCP servers you set
up for that CLI. Nothing is configured inside Lattice beyond the one switch
below.

- **Claude:** add servers with `claude mcp add --scope user …` (user scope, so
  every project folder sees them), then turn on **Settings → Agent → Providers →
  Load my MCP servers in Claude**. It is off by default because a new chat waits
  for every server to connect first. It applies to new and restarted chats.
- **Codex:** add servers with `codex mcp add …`. Codex reads them from
  `~/.codex/config.toml` in every chat; there is no switch.

### Zotero

[Zotero MCP](https://github.com/54yyyu/zotero-mcp) (`zotero-mcp-server` on
PyPI) reads your local library through Zotero's local API, which answers only
when **Settings → Advanced → Allow other applications on this computer to
communicate with Zotero** is on in Zotero. Unlike the import above, this server
needs that setting.

```bash
uv tool install zotero-mcp-server      # or: pipx install zotero-mcp-server

# Claude
claude mcp add --scope user zotero -e ZOTERO_LOCAL=true -- zotero-mcp

# Codex
codex mcp add zotero --env ZOTERO_LOCAL=true -- zotero-mcp
```

### Heptabase

Heptabase runs an official remote MCP server at `https://api.heptabase.com/mcp`
([Heptabase MCP](https://support.heptabase.com/en/articles/12679581-heptabase-mcp)).
It needs a Heptabase Pro, Premium or Premium+ plan (or a trial), also for
read-only access, and you sign in to Heptabase once.

```bash
# Claude: add it, then run `claude` in a terminal, enter /mcp and pick heptabase-mcp to sign in
claude mcp add --scope user --transport http heptabase-mcp https://api.heptabase.com/mcp

# Codex: add it, then sign in
codex mcp add heptabase --url https://api.heptabase.com/mcp
codex mcp login heptabase
```

Grant read-only access when you sign in if the agent should only read your
notes. On a free Heptabase plan, export the cards you need as Markdown into the
project folder instead; the agent reads project files without any setup.

### Check it

Open a new chat in the Agent panel and ask, for example, "Search my Heptabase
notes for the related-work section and summarise what I wrote." If the agent
says it has no such tool, check that the server is listed by `claude mcp list`
or `codex mcp list`, that the Claude switch is on, and that the chat was started
after the change.
