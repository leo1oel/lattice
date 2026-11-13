//! The Markdown language for a `.md` file's source: the block and inline
//! grammars of tree-sitter-markdown (`tree-sitter-md`, MIT, at the revision
//! Zed pins) with Lattice's own queries (`languages/markdown/`,
//! `languages/markdown-inline/`), whose captures style the source as the
//! Tauri app's Markdown mode does (`markdownHighlightStyle` in
//! `src/editor/editor-languages.ts`).
//!
//! The block grammar hands each run of inline text to the inline grammar by
//! an injection, which Zed's syntax map resolves through the buffer's
//! language registry; so a Markdown buffer carries [`registry`], which holds
//! both grammars and LaTeX (for a fenced `latex` or `tex` block).

use std::{path::Path, sync::Arc};

use gpui::App;
use language::{Language, LanguageConfig, LanguageRegistry};
use theme::ActiveTheme as _;

struct MarkdownLanguages {
    markdown: Arc<Language>,
    registry: Arc<LanguageRegistry>,
}

impl gpui::Global for MarkdownLanguages {}

fn build_markdown() -> Language {
    let config = LanguageConfig::from_toml(include_str!("../languages/markdown/config.toml"))
        .expect("the bundled Markdown config parses");
    Language::new(config, Some(tree_sitter_md::LANGUAGE.into()))
        .with_highlights_query(include_str!("../languages/markdown/highlights.scm"))
        .expect("the bundled Markdown highlight query compiles")
        .with_injection_query(include_str!("../languages/markdown/injections.scm"))
        .expect("the bundled Markdown injection query compiles")
}

fn build_inline() -> Language {
    let config =
        LanguageConfig::from_toml(include_str!("../languages/markdown-inline/config.toml"))
            .expect("the bundled Markdown inline config parses");
    Language::new(config, Some(tree_sitter_md::INLINE_LANGUAGE.into()))
        .with_highlights_query(include_str!("../languages/markdown-inline/highlights.scm"))
        .expect("the bundled Markdown inline highlight query compiles")
}

/// Build the languages once, after LaTeX's, and keep their colours in step
/// with the active theme.
pub(crate) fn init(latex: Arc<Language>, cx: &mut App) {
    let markdown = Arc::new(build_markdown());
    let registry = Arc::new(LanguageRegistry::new(cx.background_executor().clone()));
    registry.add(markdown.clone());
    registry.add(Arc::new(build_inline()));
    registry.add(latex);
    registry.set_theme(cx.theme().clone());
    cx.set_global(MarkdownLanguages { markdown, registry });

    cx.observe_global::<theme::GlobalTheme>(|cx| {
        let theme = cx.theme().clone();
        cx.global::<MarkdownLanguages>().registry.set_theme(theme);
    })
    .detach();
}

/// Whether `path` is a Markdown file: the Tauri app's test, `.md` only
/// (`isMarkdownFilePath`).
pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

pub(crate) fn language(cx: &App) -> Arc<Language> {
    cx.global::<MarkdownLanguages>().markdown.clone()
}

/// The registry a Markdown buffer resolves its injections through.
pub fn registry(cx: &App) -> Arc<LanguageRegistry> {
    cx.global::<MarkdownLanguages>().registry.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The queries are compiled at start-up with an `expect`; a node name
    /// the grammar does not have should fail here first.
    #[test]
    fn the_bundled_queries_compile() {
        build_markdown();
        build_inline();
    }

    #[test]
    fn only_md_files_are_markdown() {
        assert!(is_markdown(Path::new("notes/README.MD")));
        assert!(!is_markdown(Path::new("notes.markdown")));
        assert!(!is_markdown(Path::new("main.tex")));
    }
}
