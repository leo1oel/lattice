//! Which app this binary is, read from its bundle's identifier
//! (`scripts/gpui-bundle.mjs --flavor`):
//!
//! - **Lattice Beta** (`app.leo1oel.lattice-beta`), installed beside the
//!   Tauri Lattice: its own name, data folder (`lattice-gpui`) and release
//!   channel, which it reads only once the writer turns on Beta updates. A
//!   binary outside a bundle (a build tree, the e2e) is this one too.
//! - **Lattice** (`app.leo1oel.researchwriter`, the Tauri app's own
//!   identifier), the native Lattice a writer on an Apple silicon Mac chooses
//!   to switch to: the Tauri app's updater installs it in place of the Tauri
//!   app when they ask, and its Settings switch back the same way
//!   (`crate::updater::switch_to_classic`). It has the Tauri app's name and
//!   its own feed beside the Tauri app's (`latest-native.json`), with updates
//!   always on as the Tauri app has them. Its data folder is new, so the
//!   carry-over from the Tauri app (`lattice_settings::migrate`) runs on its
//!   first launch even after Lattice Beta ran it into `lattice-gpui`, and the
//!   Tauri app's own folder (`app.leo1oel.researchwriter`) is only ever read,
//!   so the Tauri app finds it as it left it after a switch back.

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
    /// Whether it is the native Lattice, installed in the Tauri app's place
    /// by the writer's choice: its updater is always on, as the Tauri app's
    /// is; the launch that first carries the Tauri app's state over announces
    /// the update (What's new); a later switch from the Tauri app brings its
    /// recent projects (`crate::settings::migrate_from_tauri`); and Settings
    /// offers the switch back to the classic version.
    pub native_lattice: bool,
}

pub const BETA: Flavor = Flavor {
    name: "Lattice Beta",
    folder: "lattice-gpui",
    // The `lattice-beta` prerelease, which only Lattice Beta builds are
    // published to; a prerelease is never GitHub's latest release, so the
    // Tauri app's feed never sees it.
    endpoint: "https://github.com/leo1oel/lattice/releases/download/lattice-beta/latest.json",
    native_lattice: false,
};

pub const MAIN: Flavor = Flavor {
    name: "Lattice",
    folder: "app.leo1oel.lattice",
    // Its own manifest beside the Tauri app's `latest.json` in every release
    // (`plugins.updater.endpoints` in tauri.conf.json), which carries only
    // this app's Apple silicon archive. The Tauri app's feed stays the
    // Tauri app's; Settings reads it only to switch back
    // (`crate::updater::classic_channel`).
    endpoint: "https://github.com/leo1oel/lattice/releases/latest/download/latest-native.json",
    native_lattice: true,
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
    fn lattice_has_the_tauri_apps_identifier_and_a_feed_beside_its() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../../../src-tauri/tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], MAIN_IDENTIFIER);
        assert_eq!(config["productName"], MAIN.name);
        let classic = config["plugins"]["updater"]["endpoints"][0]
            .as_str()
            .unwrap();
        assert_ne!(classic, MAIN.endpoint);
        assert_eq!(
            classic.replace("/latest.json", "/latest-native.json"),
            MAIN.endpoint
        );
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
