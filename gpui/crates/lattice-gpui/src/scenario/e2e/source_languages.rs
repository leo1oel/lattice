//! The e2e checks of the source languages beyond LaTeX and Markdown
//! (`lattice_editor::languages`), on files opened as a writer opens them:
//! the fixture's `references.bib` opens in BibTeX, its entry type a keyword
//! and a field name a property; a scratch `page.html` opens in HTML, a tag a
//! type and an attribute an attribute, with its `<style>` highlighted as CSS
//! and its `<script>` as JavaScript; and a fenced `css` block in a scratch
//! Markdown file is CSS. The scratch files go after.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity};
use serde_json::json;
use theme::ActiveTheme as _;

use super::Steps;
use crate::{editor_panel::EditorPanel, scenario::Run};

const PAGE: &str = "e2e-page.html";
const PAGE_TEXT: &str = "<!DOCTYPE html>\n<p class=\"lead\">Hi</p>\n\
<style>.note { color: red; }</style>\n<script>let count = 2;</script>\n";
const NOTES: &str = "e2e-fence.md";
const NOTES_TEXT: &str = "# Notes\n\n```css\n.note { margin: 0; }\n```\n";

/// The buffer's language, and the capture each `(needle, nth byte)` of its
/// text is highlighted with, once the syntax has been parsed.
fn highlights(
    cx: &mut AsyncApp,
    panel: &Entity<EditorPanel>,
    needles: &[(&str, usize)],
) -> (Option<String>, Vec<(String, Option<String>)>) {
    cx.update(|cx| {
        let buffer = panel.read(cx).lattice_editor().read(cx).buffer().clone();
        let buffer = buffer.read(cx);
        let language = buffer
            .language()
            .map(|language| language.name().to_string());
        let snapshot = buffer.snapshot();
        let text = snapshot.text();
        let syntax = cx.theme().syntax().clone();
        let found = needles
            .iter()
            .map(|(needle, nth)| {
                let capture = text.find(needle).and_then(|at| {
                    let at = at + nth;
                    snapshot
                        .chunks(
                            at..at + 1,
                            language::LanguageAwareStyling {
                                tree_sitter: true,
                                diagnostics: false,
                            },
                        )
                        .next()
                        .and_then(|chunk| chunk.syntax_highlight_id)
                        .and_then(|id| syntax.get_capture_name(id).map(str::to_string))
                });
                (needle.to_string(), capture)
            })
            .collect();
        (language, found)
    })
}

fn capture<'a>(found: &'a [(String, Option<String>)], needle: &str) -> Option<&'a str> {
    found
        .iter()
        .find(|(text, _)| text == needle)
        .and_then(|(_, capture)| capture.as_deref())
}

impl Run {
    /// Wait for `panel`'s syntax (and its injections) to be parsed, then
    /// read the captures.
    async fn parsed_highlights(
        &self,
        cx: &mut AsyncApp,
        panel: &Entity<EditorPanel>,
        needles: &[(&str, usize)],
    ) -> (Option<String>, Vec<(String, Option<String>)>) {
        // Parsing, and an injection's, runs off the main thread: read until
        // every needle has its capture, or the wait runs out.
        let mut found = highlights(cx, panel, needles);
        for _ in 0..25 {
            if found.1.iter().all(|(_, capture)| capture.is_some()) {
                break;
            }
            self.pause(cx, Duration::from_millis(200)).await;
            found = highlights(cx, panel, needles);
        }
        found
    }

    pub(super) async fn source_languages(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let bib = root.join("references.bib");
        let text = std::fs::read_to_string(&bib).context("the fixture's bibliography")?;
        let entry_type = text
            .split('@')
            .nth(1)
            .and_then(|rest| rest.split('{').next())
            .context("an entry")?
            .to_string();
        let panel = self.open(cx, &bib, Some(1))?;
        let entry = format!("@{entry_type}");
        let (language, found) = self
            .parsed_highlights(cx, &panel, &[(entry.as_str(), 1), ("title", 0)])
            .await;
        self.completion_shot(cx, "source-language-bibtex").await;
        steps.check(
            "a .bib file opens in BibTeX, its entry type a keyword and a field name a property, as codemirror-lang-bib styles them",
            language.as_deref() == Some("BibTeX")
                && capture(&found, &entry) == Some("keyword")
                && capture(&found, "title") == Some("property"),
            json!({ "language": language, "captures": found }),
        );
        self.close_panel(cx, &panel).await?;

        let page = root.join(PAGE);
        std::fs::write(&page, PAGE_TEXT)?;
        let panel = self.open(cx, &page, Some(1))?;
        let (language, found) = self
            .parsed_highlights(
                cx,
                &panel,
                &[
                    ("p class", 0),
                    ("class", 0),
                    ("note", 0),
                    ("color", 0),
                    ("let", 0),
                    ("2", 0),
                ],
            )
            .await;
        self.completion_shot(cx, "source-language-html").await;
        steps.check(
            "a .html file opens in HTML: a tag a type, an attribute an attribute, its <style> CSS and its <script> JavaScript, as lang-html nests them",
            language.as_deref() == Some("HTML")
                && capture(&found, "p class") == Some("type")
                && capture(&found, "class") == Some("attribute")
                && capture(&found, "note") == Some("type")
                && capture(&found, "color") == Some("property")
                && capture(&found, "let") == Some("keyword")
                && capture(&found, "2") == Some("number"),
            json!({ "language": language, "captures": found }),
        );
        self.close_panel(cx, &panel).await?;

        let notes = root.join(NOTES);
        std::fs::write(&notes, NOTES_TEXT)?;
        let panel = self.open(cx, &notes, Some(1))?;
        let (language, found) = self.parsed_highlights(cx, &panel, &[("margin", 0)]).await;
        self.completion_shot(cx, "source-language-markdown-css").await;
        steps.check(
            "a Markdown file's fenced css block is highlighted as CSS",
            language.as_deref() == Some("Markdown")
                && capture(&found, "margin") == Some("property"),
            json!({ "language": language, "captures": found }),
        );
        self.close_panel(cx, &panel).await?;
        std::fs::remove_file(&page).ok();
        std::fs::remove_file(&notes).ok();
        Ok(())
    }
}

/// This file's registration as the e2e module `source_languages` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 118,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-editor/src/languages.rs",
        "gpui/crates/lattice-editor/languages",
        "gpui/crates/lattice-editor/src/markdown.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.source_languages(cx, steps, &fixture.root)),
};
