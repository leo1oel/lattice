//! The source languages beyond LaTeX and Markdown, as the Tauri app's
//! editor gives them (`src/editor/editor-languages.ts`): BibTeX for a
//! bibliography (codemirror-lang-bib) and HTML for a `.html` file
//! (@codemirror/lang-html), whose `<style>` is CSS and `<script>`
//! JavaScript. Each is a tree-sitter grammar with Lattice's own highlight
//! query, whose captures style the source as the Tauri app's highlight style
//! (`latexHighlightStyle`) styles the same node.
//!
//! They live in the registry every source buffer resolves its injections
//! through ([`crate::markdown::registry`]), so an HTML file's styles and
//! scripts, and a Markdown file's fenced `html`, `css`, `js` or `bibtex`
//! block, are highlighted too.

use std::{path::Path, sync::Arc};

use gpui::App;
use language::{Language, LanguageConfig};

/// One of the bundled languages: its config, grammar and queries.
fn build(
    config: &str,
    grammar: impl FnOnce(LanguageConfig) -> Language,
    highlights: &str,
    injections: Option<&str>,
) -> Language {
    let config = LanguageConfig::from_toml(config).expect("a bundled language config parses");
    let name = config.name.clone();
    let language = grammar(config)
        .with_highlights_query(highlights)
        .unwrap_or_else(|error| panic!("{name}'s highlight query compiles: {error}"));
    match injections {
        Some(query) => language
            .with_injection_query(query)
            .unwrap_or_else(|error| panic!("{name}'s injection query compiles: {error}")),
        None => language,
    }
}

pub(crate) fn bibtex() -> Language {
    build(
        include_str!("../languages/bibtex/config.toml"),
        |config| Language::new(config, Some(tree_sitter_bibtex::LANGUAGE.into())),
        include_str!("../languages/bibtex/highlights.scm"),
        None,
    )
}

pub(crate) fn html() -> Language {
    build(
        include_str!("../languages/html/config.toml"),
        |config| Language::new(config, Some(tree_sitter_html::LANGUAGE.into())),
        include_str!("../languages/html/highlights.scm"),
        Some(include_str!("../languages/html/injections.scm")),
    )
}

pub(crate) fn css() -> Language {
    build(
        include_str!("../languages/css/config.toml"),
        |config| Language::new(config, Some(tree_sitter_css::LANGUAGE.into())),
        include_str!("../languages/css/highlights.scm"),
        None,
    )
}

pub(crate) fn javascript() -> Language {
    build(
        include_str!("../languages/javascript/config.toml"),
        |config| Language::new(config, Some(tree_sitter_javascript::LANGUAGE.into())),
        include_str!("../languages/javascript/highlights.scm"),
        None,
    )
}

/// The bundled languages, built once, for [`crate::markdown::init`] to put
/// in the registry.
pub(crate) struct Bundled {
    pub bibtex: Arc<Language>,
    pub html: Arc<Language>,
    pub css: Arc<Language>,
    pub javascript: Arc<Language>,
}

impl gpui::Global for Bundled {}

impl Bundled {
    pub(crate) fn build() -> Self {
        Self {
            bibtex: Arc::new(bibtex()),
            html: Arc::new(html()),
            css: Arc::new(css()),
            javascript: Arc::new(javascript()),
        }
    }

    pub(crate) fn all(&self) -> [Arc<Language>; 4] {
        [
            self.bibtex.clone(),
            self.html.clone(),
            self.css.clone(),
            self.javascript.clone(),
        ]
    }
}

