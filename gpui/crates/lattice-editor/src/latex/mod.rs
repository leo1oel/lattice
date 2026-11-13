//! The LaTeX language on the adapter: highlighting in Lattice's code themes,
//! and the first of Lattice's LaTeX extensions, each on one extension point:
//!
//! - TexLab's diagnostics as marks and hover cards ([`diagnostics`]);
//! - the citation card and the reference card ([`cards`]);
//! - command and citation completion ([`completions`]).
//!
//! The language is the latex-lsp tree-sitter grammar
//! (`codebook-tree-sitter-latex`, MIT) with Lattice's own highlight query
//! (`languages/latex/highlights.scm`), whose capture names are the token
//! roles of the Tauri app's LaTeX mode, which `lattice-ui`'s code themes
//! colour. Zed's community LaTeX extension was not used: it carries no
//! license.

use std::{path::Path, rc::Rc, sync::Arc};

use gpui::{App, Entity};
use language::{Language, LanguageConfig};
use theme::ActiveTheme as _;

use crate::{LatticeEditor, ProjectIndex};

pub mod cards;
pub mod completions;
pub mod diagnostics;
pub mod folding;
pub mod syntax;
pub mod vocabulary;

struct LatexLanguage(Arc<Language>);

impl gpui::Global for LatexLanguage {}

fn build_language() -> Language {
    let config = LanguageConfig::from_toml(include_str!("../../languages/latex/config.toml"))
        .expect("the bundled LaTeX config parses");
    Language::new(config, Some(codebook_tree_sitter_latex::LANGUAGE.into()))
        .with_highlights_query(include_str!("../../languages/latex/highlights.scm"))
        .expect("the bundled LaTeX highlight query compiles")
}

/// Build the language once and keep its highlight colors in step with the
/// active theme.
pub fn init(cx: &mut App) {
    let language = Arc::new(build_language());
    language.set_theme(cx.theme().syntax());
    cx.set_global(LatexLanguage(language));

    cx.observe_global::<theme::GlobalTheme>(|cx| {
        let language = cx.global::<LatexLanguage>().0.clone();
        language.set_theme(cx.theme().syntax());
    })
    .detach();
}

/// Whether `path` is a TeX source: the files the LaTeX extensions serve.
pub fn is_tex_source(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "tex" | "sty" | "cls" | "ltx" | "bbx" | "cbx" | "dtx"
            )
        })
}

/// The language for a file, by extension: LaTeX for TeX sources, plain text
/// for everything else.
pub fn language_for_path(path: &Path, cx: &App) -> Option<Arc<Language>> {
    is_tex_source(path).then(|| cx.global::<LatexLanguage>().0.clone())
}

/// Put the LaTeX extensions that read the project on `editor`: the citation
/// and reference cards, and command, citation and label completion.
pub fn attach(editor: &mut LatticeEditor, index: &Entity<ProjectIndex>) {
    let weak = index.downgrade();
    editor.add_hover_provider(Rc::new(cards::CitationCards {
        index: weak.clone(),
    }));
    editor.add_hover_provider(Rc::new(cards::ReferenceCards {
        index: weak.clone(),
    }));
    editor.add_completion_source(Rc::new(completions::CitationSource {
        index: weak.clone(),
    }));
    editor.add_completion_source(Rc::new(completions::ReferenceSource { index: weak }));
    editor.add_completion_source(Rc::new(completions::CommandSource));
}

#[cfg(test)]
mod tests {
    /// The query is compiled at start-up with an `expect`; a capture or
    /// predicate the grammar or tree-sitter rejects should fail here first.
    #[test]
    fn the_highlight_query_compiles() {
        super::build_language();
    }

    /// Each token's capture, as the theme resolves it, as the Tauri app's
    /// LaTeX mode styles the same text (`latex-language.ts`): commands are
    /// keywords, a package's options and key=value keys and the `\\` line
    /// break stay in the ink, a control symbol is an operator.
    #[test]
    fn captures_follow_the_app_s_latex_mode() {
        use std::sync::Arc;
        let language = Arc::new(super::build_language());
        let names = [
            "keyword",
            "operator",
            "property",
            "punctuation.bracket",
            "string",
        ];
        let theme = theme::SyntaxTheme::new(
            names
                .iter()
                .map(|name| (name.to_string(), gpui::HighlightStyle::default())),
        );
        language.set_theme(&theme);
        let text = "\\usepackage[colorlinks=true,preprint]{hyperref} a\\\\ b\\, c";
        let captured: Vec<(&str, &str)> = language
            .highlight_text(text, 0..text.len())
            .filter_map(|(range, id)| Some((&text[range], theme.get_capture_name(id)?)))
            .collect();
        let capture_of = |token: &str| {
            captured
                .iter()
                .find(|(text, _)| *text == token)
                .map(|(_, name)| *name)
        };
        assert_eq!(capture_of("\\usepackage"), Some("keyword"), "{captured:?}");
        assert_eq!(capture_of("\\,"), Some("operator"), "{captured:?}");
        assert_eq!(capture_of("\\\\"), None, "{captured:?}");
        for plain in ["colorlinks", "preprint", "true"] {
            assert!(
                captured.iter().all(|(text, _)| !text.contains(plain)),
                "{plain} stays in the ink: {captured:?}"
            );
        }
    }

    #[test]
    fn tex_sources_are_known_by_extension() {
        use std::path::Path;
        assert!(super::is_tex_source(Path::new("chapters/Intro.TEX")));
        assert!(super::is_tex_source(Path::new("style.sty")));
        assert!(!super::is_tex_source(Path::new("references.bib")));
        assert!(!super::is_tex_source(Path::new("README")));
    }
}
