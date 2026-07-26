# Embedded Lattice skills

These skills are compiled into Lattice and are never installed into a user's global agent skill directories.
They were copied from `leo1oel/leo-agent-skills` at commit `0f9004da00c3a9b186d1a16d70f29f66ea5d7a5f`.

The embedded set contains `humanize-writing`, `research-taste`, and `find-and-read-papers` together with the reference modules they require.
The `bibcite` skill is bundled from the application owner's installed skill and is paired with the `leo1oel/bibcite` CLI workflow.

`find-and-read-papers` replaces the earlier `related-work-openalex`, which upstream merged with `arxiv-reading` — searching for papers and reading them are one job, and splitting them left the bundled set able to find a paper but not to read it.

It is the one skill here that is not upstream verbatim, because it is the one that touches the filesystem.
Upstream writes `paper.md` into the working directory; in Lattice that is the LaTeX project, so the text would be uploaded to the user's Overleaf project and committed to version history.
The adapted copy writes under `.research/papers/<arxiv-id>/`, looks there before fetching, pins `arxiv2markdown` to the same range the app uses so a fetched paper and an imported one are the same conversion, and states the rule that reading a paper is not citing it — the Papers list follows the bibliography, so a wide sweep leaves it untouched.
Keep those adaptations when pulling a newer upstream version.

Lattice stages enabled skills in an application-owned directory while disabling OMP's global skill discovery.
OMP exposes their metadata to the model and reads a full skill only when the current request needs it.
