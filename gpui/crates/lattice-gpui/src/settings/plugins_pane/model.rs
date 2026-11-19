//! What Settings › Plugins › Browse shows, decided apart from drawing it,
//! the way `plugin-registry.ts` decides it in the Tauri app: which plugins a
//! search keeps and in what order, what each listed plugin offers, and
//! which updates Update all applies.

use lattice_core::plugins::{Permissions, PluginInfo};
use lattice_core::registry::{BlockedEntry, IndexPlugin, PluginListing, Status};
use unicode_normalization::UnicodeNormalization as _;

/// Browse's order (`PluginSort`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sort {
    Popular,
    Recent,
    Name,
}

/// What Browse offers for a listed plugin (`PluginOffer`).
#[derive(Clone, Debug)]
pub enum Offer {
    Install,
    Installed(PluginInfo),
    Update {
        info: PluginInfo,
        version: String,
        /// What the update asks for beyond the current grant.
        asks: Permissions,
    },
    Blocked(BlockedEntry),
}

fn fold(text: &str) -> String {
    text.nfkc().collect::<String>().to_lowercase()
}

/// Whether every word of `query` is in `fields`, as substrings, so text
/// without spaces between words (Chinese, Japanese) matches anywhere
/// (`matchesPluginQuery`).
pub fn matches<'a>(fields: impl IntoIterator<Item = &'a str>, query: &str) -> bool {
    let haystack = fold(&fields.into_iter().collect::<Vec<_>>().join("\n"));
    fold(query)
        .split_whitespace()
        .all(|word| haystack.contains(word))
}

/// A listed plugin's searchable text: name, description, author, id and
/// categories.
pub fn listed_matches(plugin: &IndexPlugin, query: &str) -> bool {
    let fields = [
        plugin.name.as_str(),
        plugin.description.as_deref().unwrap_or(""),
        plugin.author.as_deref().unwrap_or(""),
        plugin.id.as_str(),
    ];
    matches(
        fields
            .into_iter()
            .chain(plugin.categories.iter().map(String::as_str)),
        query,
    )
}

/// An installed plugin's searchable text: name, description and id.
pub fn installed_matches(plugin: &PluginInfo, query: &str) -> bool {
    matches(
        [
            plugin.name.as_str(),
            plugin.description.as_deref().unwrap_or(""),
            plugin.id.as_str(),
        ],
        query,
    )
}

/// The list in Browse's order: most downloads, most recently published, or
/// by name, ties by name (`sortPlugins`).
pub fn sorted(plugins: &[IndexPlugin], sort: Sort) -> Vec<IndexPlugin> {
    let mut ordered = plugins.to_vec();
    let by_name = |a: &IndexPlugin, b: &IndexPlugin| a.name.cmp(&b.name);
    match sort {
        Sort::Popular => ordered.sort_by(|a, b| {
            b.downloads
                .unwrap_or(0)
                .cmp(&a.downloads.unwrap_or(0))
                .then_with(|| by_name(a, b))
        }),
        Sort::Recent => ordered.sort_by(|a, b| {
            b.updated
                .as_deref()
                .unwrap_or("")
                .cmp(a.updated.as_deref().unwrap_or(""))
                .then_with(|| by_name(a, b))
        }),
        Sort::Name => ordered.sort_by(by_name),
    }
    ordered
}

/// What Browse offers for `plugin`, given the plugins installed here from
/// any source (`pluginOffer`).
pub fn offer(plugin: &IndexPlugin, listing: &PluginListing, installed: &[PluginInfo]) -> Offer {
    let entry = listing.blocked_offers.get(&plugin.id);
    let info = installed.iter().find(|item| item.id == plugin.id);
    let Some(info) = info else {
        return match entry.filter(|entry| entry.action != "warn") {
            Some(entry) => Offer::Blocked(entry.clone()),
            None => Offer::Install,
        };
    };
    let record = listing.installed.iter().find(|item| item.id == plugin.id);
    match record.and_then(|record| Some((record.update.clone()?, record.update_asks.clone()))) {
        Some((version, asks)) => Offer::Update {
            info: info.clone(),
            version,
            asks,
        },
        None => Offer::Installed(info.clone()),
    }
}

/// The newer version the list offers for an installed plugin, and what it
/// asks for beyond the current grant.
pub fn update_of(listing: Option<&PluginListing>, id: &str) -> Option<(String, Permissions)> {
    let record = listing?.installed.iter().find(|item| item.id == id)?;
    Some((record.update.clone()?, record.update_asks.clone()))
}

/// The installed plugins Update all applies: those whose update asks for
/// nothing new and that the block list leaves alone.
pub fn quiet_updates(listing: Option<&PluginListing>, installed: &[PluginInfo]) -> Vec<String> {
    installed
        .iter()
        .filter(|plugin| plugin.blocked.is_none())
        .filter(|plugin| {
            update_of(listing, &plugin.id).is_some_and(|(_, asks)| asks_nothing(&asks))
        })
        .map(|plugin| plugin.id.clone())
        .collect()
}

/// Whether a permission set grants nothing.
pub fn asks_nothing(permissions: &Permissions) -> bool {
    permissions.project_read.is_empty()
        && permissions.network_local.is_empty()
        && permissions.network.is_empty()
        && permissions.secrets.is_empty()
}

/// Whether the list can install: verified, and not refused.
pub fn installable(listing: &PluginListing) -> bool {
    listing.verified && !matches!(listing.status, Status::Refused { .. })
}

/// A blocked entry that turns a plugin off, rather than warning.
pub fn turns_off(entry: &BlockedEntry) -> bool {
    entry.action != "warn"
}

