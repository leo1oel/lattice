//! Settings search (`src/settings/settings-search-index.ts`): every setting
//! the GPUI app draws, in page order, with the words people search for that
//! its label does not say, ranked as the Tauri app ranks them.

use lattice_i18n::{t, tc};
use lattice_settings::{Choice as _, SettingsTab};

/// One searchable setting. `id` names the row it reveals; a page-level
/// entry has none and only opens its page.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub tab: SettingsTab,
    pub label: String,
    /// Where it lives, shown under the label.
    pub place: String,
    pub id: Option<&'static str>,
    pub terms: String,
    pub description: String,
}

impl Entry {
    fn page(tab: SettingsTab, label: &str, place: &str) -> Entry {
        Entry {
            tab,
            label: label.to_owned(),
            place: place.to_owned(),
            id: None,
            terms: String::new(),
            description: String::new(),
        }
    }

    fn row(tab: SettingsTab, place: &str, id: &'static str, label: &str) -> Entry {
        Entry {
            id: Some(id),
            ..Entry::page(tab, label, place)
        }
    }

    fn terms(mut self, terms: impl Into<String>) -> Entry {
        self.terms = terms.into();
        self
    }

    fn description(mut self, description: impl Into<String>) -> Entry {
        self.description = description.into();
        self
    }

    /// The same entry opened twice is revealed twice; two rows can share a
    /// label, so the key is the page and the row.
    pub fn key(&self) -> String {
        format!("{}:{}", self.tab.tag(), self.id.unwrap_or(""))
    }
}

