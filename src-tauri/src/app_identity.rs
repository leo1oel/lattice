//! The bundle identifier this build was configured with.
//!
//! Tauri's own `app_data_dir`/`app_cache_dir` already follow the configured
//! identifier, but a few paths are needed where no `AppHandle` reaches (tool
//! directories, the literature keychain item). They derive from this instead of
//! a literal, so a build with another identifier — the perf lab's
//! `tauri build --config` override — never reads or writes the shipped app's
//! tools, caches or keychain item.
//!
//! Lattice Beta is the same pairing on purpose: `LATTICE_FLAVOR=beta` for the
//! code (its own browser port) and `--config tauri.beta.conf.json` for the
//! identity. `init` refuses a build that has one without the other.

use std::sync::OnceLock;

static IDENTIFIER: OnceLock<String> = OnceLock::new();

/// Record the identifier from the generated Tauri context; `run` calls this
/// before anything can ask for it.
pub(crate) fn init(identifier: &str) {
    if let Some(mismatch) = flavor_mismatch(identifier, cfg!(lattice_beta)) {
        panic!("{mismatch}");
    }
    let _ = IDENTIFIER.set(identifier.to_string());
}

fn configured_identifier(config: &str) -> String {
    let config: serde_json::Value =
        serde_json::from_str(config).expect("Tauri config is valid JSON");
    config["identifier"].as_str().expect("Tauri config names an identifier").to_string()
}

/// A Beta binary under the release identity would share the installed app's
/// data, tools and keychain item; a release binary under Beta's would contend
/// for the release app's browser port.
fn flavor_mismatch(identifier: &str, beta: bool) -> Option<&'static str> {
    let release = configured_identifier(include_str!("../tauri.conf.json"));
    let beta_identifier = configured_identifier(include_str!("../tauri.beta.conf.json"));
    if beta && identifier == release {
        Some("LATTICE_FLAVOR=beta needs `--config src-tauri/tauri.beta.conf.json`")
    } else if !beta && identifier == beta_identifier {
        Some("src-tauri/tauri.beta.conf.json needs LATTICE_FLAVOR=beta")
    } else {
        None
    }
}

/// The configured identifier. Outside `run` (unit tests) it is the one in
/// tauri.conf.json, which is what every path here meant before.
pub(crate) fn identifier() -> &'static str {
    IDENTIFIER.get_or_init(|| configured_identifier(include_str!("../tauri.conf.json")))
}

#[cfg(test)]
mod tests {
    #[test]
    fn falls_back_to_the_configured_identifier() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(super::identifier(), config["identifier"].as_str().unwrap());
    }

    #[test]
    fn a_flavor_runs_only_under_its_own_identity() {
        let release = "app.leo1oel.researchwriter";
        let beta = "app.leo1oel.researchwriter.beta";
        assert_eq!(super::flavor_mismatch(release, false), None);
        assert_eq!(super::flavor_mismatch(beta, true), None);
        assert!(super::flavor_mismatch(release, true).is_some());
        assert!(super::flavor_mismatch(beta, false).is_some());
        // The perf lab's `--config` identifier runs either flavor.
        assert_eq!(super::flavor_mismatch("app.latticetest.my-task", false), None);
    }
}