/// The language a bibliography or an HTML file opens in, as the Tauri app
/// picks them (`immediateTextLanguageExtensions`, `isHtmlFilePath`: the
/// extension, in any case).
pub(crate) fn for_path(path: &Path, cx: &App) -> Option<Arc<Language>> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let bundled = cx.try_global::<Bundled>()?;
    match extension.as_str() {
        "bib" => Some(bundled.bibtex.clone()),
        "html" => Some(bundled.html.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The queries are compiled at start-up with an `expect`; a node name a
    /// grammar does not have should fail here first.
    #[test]
    fn the_bundled_queries_compile() {
        bibtex();
        html();
        css();
        javascript();
    }

    /// Each token of `text` and the capture the theme resolves it to.
    fn captures(language: Language, text: &str) -> Vec<(String, String)> {
        let language = Arc::new(language);
        let names = [
            "keyword",
            "type",
            "variable",
            "string",
            "comment",
            "comment.doc",
            "number",
            "constant",
            "operator",
            "property",
            "attribute",
            "label",
            "function",
            "punctuation.bracket",
        ];
        let theme = theme::SyntaxTheme::new(
            names
                .iter()
                .map(|name| (name.to_string(), gpui::HighlightStyle::default())),
        );
        language.set_theme(&theme);
        language
            .highlight_text(text, 0..text.len())
            .filter_map(|(range, id)| {
                Some((
                    text[range].to_string(),
                    theme.get_capture_name(id)?.to_string(),
                ))
            })
            .collect()
    }

    fn capture_of<'a>(captured: &'a [(String, String)], token: &str) -> Option<&'a str> {
        captured
            .iter()
            .find(|(text, _)| text == token)
            .map(|(_, name)| name.as_str())
    }

    /// codemirror-lang-bib's tags: `EntryType` definitionKeyword, `FieldName`
    /// propertyName, braced and quoted values strings, `StringRef`
    /// variableName, `Number` number, `Concat` operator; the citation key
    /// (atom) and the text between entries are not styled.
    #[test]
    fn bibtex_is_styled_as_codemirror_lang_bib_tags_it() {
        let text = "Notes here\n@string{jgr = \"J. Geophys. Res.\"}\n\
                    @article{knuth1984,\n  title = {The {TeX}book},\n  journal = jgr # \" Letters\",\n  year = 1984,\n}\n";
        let captured = captures(bibtex(), text);
        assert_eq!(
            capture_of(&captured, "@article"),
            Some("keyword"),
            "{captured:?}"
        );
        assert_eq!(
            capture_of(&captured, "@string"),
            Some("keyword"),
            "{captured:?}"
        );
        assert_eq!(
            capture_of(&captured, "title"),
            Some("property"),
            "{captured:?}"
        );
        assert_eq!(
            capture_of(&captured, "Geophys."),
            Some("string"),
            "{captured:?}"
        );
        // Adjacent runs in one style are one run: the braces go with the words.
        assert_eq!(
            capture_of(&captured, "{TeX}book}"),
            Some("string"),
            "{captured:?}"
        );
        assert_eq!(
            capture_of(&captured, "1984"),
            Some("number"),
            "{captured:?}"
        );
        assert_eq!(capture_of(&captured, "#"), Some("operator"), "{captured:?}");
        assert!(
            captured
                .iter()
                .any(|(token, name)| token == "jgr" && name == "variable"),
            "the string's use is a variable: {captured:?}"
        );
        for plain in ["knuth1984", "Notes"] {
            assert!(
                captured.iter().all(|(token, _)| !token.contains(plain)),
                "{plain} stays in the ink: {captured:?}"
            );
        }
    }

    /// lang-html's tags: tagName (a type), attributeName, attributeValue (a
    /// string, with its quotes), comment, documentMeta (the doc comment),
    /// angleBracket; a <style>'s CSS and a <script>'s JavaScript are their
    /// own languages, which need the registry, so they are not here.
    #[test]
    fn html_is_styled_as_lang_html_tags_it() {
        let text = "<!DOCTYPE html>\n<!-- note -->\n<a href=\"x.html\">link</a>\n";
        let captured = captures(html(), text);
        assert_eq!(capture_of(&captured, "a"), Some("type"), "{captured:?}");
        assert_eq!(
            capture_of(&captured, "href"),
            Some("attribute"),
            "{captured:?}"
        );
        assert!(
            captured
                .iter()
                .any(|(token, name)| token.contains("x.html") && name == "string"),
            "{captured:?}"
        );
        assert_eq!(
            capture_of(&captured, "<!-- note -->"),
            Some("comment"),
            "{captured:?}"
        );
        assert!(
            captured
                .iter()
                .any(|(token, name)| token.contains("DOCTYPE") && name == "comment.doc"),
            "{captured:?}"
        );
        assert_eq!(
            capture_of(&captured, "</"),
            Some("punctuation.bracket"),
            "{captured:?}"
        );
        assert!(
            captured.iter().all(|(token, _)| token != "link"),
            "{captured:?}"
        );
    }

    /// lang-css's: a class a type, an id a label, a property a property, a
    /// custom property a variable, an at-rule a keyword, a number a number.
    #[test]
    fn css_is_styled_as_lang_css_tags_it() {
        let text = "@media screen { .note #main { color: red; --gap: 2px; } }";
        let captured = captures(css(), text);
        assert_eq!(
            capture_of(&captured, "@media"),
            Some("keyword"),
            "{captured:?}"
        );
        assert_eq!(capture_of(&captured, "note"), Some("type"), "{captured:?}");
        assert_eq!(capture_of(&captured, "main"), Some("label"), "{captured:?}");
        assert_eq!(
            capture_of(&captured, "color"),
            Some("property"),
            "{captured:?}"
        );
        assert_eq!(
            capture_of(&captured, "--gap"),
            Some("variable"),
            "{captured:?}"
        );
        // The unit goes with its number here; lang-css leaves it in the ink.
        assert_eq!(capture_of(&captured, "2px"), Some("number"), "{captured:?}");
    }

    /// lang-javascript's: keywords, a declared or called function, a
    /// variable, a property, a string, a number, a comment.
    #[test]
    fn javascript_is_styled_as_lang_javascript_tags_it() {
        let text =
            "// hi\nfunction show(page) { const n = 2; return page.title + \"!\" + run(n); }";
        let captured = captures(javascript(), text);
        assert_eq!(
            capture_of(&captured, "function"),
            Some("keyword"),
            "{captured:?}"
        );
        assert_eq!(
            capture_of(&captured, "show"),
            Some("function"),
            "{captured:?}"
        );
        assert_eq!(
            capture_of(&captured, "run"),
            Some("function"),
            "{captured:?}"
        );
        assert_eq!(
            capture_of(&captured, "page"),
            Some("variable"),
            "{captured:?}"
        );
        assert_eq!(
            capture_of(&captured, "title"),
            Some("property"),
            "{captured:?}"
        );
        assert_eq!(
            capture_of(&captured, "\"!\""),
            Some("string"),
            "{captured:?}"
        );
        assert_eq!(capture_of(&captured, "2"), Some("number"), "{captured:?}");
        assert_eq!(
            capture_of(&captured, "// hi"),
            Some("comment"),
            "{captured:?}"
        );
    }
}