/// The index in the interface language now.
pub fn entries(has_project: bool, known_author: Option<&str>) -> Vec<Entry> {
    use SettingsTab::{
        Acknowledgements, Agent, Api, Appearance, Doctor, Editor, Environment, Literature, Logs,
        Mcp, ModelEndpoint, Overleaf, Plugins, Usage,
    };
    let appearance = t!("Appearance");
    let editor = t!("Editor & builds");
    let builds = t!("Builds");
    let source = t!("Source editor");
    let prose = t!("Visual Markdown editor");
    let font_words = t!("font typeface text size spacing readability accessibility dyslexia");
    let source_terms = format!("{source} {font_words}");
    let prose_terms = format!("{prose} Markdown {font_words}");
    let mut out = vec![
        Entry::page(Appearance, appearance, t!("General")),
        Entry::row(
            Appearance,
            appearance,
            "interface-language",
            t!("Interface language"),
        )
        .terms(format!("{} {}", t!("English"), t!("Simplified Chinese"))),
        Entry::row(
            Appearance,
            appearance,
            "interface-size",
            t!("Interface size"),
        )
        .terms(format!("{} ⌘+ ⌘− ⌘0", t!("zoom scale bigger smaller"))),
        Entry::row(
            Appearance,
            appearance,
            "interface-sounds",
            t!("Interface sounds"),
        )
        .terms(t!("sound")),
        Entry::row(
            Appearance,
            appearance,
            "toast-position",
            t!("Notification position"),
        )
        .terms(format!(
            "{} {} {} {} {}",
            t!("Top right"),
            t!("Top center"),
            t!("Bottom right"),
            t!("Bottom center"),
            t!("toast notification")
        )),
        Entry::row(Appearance, source, "source-font", t!("Font")).terms(format!(
            "{source_terms} SF Mono Menlo Inter Atkinson Hyperlegible OpenDyslexic"
        )),
        Entry::row(Appearance, source, "editor-font-size", t!("Font size"))
            .terms(format!("{source_terms} {}", t!("Editor font size"))),
        Entry::row(Appearance, source, "source-line-height", t!("Line height"))
            .terms(source_terms.clone()),
        Entry::row(Appearance, prose, "prose-font", t!("Font")).terms(format!(
            "{prose_terms} SF Pro New York Georgia Atkinson Hyperlegible OpenDyslexic"
        )),
        Entry::row(Appearance, prose, "prose-font-size", t!("Font size"))
            .terms(prose_terms.clone()),
        Entry::row(Appearance, prose, "prose-line-height", t!("Line height"))
            .terms(prose_terms.clone()),
        Entry::row(Appearance, appearance, "color-theme", t!("Color theme")).terms(format!(
            "{} {} {}",
            t!("Theme"),
            t!("Light"),
            t!("Dark")
        )),
        Entry::row(Appearance, appearance, "theme-tint", t!("Tint")).terms(format!(
            "{} {} {} {} {} {}",
            t!("Theme"),
            t!("Graphite"),
            tc!("theme tint", "Paper"),
            t!("Sage"),
            t!("Mist"),
            t!("Dusk")
        )),
        Entry::row(Appearance, appearance, "theme-accent", t!("Accent")).terms(format!(
            "{} {} {}",
            t!("Theme"),
            t!("color"),
            t!("Custom")
        )),
        Entry::row(Appearance, appearance, "translucency", t!("Translucency"))
            .terms(t!("frosted glass transparent vibrancy desktop"))
            .description(format!(
                "{} {}",
                t!("Off while Reduce transparency is on in System Settings"),
                t!("Only in the Lattice window on macOS")
            )),
        Entry::row(Appearance, appearance, "code-theme", t!("Code theme")).terms(format!(
            "{} GitHub One Solarized Catppuccin Tokyo Night Dracula Nord Monokai {}",
            t!("Weft & Warp"),
            t!("syntax highlighting color scheme editor")
        )),
        Entry::row(
            Appearance,
            appearance,
            "code-theme-variant",
            t!("Light or dark"),
        )
        .terms(format!("{} {}", t!("Code theme"), t!("Match app"))),
        Entry::row(
            Appearance,
            appearance,
            "titlebar-tools",
            t!("Title bar tools"),
        ),
        Entry::page(Editor, editor, t!("General")),
        Entry::row(Editor, editor, "editor-keymap", t!("Editor keymap"))
            .terms(format!("Vim Emacs {}", t!("shortcuts"))),
        Entry::row(Editor, editor, "author-name", t!("Your name"))
            .terms(t!("Comments"))
            .description(t!(
                "Comments are signed {0}, from Git or Overleaf",
                known_author.unwrap_or("")
            )),
        Entry::row(Editor, editor, "spellcheck", t!("Check spelling"))
            .terms(format!("{} Harper Hunspell", t!("Check spelling in prose"))),
        Entry::row(Editor, editor, "spelling-languages", t!("Other languages")).terms(format!(
            "{} babel polyglossia Hunspell {}",
            t!("Check spelling"),
            t!("Downloaded dictionaries")
        )),
        Entry::row(
            Editor,
            editor,
            "project-dictionary",
            t!("Project dictionary"),
        )
        .terms("Harper")
        .description(t!("Open a project to add terms")),
        Entry::row(Editor, editor, "grammar-dialect", t!("English variant")).terms(format!(
            "{} {} {} Harper",
            t!("Grammar"),
            t!("American English"),
            t!("British English")
        )),
        Entry::row(Editor, editor, "grammar-style", t!("Grammar style"))
            .terms(format!(
                "{} {} {} Harper",
                t!("Grammar"),
                t!("Academic"),
                t!("Standard")
            ))
            .description(t!(
                "Automatic checks LaTeX as academic writing and other files as everyday prose"
            )),
        Entry::row(Editor, editor, "grammar-rules", t!("Grammar rules"))
            .terms(format!("{} Harper", t!("Grammar")))
            .description(t!("Filter to find a rule; these apply to every project")),
        Entry::row(Editor, editor, "grammar-ignored", t!("Ignored in this project"))
            .terms(format!("{} {} Harper", t!("Grammar"), t!("Ignored sentences")))
            .description(format!(
                "{} {}",
                t!("Open a project to ignore rules or sentences"),
                t!("Choose Ignore on a grammar suggestion to add one")
            )),
        Entry::row(Editor, editor, "auto-build", t!("Automatic build"))
            .terms(format!("{} ⌘S", t!("Manual only"))),
        Entry::row(Editor, editor, "aux-files", t!("Auxiliary files"))
            .terms(format!("{builds} {} .aux .log", t!("Clean"))),
        Entry::row(Editor, editor, "hidden-build-files", t!("Hide auxiliary files"))
            .terms(format!("{builds} .aux .log .synctex .research/build"))
            .description(t!("Keep .aux, .log, SyncTeX and other build files in the project’s hidden .research/build folder. The PDF stays beside the document. A document that fails there because a package ignores TeX’s output directory, such as minted 2.x, builds beside itself instead.")),
    ];
    if has_project {
        out.extend([
            Entry::row(Editor, editor, "compile-engine", t!("Compile engine"))
                .terms(format!("{builds} pdfLaTeX XeLaTeX LuaLaTeX latexmk"))
                .description(t!("A project latexmkrc overrides this")),
            Entry::row(Editor, editor, "shell-escape", t!("Allow shell escape")).terms(format!(
                "{builds} shell-escape {}",
                t!("Allow external commands")
            )),
            Entry::row(
                Editor,
                editor,
                "stop-on-first-error",
                t!("Stop on first error"),
            )
            .terms(format!("{builds} halt-on-error")),
        ]);
    }
    out.push(Entry::row(Editor, editor, "version", t!("Version")));
    let agent = t!("Agent");
    let endpoint = t!("Model endpoint");
    let environment = t!("Environment");
    out.extend([
        Entry::page(Agent, t!("Providers"), agent).terms(t!("Default provider")),
        Entry::page(Mcp, t!("MCP"), agent),
        Entry::page(Api, t!("Skills"), agent),
        Entry::page(Usage, t!("Usage & limits"), agent)
            .terms(t!("quota credits rate limit refresh")),
        Entry::page(ModelEndpoint, endpoint, agent).terms(format!(
            "OpenAI Anthropic Gemini Pi LLM {}",
            t!("own API base URL custom")
        )),
        Entry::row(
            ModelEndpoint,
            endpoint,
            "model-endpoint-address",
            t!("Address"),
        )
        .terms(format!("{} base URL", t!("Protocol"))),
        Entry::row(ModelEndpoint, endpoint, "model-endpoint-key", t!("API key")).description(t!(
            "Kept in the macOS keychain. Leave it empty for a local server that needs none."
        )),
        Entry::row(
            ModelEndpoint,
            endpoint,
            "model-endpoint-models",
            t!("Models"),
        )
        .terms(format!("{} {}", t!("Context window"), t!("Max output"))),
        Entry::row(
            ModelEndpoint,
            endpoint,
            "model-endpoint-runtime",
            t!("Pi runtime"),
        ),
        Entry::page(Environment, environment, agent).terms(format!(
            "HTTPS_PROXY ANTHROPIC_BASE_URL {}",
            t!("proxy key endpoint shell restart")
        )),
        Entry::row(
            Environment,
            environment,
            "agent-restart",
            t!("Restart agent"),
        ),
    ]);
    let overleaf = t!("Overleaf");
    out.extend([
        Entry::page(Overleaf, overleaf, t!("Integrations")),
        Entry::row(Overleaf, overleaf, "overleaf-connection", t!("Connection")),
        Entry::row(Overleaf, overleaf, "overleaf-sync-mode", t!("Sync mode")).terms(format!(
            "{} {}",
            t!("Live sync"),
            t!("Manual")
        )),
        Entry::row(
            Overleaf,
            overleaf,
            "overleaf-remote-delete",
            t!("When you delete a file here"),
        )
        .terms(format!(
            "{} {} {}",
            t!("Ask before deleting"),
            t!("Delete on Overleaf too"),
            t!("Keep it on Overleaf")
        ))
        .description(t!("Overleaf history keeps a copy")),
    ]);
    let literature = t!("Literature services");
    out.push(Entry::page(Literature, literature, t!("Integrations")));
    out.push(
        Entry::row(
            Literature,
            literature,
            "literature-full-text",
            t!("Also save full text (Markdown)"),
        )
        .terms(format!(
            "{} {} arXiv PDF",
            t!("Adding papers"),
            t!("Citation only")
        )),
    );
    for (id, name) in [
        ("literature-openalex", "OpenAlex"),
        ("literature-semanticscholar", "Semantic Scholar"),
        ("literature-firecrawl", "Firecrawl"),
    ] {
        out.push(Entry::row(Literature, literature, id, name).terms(t!("API key")));
    }
    out.push(
        Entry::row(
            Literature,
            literature,
            "literature-email",
            t!("Contact email"),
        )
        .terms("Crossref")
        .description(t!("Sent to Crossref")),
    );
    let plugins = t!("Plugins");
    out.push(
        Entry::page(Plugins, plugins, t!("Integrations"))
            .terms(t!("plugin extension add-on sandbox permissions")),
    );
    out.push(
        Entry::row(
            Plugins,
            plugins,
            "plugins-install-url",
            t!("Install from URL…"),
        )
        .terms("SHA-256 zip"),
    );
    out.push(
        Entry::row(
            Plugins,
            plugins,
            "plugins-install-folder",
            t!("Install from folder…"),
        )
        .terms(t!("develop")),
    );
    out.push(Entry::page(Doctor, t!("TeX doctor"), t!("Diagnostics")));
    out.push(Entry::page(Logs, t!("Logs"), t!("Diagnostics")));
    let fonts = lattice_ui::fonts::font_license().is_some();
    let mut about =
        Entry::page(Acknowledgements, t!("Acknowledgements"), t!("About")).terms(format!(
            "{}{}",
            if fonts { "Timeless " } else { "" },
            t!("credits licenses fonts open source libraries third-party notices")
        ));
    if fonts {
        about = about.description("Timeless Free Font License");
    }
    out.push(about);
    out
}

