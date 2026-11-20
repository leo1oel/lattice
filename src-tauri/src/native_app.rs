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

/// The native feed, asked in order: the repository's home in the
/// lattice-writer organization, then its address before the move. GitHub
/// redirects the old address only while nobody recreates it, so a copy that
/// asks the new one first does not depend on that. The updater moves on to
/// the next address when one fails or does not answer 2xx, and trusts only
/// the pinned key's signature, never the address.
const NATIVE_FEEDS: [&str; 2] = [
    "https://github.com/lattice-writer/lattice/releases/latest/download/latest-native.json",
    "https://github.com/leo1oel/lattice/releases/latest/download/latest-native.json",
];
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

/// The feeds to ask: the release feeds, unless a rehearsal names another.
fn native_feeds(override_endpoint: Option<String>) -> Result<Vec<Url>, String> {
    match override_endpoint.filter(|endpoint| !endpoint.trim().is_empty()) {
        Some(endpoint) => Url::parse(endpoint.trim()).map(|url| vec![url]),
        None => NATIVE_FEEDS.into_iter().map(Url::parse).collect(),
    }
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
    let feeds = native_feeds(std::env::var(NATIVE_FEED_OVERRIDE).ok())?;
    let update = webview
        .updater_builder()
        .endpoints(feeds)
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
    use super::{native_feeds, NATIVE_FEEDS, SUPPORTED};

    fn addresses(feeds: Vec<tauri::Url>) -> Vec<String> {
        feeds.into_iter().map(String::from).collect()
    }

    #[test]
    fn the_release_feeds_unless_a_rehearsal_names_another() {
        assert_eq!(addresses(native_feeds(None).unwrap()), NATIVE_FEEDS);
        // An empty variable is no override: the shell left it set but blank.
        assert_eq!(addresses(native_feeds(Some("  ".into())).unwrap()), NATIVE_FEEDS);
        assert_eq!(
            addresses(
                native_feeds(Some(" http://127.0.0.1:8123/latest-native.json ".into())).unwrap()
            ),
            ["http://127.0.0.1:8123/latest-native.json"]
        );
        assert!(native_feeds(Some("not a url".into())).is_err());
    }

    #[test]
    fn the_new_home_is_asked_before_the_old_address() {
        assert!(NATIVE_FEEDS[0].starts_with("https://github.com/lattice-writer/lattice/"));
        assert_eq!(NATIVE_FEEDS[1], NATIVE_FEEDS[0].replace("/lattice-writer/", "/leo1oel/"));
    }

    #[test]
    fn only_apple_silicon_macs_are_offered_the_native_app() {
        assert_eq!(SUPPORTED, cfg!(all(target_os = "macos", target_arch = "aarch64")));
        assert_eq!(super::native_app_supported(), SUPPORTED);
    }
}
