//! Lattice ▸ About Lattice and Help's project links: the repository and the
//! website, opened in the default browser.

use std::sync::Mutex;

use tauri::menu::MenuItem;
use tauri::{AppHandle, Runtime};

/// The menu id of Lattice ▸ About Lattice.
const ABOUT: &str = "about";
/// Menu ids of Help's project links; the part after the prefix is the URL.
const OPEN_LINK_PREFIX: &str = "open-link:";
const REPOSITORY_URL: &str = "https://github.com/leo1oel/lattice";
const WEBSITE_URL: &str = "https://leo1oel.github.io/lattice/";

/// The attribution Trellis's license asks shipped apps to show.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const TRELLIS_ATTRIBUTION: &str =
    "Uses Trellis by DanFessler - github.com/DanFessler/trellis";

/// The link titles (website, repository) from the last menu labels sent, in
/// the interface language, for the About panel.
static LINK_TITLES: Mutex<Option<(String, String)>> = Mutex::new(None);

/// Lattice ▸ About Lattice. Not the predefined item, whose credits cannot
/// carry links (macos_about.rs).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn about_item<R: Runtime>(
    app: &AppHandle<R>, title: &str, website: &str, github: &str,
) -> tauri::Result<MenuItem<R>> {
    *LINK_TITLES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) =
        Some((website.to_string(), github.to_string()));
    MenuItem::with_id(app, ABOUT, title, true, None::<&str>)
}

/// Help ▸ Lattice Website and Lattice on GitHub.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn help_items<R: Runtime>(
    app: &AppHandle<R>, website: &str, github: &str,
) -> tauri::Result<[MenuItem<R>; 2]> {
    let link = |url: &str, title: &str| {
        MenuItem::with_id(app, format!("{OPEN_LINK_PREFIX}{url}"), title, true, None::<&str>)
    };
    Ok([link(WEBSITE_URL, website)?, link(REPOSITORY_URL, github)?])
}

/// Run the About or link item `id`; false when `id` is neither.
pub(crate) fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    if id == ABOUT {
        show_about(app);
    } else if let Some(url) = id.strip_prefix(OPEN_LINK_PREFIX) {
        use tauri_plugin_opener::OpenerExt;
        if let Err(error) = app.opener().open_url(url, None::<&str>) {
            tracing::warn!(%error, url, "could not open a Help menu link");
        }
    } else {
        return false;
    }
    true
}

#[cfg(target_os = "macos")]
fn show_about<R: Runtime>(app: &AppHandle<R>) {
    let package = app.package_info();
    let titles = LINK_TITLES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let (website, github) = titles.unwrap_or_else(|| ("Website".into(), "GitHub".into()));
    // Trellis's license (commercial tier) requires this attribution; the
    // non-commercial tier asks for it too. See NOTICE.
    crate::macos_about::show(
        &package.name,
        &package.version.to_string(),
        TRELLIS_ATTRIBUTION,
        &[(&website, WEBSITE_URL), (&github, REPOSITORY_URL)],
    );
}

#[cfg(not(target_os = "macos"))]
fn show_about<R: Runtime>(_app: &AppHandle<R>) {}
