//! Where an island's frames may go: its own bundle, an empty or srcdoc
//! document, and the origins its owner allows (the slides island's Open
//! Slide runtime). Everything else, a project file loaded as a document
//! included, is refused by the webview's navigation handler.

use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};

use crate::protocol;

/// The origins an island's frames may load besides its own bundle, shared
/// with the webview's navigation handler.
pub(crate) type FrameOrigins = Arc<Mutex<BTreeSet<String>>>;

/// Whether a frame may navigate to `url`: the island's own bundle, or an
/// empty or srcdoc document, its fragment included (an authored page's hash
/// routing).
pub(crate) fn navigable(url: &str) -> bool {
    let document = url.split('#').next().unwrap_or_default();
    document.starts_with(&protocol::url("bundle/"))
        || matches!(document, "about:blank" | "about:srcdoc")
}

/// `scheme://host[:port]` of a URL, or an empty string for one without
/// an authority.
pub(crate) fn origin_of(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return String::new();
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    // Credentials in a URL would let `http://127.0.0.1:1@evil.example`
    // pass for the loopback origin: refuse them outright.
    if authority.is_empty() || authority.contains('@') {
        return String::new();
    }
    format!(
        "{}://{}",
        scheme.to_ascii_lowercase(),
        authority.to_ascii_lowercase()
    )
}

/// `origin` itself when it is exactly an origin (`scheme://host[:port]`,
/// nothing after it), lowercased.
pub(crate) fn exact_origin(origin: &str) -> Option<String> {
    let normalized = origin_of(origin);
    let scheme = normalized.split("://").next().unwrap_or_default();
    (!normalized.is_empty()
        && matches!(scheme, "http" | "https")
        && origin
            .trim_end_matches('/')
            .eq_ignore_ascii_case(&normalized))
    .then_some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_navigate_only_within_the_island() {
        assert!(navigable(&protocol::url("bundle/html-preview/index.html")));
        assert!(navigable("about:blank"));
        assert!(navigable("about:srcdoc"));
        assert!(navigable("about:srcdoc#section-2"));
        assert!(navigable("about:blank#top"));
        assert!(!navigable(&protocol::asset_url("x.svg")));
        assert!(!navigable(&format!(
            "{}#bundle/",
            protocol::asset_url("x.svg")
        )));
        assert!(!navigable("about:srcdocx"));
        assert!(!navigable("https://example.com/"));
        assert!(!navigable("javascript:alert(1)"));
    }

    #[test]
    fn frame_origins_match_exactly() {
        assert_eq!(
            exact_origin("http://127.0.0.1:52011"),
            Some("http://127.0.0.1:52011".into())
        );
        assert_eq!(
            exact_origin("http://127.0.0.1:52011/"),
            Some("http://127.0.0.1:52011".into())
        );
        assert_eq!(exact_origin("http://127.0.0.1:52011/s/deck"), None);
        assert_eq!(exact_origin("javascript://x"), None);
        assert_eq!(exact_origin("lattice://island"), None);
        assert_eq!(exact_origin("http://a@127.0.0.1:52011"), None);
        assert_eq!(
            origin_of("http://127.0.0.1:52011/__lattice/bootstrap?token=x#p"),
            "http://127.0.0.1:52011"
        );
        // A different port, or credentials that hide another host, are not it.
        assert_ne!(
            origin_of("http://127.0.0.1:52012/s/deck"),
            "http://127.0.0.1:52011"
        );
        assert_eq!(origin_of("http://127.0.0.1:52011@evil.example/"), "");
        assert_eq!(origin_of("about:blank"), "");
    }
}
