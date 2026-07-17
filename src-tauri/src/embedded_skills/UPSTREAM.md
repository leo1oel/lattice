# Embedded Lattice skills

These skills are compiled into Lattice and are never installed into a user's global agent skill directories.
They were copied from `leo1oel/leo-agent-skills` at commit `6d5e7cd0a6f25c446d966514332e182b80490ed2`.

The embedded set contains `humanize-writing`, `research-taste`, and `related-work-openalex` together with the reference modules they require.
The `bibcite` skill is bundled from the application owner's installed skill and is paired with the `leo1oel/bibcite` CLI workflow.

Lattice passes these skill paths to Pi while disabling global skill discovery.
Pi exposes their metadata to the model and reads a full skill only when the current request needs it.
