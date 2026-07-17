# Embedded Lattice skills

These skills are compiled into Lattice and are never installed into a user's global agent skill directories.
They were copied from `leo1oel/leo-agent-skills` at commit `6d5e7cd0a6f25c446d966514332e182b80490ed2`.

The embedded set contains `humanize-writing`, `research-taste`, and `related-work-openalex` together with the reference modules they require.
Lattice selects only the modules needed for the current request and treats its structured response contract as higher priority than a skill-specific delivery format.
