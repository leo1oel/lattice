# Embedded Lattice skills

These skills are compiled into Lattice and are never installed into a user's global agent skill directories.
They were copied from `leo1oel/leo-agent-skills` at commit `0f9004da00c3a9b186d1a16d70f29f66ea5d7a5f`.

The embedded set contains `humanize-writing` and `research-taste` together with the reference modules they require. Literature discovery, reading, citation, upgrade, and removal are native Lattice tools rather than embedded skills.

Lattice stages enabled skills in an application-owned directory while disabling OMP's global skill discovery.
OMP exposes their metadata to the model and reads a full skill only when the current request needs it.