/// `1.2K` downloads in the interface language's compact form, as
/// `Intl.NumberFormat(..., { notation: "compact" })` writes it: two
/// significant digits past the first unit, thousands in English and
/// ten-thousands (万) in Chinese.
pub fn compact_count(count: u64, chinese: bool) -> String {
    let units: &[(f64, &str)] = if chinese {
        &[(1e8, "亿"), (1e4, "万")]
    } else {
        &[(1e9, "B"), (1e6, "M"), (1e3, "K")]
    };
    let value = count as f64;
    for (size, suffix) in units {
        if value >= *size {
            let scaled = value / size;
            let text = if scaled < 10. {
                let rounded = (scaled * 10.).round() / 10.;
                if rounded.fract() == 0. {
                    format!("{rounded:.0}")
                } else {
                    format!("{rounded:.1}")
                }
            } else {
                format!("{:.0}", scaled.round())
            };
            return format!("{text}{suffix}");
        }
    }
    count.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use lattice_core::registry::InstalledPlugin;

    fn listed(id: &str, name: &str, downloads: u64, updated: &str) -> IndexPlugin {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": name, "version": "0.2.0", "api": 1, "runtime": "node", "license": "MIT",
            "author": "Ada", "description": "查找参考文献的 DOI", "repository": "https://github.com/example/p",
            "commit": "0", "categories": ["citations"], "url": "https://example.org/p.zip", "sha256": "0", "size": 1,
            "downloads": downloads, "updated": updated,
        }))
        .unwrap()
    }

    fn info(id: &str) -> PluginInfo {
        PluginInfo {
            id: id.into(),
            name: "P".into(),
            version: "0.1.0".into(),
            description: None,
            license: "MIT".into(),
            repository: None,
            runtime: lattice_core::plugins::Runtime::Node,
            source: lattice_core::plugins::Source::Registry {
                url: "https://example.org/p.zip".into(),
                sha256: "0".into(),
            },
            enabled: true,
            permissions: Permissions::default(),
            granted: None,
            needs_review: false,
            commands: Vec::new(),
            secrets: Vec::new(),
            error: None,
            blocked: None,
        }
    }

    fn listing(plugins: Vec<IndexPlugin>) -> PluginListing {
        PluginListing {
            plugins,
            verified: true,
            blocked_offers: Default::default(),
            fetched_at: Some("2026-11-19T00:00:00Z".into()),
            status: Status::Fresh,
            installed: Vec::new(),
        }
    }

    #[test]
    fn search_reaches_categories_and_text_without_spaces() {
        let plugin = listed("dev.example.doi", "DOI lookup", 1, "");
        assert!(listed_matches(&plugin, "参考"));
        assert!(listed_matches(&plugin, "ada CITATIONS"));
        assert!(!listed_matches(&plugin, "zotero"));
    }

    #[test]
    fn sorts_by_downloads_date_or_name() {
        let a = listed("a", "Alpha", 40, "2026-11-10");
        let b = listed("b", "Beta", 1200, "2026-11-01");
        let ids = |sort| {
            sorted(&[a.clone(), b.clone()], sort)
                .into_iter()
                .map(|p| p.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(Sort::Popular), ["b", "a"]);
        assert_eq!(ids(Sort::Recent), ["a", "b"]);
        assert_eq!(ids(Sort::Name), ["a", "b"]);
    }

    #[test]
    fn offers_install_update_installed_or_blocked() {
        let plugin = listed("dev.example.doi", "DOI", 1, "");
        let mut list = listing(vec![plugin.clone()]);
        assert!(matches!(offer(&plugin, &list, &[]), Offer::Install));
        let here = [info(&plugin.id)];
        assert!(matches!(offer(&plugin, &list, &here), Offer::Installed(_)));
        let asks = Permissions {
            network: vec!["https://api.crossref.org".into()],
            ..Default::default()
        };
        list.installed.push(InstalledPlugin {
            id: plugin.id.clone(),
            version: "0.1.0".into(),
            update: Some("0.2.0".into()),
            update_asks: asks.clone(),
            blocked: None,
        });
        match offer(&plugin, &list, &here) {
            Offer::Update {
                version,
                asks: wanted,
                ..
            } => {
                assert_eq!(version, "0.2.0");
                assert_eq!(wanted, asks);
            }
            other => panic!("{other:?}"),
        }
        assert!(
            quiet_updates(Some(&list), &here).is_empty(),
            "it asks for more"
        );
        list.installed[0].update_asks = Permissions::default();
        assert_eq!(
            quiet_updates(Some(&list), &here),
            std::slice::from_ref(&plugin.id)
        );
        let entry = BlockedEntry {
            id: plugin.id.clone(),
            versions: "*".into(),
            action: "disable".into(),
            reason: "Sends text off the machine.".into(),
            url: None,
        };
        list.blocked_offers.insert(plugin.id.clone(), entry.clone());
        assert!(matches!(offer(&plugin, &list, &[]), Offer::Blocked(_)));
        list.status = Status::Refused {
            message: "bad".into(),
        };
        assert!(!installable(&list));
    }

    #[test]
    fn counts_downloads_compactly() {
        assert_eq!(compact_count(312, false), "312");
        assert_eq!(compact_count(1840, false), "1.8K");
        assert_eq!(compact_count(5210, false), "5.2K");
        assert_eq!(compact_count(12_345, false), "12K");
        assert_eq!(compact_count(2_000_000, false), "2M");
        assert_eq!(compact_count(1840, true), "1840");
        assert_eq!(compact_count(12_345, true), "1.2万");
    }
}
