# SQLite compatibility crate

Zed's `sqlez` (under its editor and workspace crates) asks for `libsqlite3-sys` 0.30, and `lattice-core`'s `rusqlite` 0.40 for `libsqlite3-sys` 0.38, the version the Tauri app ships with.
Both link the native `sqlite3` library, and Cargo allows only one crate in a dependency graph to link a given native library, so the two cannot both be in the graph as themselves.

`libsqlite3-sys` here carries 0.30.1's name and version, declares no native library, and re-exports 0.38 with the `bundled` feature `sqlez` asks for.
`[patch.crates-io]` in the workspace manifest swaps it in for 0.30, so the app links one SQLite, 0.38's, as the Tauri app does.
The raw bindings `sqlez` calls are the same in both versions.