/// Settings › Editor & builds › Live preview, offered only to a LuaLaTeX
/// project, which goes before the app's version.
pub fn with_live_preview(mut entries: Vec<Entry>) -> Vec<Entry> {
    let builds = t!("Builds");
    let entry = Entry::row(
        SettingsTab::Editor,
        t!("Editor & builds"),
        "live-preview",
        t!("Live preview"),
    )
    .terms(format!(
        "{builds} LuaLaTeX rtex {}",
        // The catalog's comment: search words for the Live preview setting,
        // space-separated.
        t!("realtime instant")
    ));
    let at = entries
        .iter()
        .position(|entry| entry.id == Some("version"))
        .unwrap_or(entries.len());
    entries.insert(at, entry);
    entries
}

/// The entries matching `query`, best first (`searchSettings`): every word
/// in the label or its terms, the label's own prefix and then the label
/// first; a match only in a description last.
pub fn search(entries: &[Entry], query: &str) -> Vec<Entry> {
    let needle = query.trim().to_lowercase();
    let words: Vec<&str> = needle.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }
    let mut matches: Vec<(u8, usize, &Entry)> = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let label = entry.label.to_lowercase();
            let named = format!("{label} {}", entry.terms.to_lowercase());
            if words.iter().all(|word| named.contains(word)) {
                let rank = if label.starts_with(&needle) {
                    0
                } else if label.contains(&needle) {
                    1
                } else {
                    2
                };
                return Some((rank, index, entry));
            }
            let described = format!("{named} {}", entry.description.to_lowercase());
            words
                .iter()
                .all(|word| described.contains(word))
                .then_some((3, index, entry))
        })
        .collect();
    matches.sort_by_key(|(rank, index, _)| (*rank, *index));
    matches
        .into_iter()
        .map(|(_, _, entry)| entry.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_a_label_prefix_first_and_a_description_last() {
        let all = entries(true, None);
        let found = search(&all, "font");
        assert_eq!(found[0].label, "Font");
        assert!(
            found
                .iter()
                .any(|entry| entry.id == Some("editor-font-size"))
        );
        let found = search(&all, "vim");
        assert_eq!(found[0].id, Some("editor-keymap"));
        // Only two descriptions say "macOS": translucency's and the model
        // endpoint's key, the Tauri index's two.
        let found = search(&all, "macos");
        let ids: Vec<_> = found.iter().map(|entry| entry.id).collect();
        assert_eq!(ids, [Some("translucency"), Some("model-endpoint-key")]);
        assert!(search(&all, "   ").is_empty());
    }

    #[test]
    fn every_settings_page_is_found() {
        let all = entries(true, None);
        for (query, tab) in [
            ("mcp", SettingsTab::Mcp),
            ("skills", SettingsTab::Api),
            ("quota", SettingsTab::Usage),
            ("anthropic", SettingsTab::ModelEndpoint),
            ("https_proxy", SettingsTab::Environment),
            ("crossref", SettingsTab::Literature),
            ("plugin", SettingsTab::Plugins),
            ("third-party", SettingsTab::Acknowledgements),
            ("british", SettingsTab::Editor),
        ] {
            assert_eq!(search(&all, query)[0].tab, tab, "{query}");
        }
    }

    #[test]
    fn project_rows_are_found_only_with_a_project() {
        let without = entries(false, None);
        assert!(search(&without, "engine").is_empty());
        let with = entries(true, None);
        assert_eq!(search(&with, "engine")[0].id, Some("compile-engine"));
    }

    #[test]
    fn the_known_author_name_finds_the_your_name_row() {
        let finds_author = |all: &[Entry]| {
            search(all, "ada writer")
                .iter()
                .any(|entry| entry.id == Some("author-name"))
        };
        assert!(finds_author(&entries(true, Some("Ada Writer"))));
        assert!(!finds_author(&entries(true, None)));
    }
}
