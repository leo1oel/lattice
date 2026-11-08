//! Which popup a workspace window lets open as a child window: Open Slide's
//! presenter view, and nothing else.

// Presenter and projection synchronize through BroadcastChannel, so this must
// remain a Wry child window sharing its opener's WebView configuration. An
// external browser can load the notes but cannot stay linked to the slideshow.
pub(crate) fn is_presenter_url(url: &tauri::Url) -> bool {
    let query =
        |name: &str| url.query_pairs().find_map(|(key, value)| (key == name).then_some(value));
    let presenter_path = |next: &str| {
        next.strip_prefix("/s/")
            .and_then(|path| path.strip_suffix("/presenter"))
            .is_some_and(|deck_id| !deck_id.is_empty() && !deck_id.contains('/'))
    };
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.path() == "/__lattice/bootstrap"
        && query("token").is_some_and(|token| !token.is_empty())
        && query("next").is_some_and(|next| presenter_path(&next))
}

#[cfg(test)]
mod tests {
    use super::is_presenter_url;

    #[test]
    fn only_authenticated_loopback_presenter_pages_can_open_popup_windows() {
        let allowed: tauri::Url = "http://127.0.0.1:43123/__lattice/bootstrap?token=session-secret&next=%2Fs%2Ftalk%2Fpresenter"
            .parse()
            .unwrap();
        assert!(is_presenter_url(&allowed));

        for rejected in [
            "https://example.com/__lattice/bootstrap?token=session-secret&next=%2Fs%2Ftalk%2Fpresenter",
            "http://127.0.0.1:43123/__lattice/bootstrap?next=%2Fs%2Ftalk%2Fpresenter",
            "http://127.0.0.1:43123/__lattice/bootstrap?token=session-secret&next=%2Fs%2Ftalk",
            "http://127.0.0.1:43123/__lattice/bootstrap?token=session-secret&next=%2Fsettings",
        ] {
            assert!(!is_presenter_url(&rejected.parse().unwrap()), "{rejected}");
        }
    }
}
