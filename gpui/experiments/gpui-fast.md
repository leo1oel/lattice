# Running the prototype on gpui-fast

gpui-fast (longbridge/gpui-fast, Apache-2.0) is a fork of Zed's GPUI with retained-mode rendering and cached scroll layers.
Its `main` at `bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa` tracks Zed `d2a4fb6` (its `UPSTREAM` file), the commit this prototype pins, and keeps Zed's crate names, so Zed's GPUI family can be swapped for it with one patch table.
GPUI Kit follows automatically: the `compat/gpui-pre` shims re-export whatever `gpui` resolves to.

Tried on 2026-11-11: the whole app type-checks and builds, the `e2e` scenario passes 11 of 11 steps, and the `perf` scenario runs (results and the comparison with upstream GPUI are in the findings report).

## Recipe

Add this table to `Cargo.toml`:

```toml
[patch."https://github.com/zed-industries/zed"]
bench_metrics = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
collections = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
gpui = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
gpui_apple = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
gpui_ios = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
gpui_linux = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
gpui_macos = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
gpui_macros = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
gpui_platform = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
gpui_shared_string = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
gpui_util = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
gpui_web = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
gpui_wgpu = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
gpui_windows = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
http_client = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
http_client_tls = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
refineable = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
derive_refineable = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
reqwest_client = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
scheduler = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
sum_tree = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
zlog = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
ztracing = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
ztracing_macro = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
perf = { git = "https://github.com/longbridge/gpui-fast", rev = "bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa" }
```

`util` and `util_macros` stay Zed's: gpui-fast's copy of `util` has its own `rel_path` types, which Zed's `extension` crate rejects (`expected util::rel_path::RelPathBuf, found path::rel_path::RelPathBuf`).

Then build as usual, with `CARGO_NET_GIT_FETCH_WITH_CLI=true` if git rewrites GitHub URLs to SSH on the machine.
