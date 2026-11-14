#!/bin/sh
# The rustc wrapper a no-mistakes run worktree's generated .cargo/config.toml
# names (scripts/run-worktree-cargo-guard.mjs). Cargo calls it for every rustc
# it runs, starting with its `rustc -vV` probe, so the guard refuses a
# compiling cargo command before anything lands in target/.
# LATTICE_ALLOW_LOCAL_CARGO=1 on the cargo command runs rustc directly (without
# sccache) and writes the local target the guard exists to prevent.
[ -n "${LATTICE_ALLOW_LOCAL_CARGO:-}" ] && exec "$@"
exec node "$(dirname "$0")/run-worktree-cargo-guard.mjs" refuse "$@"
