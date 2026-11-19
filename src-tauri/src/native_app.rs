//! The native Lattice, offered from here on Apple silicon.
//!
//! Each release also carries the native (GPUI) app for Apple-silicon Macs, with
//! its own updater feed (`latest-native.json`) beside this app's. Switching to
//! it is the writer's choice: the offer dialog asks `check_native_app`, which
//! finds the native release and leaves it in the window's resources table the
//! way the updater plugin's own `check` does, so the same claim, install and
//! restart path (`app_restart.rs`, `restart_lattice`) puts it in place of
//! this bundle. The native archive unpacks to Lattice.app with this app's
//! bundle identifier, so the updater replaces the bundle at the same path.
//!
//! Both apps share version numbers (0.19.0 is both), so the check accepts any
//! version the feed names: switching is never an "update" in the semver sense.
//! The signature is still checked against the pinned updater key, which is why
//! a rehearsal may point `LATTICE_NATIVE_UPDATER_ENDPOINT` at another feed.

use std::time::Duration;

use tauri::{Manager, ResourceId, Url, Webview};
use tauri_plugin_updater::UpdaterExt;

/// Only Apple-silicon Macs get the native app; Intel Macs, Windows and Linux
/// never hear of it (Linux does not even register the updater plugin).
const SUPPORTED: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"));

const NATIVE_FEED: &str =
    "https://github.com/leo1oel/lattice/releases/latest/download/latest-native.json";
const NATIVE_FEED_OVERRIDE: &str = "LATTICE_NATIVE_UPDATER_ENDPOINT";

/// A check that hangs must not leave the offer dialog spinning.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// The native release a check found, held under `rid` for `install_update`.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAppRelease {
    version: String,
    rid: ResourceId,
}

/// The feed to ask: the release feed, unless a rehearsal names another.
fn native_feed(override_endpoint: Option<String>) -> Result<Url, String> {
    let endpoint = override_endpoint.filter(|endpoint| !endpoint.trim().is_empty());
    Url::parse(endpoint.as_deref().map_or(NATIVE_FEED, str::trim))
        .map_err(|error| error.to_string())
}

/// Whether this build may offer the native app at all; the page asks before
/// drawing the Settings row, which must not wait on the network.
#[tauri::command]
pub fn native_app_supported() -> bool {
    SUPPORTED
}

/// The native release to switch to, or null off Apple silicon and when the
/// feed has nothing for darwin-aarch64.
#[tauri::command]
pub async fn check_native_app(webview: Webview) -> Result<Option<NativeAppRelease>, String> {
    if !SUPPORTED {
        return Ok(None);
    }
    let feed = native_feed(std::env::var(NATIVE_FEED_OVERRIDE).ok())?;
    let update = webview
        .updater_builder()
        .endpoints(vec![feed])
        .and_then(|builder| builder.version_comparator(|_, _| true).timeout(CHECK_TIMEOUT).build())
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(update.map(|update| NativeAppRelease {
        version: update.version.clone(),
        rid: webview.resources_table().add(update),
    }))
}

#[cfg(test)]
mod tests {
    use super::{native_feed, NATIVE_FEED, SUPPORTED};

    #[test]
    fn the_release_feed_unless_a_rehearsal_names_another() {
        assert_eq!(native_feed(None).unwrap().as_str(), NATIVE_FEED);
        // An empty variable is no override: the shell left it set but blank.
        assert_eq!(native_feed(Some("  ".into())).unwrap().as_str(), NATIVE_FEED);
        assert_eq!(
            native_feed(Some(" http://127.0.0.1:8123/latest-native.json ".into()))
                .unwrap()
                .as_str(),
            "http://127.0.0.1:8123/latest-native.json"
        );
        assert!(native_feed(Some("not a url".into())).is_err());
    }

    #[test]
    fn only_apple_silicon_macs_are_offered_the_native_app() {
        assert_eq!(SUPPORTED, cfg!(all(target_os = "macos", target_arch = "aarch64")));
        assert_eq!(super::native_app_supported(), SUPPORTED);
    }
}
