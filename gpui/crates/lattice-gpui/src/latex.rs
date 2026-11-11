//! The LaTeX language for Zed's editor: the latex-lsp tree-sitter grammar with
//! this prototype's own highlight query.

use std::{path::Path, sync::Arc};

use gpui::App;
use language::{Language, LanguageConfig};
use theme::ActiveTheme as _;

struct LatexLanguage(Arc<Language>);

impl gpui::Global for LatexLanguage {}

/// Build the language once and keep its highlight colors in step with the
/// active theme.
pub fn init(cx: &mut App) {
    let config = LanguageConfig::from_toml(include_str!("../languages/latex/config.toml"))
        .expect("the bundled LaTeX config parses");
    let language = Language::new(config, Some(codebook_tree_sitter_latex::LANGUAGE.into()))
        .with_highlights_query(include_str!("../languages/latex/highlights.scm"))
        .expect("the bundled LaTeX highlight query compiles");
    let language = Arc::new(language);
    language.set_theme(cx.theme().syntax());
    cx.set_global(LatexLanguage(language));

    cx.observe_global::<theme::GlobalTheme>(|cx| {
        let language = cx.global::<LatexLanguage>().0.clone();
        language.set_theme(cx.theme().syntax());
    })
    .detach();
}

/// The language for a file, by extension: LaTeX for TeX sources, plain text
/// for everything else.
pub fn language_for_path(path: &Path, cx: &App) -> Option<Arc<Language>> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "tex" | "sty" | "cls" | "ltx" | "bbx" | "cbx" | "dtx"
    )
    .then(|| cx.global::<LatexLanguage>().0.clone())
}

#[cfg(test)]
mod tests {
    use language::{Language, LanguageConfig};

    /// The query is compiled at start-up with an `expect`; a capture or
    /// predicate the grammar or tree-sitter rejects should fail here first.
    #[test]
    fn the_highlight_query_compiles() {
        let config = LanguageConfig::from_toml(include_str!("../languages/latex/config.toml"))
            .expect("the LaTeX config parses");
        Language::new(config, Some(codebook_tree_sitter_latex::LANGUAGE.into()))
            .with_highlights_query(include_str!("../languages/latex/highlights.scm"))
            .expect("the LaTeX highlight query compiles");
    }
}
