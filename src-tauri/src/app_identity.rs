//! The bundle identifier this build was configured with.
//!
//! Tauri's own `app_data_dir`/`app_cache_dir` already follow the configured
//! identifier, but a few paths are needed where no `AppHandle` reaches (tool
//! directories, the literature keychain item). They derive from this instead of
//! a literal, so a build with another identifier — the perf lab's
//! `tauri build --config` override — never reads or writes the shipped app's
//! tools, caches or keychain item.

use std::sync::OnceLock;

static IDENTIFIER: OnceLock<String> = OnceLock::new();

/// Record the identifier from the generated Tauri context; `run` calls this
/// before anything can ask for it.
pub(crate) fn init(identifier: &str) {
    let _ = IDENTIFIER.set(identifier.to_string());
}

/// The configured identifier. Outside `run` (unit tests) it is the one in
/// tauri.conf.json, which is what every path here meant before.
pub(crate) fn identifier() -> &'static str {
    IDENTIFIER.get_or_init(|| {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json is valid JSON");
        config["identifier"].as_str().expect("tauri.conf.json names an identifier").to_string()
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn falls_back_to_the_configured_identifier() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(super::identifier(), config["identifier"].as_str().unwrap());
    }
}
