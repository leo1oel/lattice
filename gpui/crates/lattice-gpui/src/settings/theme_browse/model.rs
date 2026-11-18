//! What Browse themes shows, decided apart from drawing it, the way
//! theme-registry.ts and theme-browse.tsx decide it: which rows a search
//! keeps, what each row offers, and the status line.

use lattice_core::registry::{BlockedEntry, IndexTheme, Listing, Status};
use lattice_core::themes::ThemeInfo;
use unicode_normalization::UnicodeNormalization as _;

#[derive(Clone, Debug, PartialEq)]
pub enum RowAction {
    Install,
    Installed,
    Update(String),
    Blocked(BlockedEntry),
}

/// What a row offers for `theme`, given the list and the themes installed
/// here (`rowAction`).
pub fn row_action(theme: &IndexTheme, listing: &Listing, installed: &[ThemeInfo]) -> RowAction {
    if let Some(entry) = listing.blocked_offers.get(&theme.id) {
        return RowAction::Blocked(entry.clone());
    }
    let record = listing.installed.iter().find(|item| item.id == theme.id);
    if let Some(version) = record.and_then(|record| record.update.clone()) {
        return RowAction::Update(version);
    }
    let here = installed
        .iter()
        .any(|item| item.id == theme.id && item.version == theme.version);
    if record.is_some() || here {
        RowAction::Installed
    } else {
        RowAction::Install
    }
}

fn fold(text: &str) -> String {
    text.nfkc().collect::<String>().to_lowercase()
}

/// Whether every word of `query` is in the theme's name, description or
/// author, as substrings, so text without spaces between words (Chinese,
/// Japanese) matches anywhere (`matchesQuery`).
pub fn matches(theme: &IndexTheme, query: &str) -> bool {
    let haystack = fold(
        &[
            theme.name.as_str(),
            theme.description.as_deref().unwrap_or(""),
            theme.author.as_deref().unwrap_or(""),
        ]
        .join("\n"),
    );
    fold(query)
        .split_whitespace()
        .all(|word| haystack.contains(word))
}

/// The status line under the search field (theme-browse.tsx `StatusLine`).
#[derive(Clone, Debug, PartialEq)]
pub enum Line {
    Loading,
    /// When the shown list was fetched (RFC 3339).
    Updated(String),
    /// The cached list's fetch time, when there is one.
    Offline(Option<String>),
    Refused,
    Nothing,
}

pub fn status_line(listing: Option<&Listing>, refreshing: bool) -> Line {
    let has_index = listing.is_some_and(|listing| listing.index.is_some());
    if refreshing && !has_index {
        return Line::Loading;
    }
    let Some(listing) = listing else {
        return Line::Nothing;
    };
    match (&listing.status, &listing.fetched_at) {
        (Status::Refused { .. }, _) => Line::Refused,
        (Status::Offline { .. }, fetched) => Line::Offline(fetched.clone()),
        (_, Some(fetched)) => Line::Updated(fetched.clone()),
        (_, None) => Line::Nothing,
    }
}

/// Whether installing is allowed: not while the list fails verification.
pub fn installable(listing: &Listing) -> bool {
    !matches!(listing.status, Status::Refused { .. })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lattice_core::registry::{Index, InstalledTheme};

    fn theme(id: &str, name: &str, description: &str) -> IndexTheme {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": name, "version": "1.0.0", "author": "Example", "license": "MIT",
            "description": description, "repository": "https://github.com/example/themes",
            "tag": "v1.0.0", "commit": "0", "path": "theme.json",
            "url": "https://example.com/theme.json", "sha256": "0", "size": 1,
            "variants": [{ "id": "night", "appearance": "dark", "colors": { "chrome": "#101018" } }],
        }))
        .unwrap()
    }

    fn listing(status: Status) -> Listing {
        Listing {
            index: Some(Index {
                format: 1,
                serial: 1,
                generated: "2026-11-18T12:00:00Z".into(),
                themes: vec![theme("dev.example.ink", "Ink", "墨色的深夜主题")],
            }),
            blocked: Vec::new(),
            blocked_offers: Default::default(),
            fetched_at: Some("2026-11-18T12:00:00Z".into()),
            status,
            installed: Vec::new(),
        }
    }

    #[test]
    fn search_matches_substrings_of_name_description_and_author() {
        let ink = theme("dev.example.ink", "Ink", "墨色的深夜主题");
        assert!(matches(&ink, "深夜"));
        assert!(matches(&ink, "INK example"));
        assert!(matches(&ink, "ｉｎｋ"));
        assert!(!matches(&ink, "harbor"));
        assert!(matches(&ink, "  "));
    }

    #[test]
    fn a_row_offers_install_installed_update_or_blocked() {
        let ink = theme("dev.example.ink", "Ink", "");
        let mut list = listing(Status::Fresh);
        assert_eq!(row_action(&ink, &list, &[]), RowAction::Install);
        list.installed.push(InstalledTheme {
            id: ink.id.clone(),
            version: "0.9.0".into(),
            update: Some("1.0.0".into()),
            blocked: None,
        });
        assert_eq!(
            row_action(&ink, &list, &[]),
            RowAction::Update("1.0.0".into())
        );
        list.installed[0].update = None;
        assert_eq!(row_action(&ink, &list, &[]), RowAction::Installed);
        let entry = BlockedEntry {
            id: ink.id.clone(),
            versions: "*".into(),
            action: "disable".into(),
            reason: "Phishes.".into(),
            url: None,
        };
        list.blocked_offers.insert(ink.id.clone(), entry.clone());
        assert_eq!(row_action(&ink, &list, &[]), RowAction::Blocked(entry));
    }

    #[test]
    fn the_status_line_follows_the_refresh() {
        assert_eq!(status_line(None, true), Line::Loading);
        let fresh = listing(Status::Fresh);
        assert_eq!(
            status_line(Some(&fresh), true),
            Line::Updated("2026-11-18T12:00:00Z".into())
        );
        let offline = listing(Status::Offline {
            message: "HTTP 404".into(),
        });
        assert_eq!(
            status_line(Some(&offline), false),
            Line::Offline(offline.fetched_at.clone())
        );
        let refused = listing(Status::Refused {
            message: "bad".into(),
        });
        assert_eq!(status_line(Some(&refused), false), Line::Refused);
        assert!(!installable(&refused) && installable(&fresh));
    }
}
