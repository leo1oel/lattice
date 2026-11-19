//! Which app this binary is, read from its bundle's identifier
//! (`scripts/gpui-bundle.mjs --flavor`):
//!
//! - **Lattice Beta** (`app.leo1oel.lattice-beta`), installed beside the
//!   Tauri Lattice: its own name, data folder (`lattice-gpui`) and release
//!   channel, which it reads only once the writer turns on Beta updates. A
//!   binary outside a bundle (a build tree, the e2e) is this one too.
//! - **Lattice** (`app.leo1oel.researchwriter`, the Tauri app's own
//!   identifier), which the Tauri app's updater installs in place of the Tauri
//!   app on Apple silicon Macs: the Tauri app's name and feed, with updates
//!   always on as the Tauri app has them. Its data folder is new, so the
//!   carry-over from the Tauri app (`lattice_settings::migrate`) runs on its
//!   first launch even after Lattice Beta ran it into `lattice-gpui`, and the
//!   Tauri app's own folder (`app.leo1oel.researchwriter`) is only ever read,
//!   so a Tauri build that replaces this app again finds it as it left it.

use std::sync::OnceLock;

pub struct Flavor {
    /// The name the app shows for itself: its window titles, the app menu's
    /// About, Hide and Quit, the About panel, and what it says is not there
    /// yet.
    pub name: &'static str,
    /// Its folder under the user's data and cache folders.
    pub folder: &'static str,
    /// The release manifest its updater reads (`crate::updater`).
    pub endpoint: &'static str,
    /// Whether it is the Tauri app's successor, installed in its place: its
    /// updater is always on, as the Tauri app's is, and the launch that
    /// carries the Tauri app's state over announces the update (What's new).
    pub replaces_tauri: bool,
}

pub const BETA: Flavor = Flavor {
    name: "Lattice Beta",
    folder: "lattice-gpui",
    // The `lattice-beta` prerelease, which only Lattice Beta builds are
    // published to; a prerelease is never GitHub's latest release, so the
    // Tauri app's feed never sees it.
    endpoint: "https://github.com/leo1oel/lattice/releases/download/lattice-beta/latest.json",
    replaces_tauri: false,
};

pub const MAIN: Flavor = Flavor {
    name: "Lattice",
    folder: "app.leo1oel.lattice",
    // The Tauri app's feed (`plugins.updater.endpoints` in tauri.conf.json),
    // whose darwin-aarch64 entries point at this app from 0.19.0, so a later
    // release (or a Tauri build, to roll back) reaches it the same way.
    endpoint: "https://github.com/leo1oel/lattice/releases/latest/download/latest.json",
    replaces_tauri: true,
};

/// The bundle identifier this app ships as when it is Lattice itself.
const MAIN_IDENTIFIER: &str = lattice_settings::import::TAURI_BUNDLE_ID;

pub fn current() -> &'static Flavor {
    static CURRENT: OnceLock<&'static Flavor> = OnceLock::new();
    CURRENT.get_or_init(|| match bundle_identifier().as_deref() {
        Some(MAIN_IDENTIFIER) => &MAIN,
        _ => &BETA,
    })
}

#[cfg(target_os = "macos")]
fn bundle_identifier() -> Option<String> {
    use core_foundation::{bundle::CFBundle, string::CFString};
    CFBundle::main_bundle()
        .info_dictionary()
        .find(CFString::from_static_string("CFBundleIdentifier"))
        .and_then(|identifier| identifier.downcast::<CFString>())
        .map(|identifier| identifier.to_string())
}

#[cfg(not(target_os = "macos"))]
fn bundle_identifier() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lattice_follows_the_tauri_apps_feed_and_identifier() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../../../src-tauri/tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], MAIN_IDENTIFIER);
        assert_eq!(config["plugins"]["updater"]["endpoints"][0], MAIN.endpoint);
        assert_eq!(config["productName"], MAIN.name);
    }

    #[test]
    fn neither_app_keeps_its_data_in_the_tauri_apps_folder() {
        for flavor in [&BETA, &MAIN] {
            assert_ne!(flavor.folder, MAIN_IDENTIFIER);
        }
        assert_ne!(BETA.folder, MAIN.folder);
        assert!(!BETA.endpoint.contains("/latest/download/"));
    }

    #[test]
    fn a_binary_outside_a_bundle_is_lattice_beta() {
        assert_eq!(current().name, BETA.name);
    }
}
