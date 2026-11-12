# gpui-fast compatibility crates

GPUI Kit's `gpui-fast` feature (and `gpui-webview`'s, which must agree with it) switches GPUI Kit from the `gpui-pre-*` snapshots to the crates.io `gpui-fast*` 0.1.14 packages.
This workspace already runs one GPUI for everything: Zed's in-tree crates at `d2a4fb6`, replaced by gpui-fast `bbf6dea` through `[patch."https://github.com/zed-industries/zed"]` (GPUI itself by the patched copy in `patches/`).
These crates carry the `gpui-fast*` names and version and re-export that same GPUI, so turning the feature on adds no second GPUI to the graph, exactly as `compat/gpui-pre` does for the snapshots.
