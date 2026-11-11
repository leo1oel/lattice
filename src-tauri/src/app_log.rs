//! Lattice's log file: where the log plugin writes, how much it keeps, and
//! which level each crate logs at.

/// Crates that log a line per request, frame or file event at debug level.
const NOISY_DEPENDENCIES: &[&str] = &[
    "tao",
    "wry",
    "tauri",
    "reqwest",
    "hyper",
    "hyper_util",
    "h2",
    "rustls",
    "tungstenite",
    "tokio_tungstenite",
    "axum",
    "tower",
    "mio",
    "notify",
    "globset",
    "ignore",
    "html5ever",
    "selectors",
];

/// The log level: `LATTICE_LOG` (error, warn, info, debug or trace) when set,
/// else debug in development builds and info in release builds.
fn log_level(setting: Option<&str>) -> log::LevelFilter {
    let default =
        if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info };
    setting.and_then(|value| value.trim().parse().ok()).unwrap_or(default)
}

/// The log plugin at the level `LATTICE_LOG` asks for.
pub fn plugin() -> tauri_plugin_log::Builder {
    let level = log_level(std::env::var("LATTICE_LOG").ok().as_deref());
    let mut log_plugin = tauri_plugin_log::Builder::new()
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("lattice".to_string()),
            }),
            #[cfg(debug_assertions)]
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
        ])
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
        .max_file_size(2 * 1024 * 1024)
        .level(level)
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal);
    // Debug is for Lattice's own lines. The window, network and file-watch
    // crates would bury them, so only `trace` lets those through below info.
    if level < log::LevelFilter::Trace {
        for chatty in NOISY_DEPENDENCIES {
            log_plugin = log_plugin.level_for(*chatty, level.min(log::LevelFilter::Info));
        }
    }
    log_plugin
}

#[cfg(test)]
mod tests {
    use super::log_level;

    #[test]
    fn lattice_log_overrides_the_build_default_level() {
        assert_eq!(log_level(Some("debug")), log::LevelFilter::Debug);
        assert_eq!(log_level(Some(" WARN ")), log::LevelFilter::Warn);
        let default =
            if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info };
        assert_eq!(log_level(Some("verbose")), default);
        assert_eq!(log_level(None), default);
    }
}
