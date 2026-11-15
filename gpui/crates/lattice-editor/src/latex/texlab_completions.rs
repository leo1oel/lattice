//! TexLab's completions, when TexLab is installed, as the Tauri app's
//! `texlabCompletionSource` (`src/build/texlab-language.ts`) adds them to
//! the menu: for the word before the caret (`\` and letters, or letters),
//! TexLab is asked at the caret with the file's text, and its items join
//! the menu after Lattice's own (the provider drops one an earlier source
//! offers already). They are matched on the word, a command first, the
//! detail TexLab's or "TexLab". Any failure is no answer. The menu does
//! not wait for it past `completion::SYNC_TIME`. An ask waits for TexLab to
//! finish what it is doing (a diagnostics sync, the last ask) without
//! holding a thread, and is dropped unasked once a later keystroke has
//! asked again, so asks never pile up behind a slow TexLab.

use std::{
    path::Path,
    sync::{
        Arc, LazyLock, TryLockError,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use gpui::{App, Task, WeakEntity};
use lattice_core::texlab::{DocumentAt, TexlabCompletionItem};
use regex::Regex;

use super::{completions::match_rank, diagnostics::TexlabDiagnostics};
use crate::completion::{
    CompletionItem, CompletionKind, CompletionList, CompletionQuery, CompletionSource,
};

/// How often a waiting ask looks whether TexLab is free again.
const POOL_RETRY: Duration = Duration::from_millis(20);

static WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\?[A-Za-z@*]*$").expect("the word pattern compiles"));

/// Where the word before the caret starts in `before`, when there is one.
fn word_start(before: &str) -> Option<usize> {
    WORD.find(before)
        .filter(|word| !word.is_empty())
        .map(|word| word.start())
}

/// TexLab's `items` for the typed `word`, as the menu lists them: matched
/// on the label and ordered by how well, a command before anything else
/// matched as well (`boost: 2`), each inserting its text.
pub fn texlab_items(items: Vec<TexlabCompletionItem>, word: &str) -> Vec<CompletionItem> {
    let mut ranked: Vec<_> = items
        .into_iter()
        .filter_map(|item| match_rank(&item.label, word).map(|rank| (rank, item)))
        .collect();
    ranked.sort_by_key(|(rank, item)| (*rank, !item.label.starts_with('\\')));
    ranked
        .into_iter()
        .map(|(_, item)| CompletionItem {
            label: item.label.clone().into(),
            insert: item
                .insert_text
                .filter(|text| !text.is_empty())
                .unwrap_or(item.label),
            caret: None,
            detail: Some(item.detail.unwrap_or_else(|| "TexLab".into()).into()),
            kind: CompletionKind::Command,
            reopen: false,
        })
        .collect()
}

/// TexLab's completions in one editor, for the file its diagnostics follow.
pub struct TexlabCompletions {
    pub diagnostics: WeakEntity<TexlabDiagnostics>,
    /// The last ask made; an earlier one still waiting is dropped.
    pub latest: Arc<AtomicU64>,
    /// Whether TexLab was installed when the editor opened, as the Tauri
    /// app decides once per editor.
    pub available: bool,
}

impl TexlabCompletions {
    fn path(&self, cx: &App) -> Option<String> {
        let path = self.diagnostics.upgrade()?.read(cx).path().to_string();
        super::is_tex_source(Path::new(&path)).then_some(path)
    }
}

impl CompletionSource for TexlabCompletions {
    fn complete(&self, _: &CompletionQuery, _: &App) -> Option<CompletionList> {
        None
    }

    fn asks_later(&self, query: &CompletionQuery, cx: &App) -> bool {
        self.available && word_start(query.before).is_some() && self.path(cx).is_some()
    }

    fn complete_later(
        &self,
        query: &CompletionQuery,
        cx: &App,
    ) -> Option<Task<Option<CompletionList>>> {
        if !self.asks_later(query, cx) {
            return None;
        }
        let path = self.path(cx)?;
        let start = word_start(query.before)?;
        let word = query.before[start..].to_string();
        let from = query.before_start() + start;
        let offset = query.offset;
        let text = query.text.text();
        let line_start = text[..offset].rfind('\n').map_or(0, |at| at + 1);
        let line = text[..line_start].matches('\n').count() as u32 + 1;
        // TexLab counts UTF-16 units, from 1 as the Tauri app sends them.
        let character = text[line_start..offset].encode_utf16().count() as u32 + 1;
        let service = self.diagnostics.upgrade()?.read(cx).service().clone();
        let (root, pool) = service.read(cx).pool();
        let latest = self.latest.clone();
        let ask = latest.fetch_add(1, Ordering::SeqCst) + 1;
        let executor = cx.background_executor().clone();
        Some(cx.background_executor().spawn(async move {
            let mut pool = loop {
                if latest.load(Ordering::SeqCst) != ask {
                    return None;
                }
                match pool.try_lock() {
                    Ok(pool) => break pool,
                    Err(TryLockError::WouldBlock) => {}
                    Err(TryLockError::Poisoned(_)) => return None,
                }
                executor.timer(POOL_RETRY).await;
            };
            let at = DocumentAt {
                path: &path,
                text: Some(&text),
                revision: None,
                line,
                character,
            };
            let items = pool.completion(&root, &at).ok()?;
            Some(CompletionList {
                range: from..offset,
                items: texlab_items(items, &word),
            })
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(label: &str, insert: Option<&str>, detail: Option<&str>) -> TexlabCompletionItem {
        TexlabCompletionItem {
            label: label.into(),
            detail: detail.map(str::to_string),
            kind: None,
            insert_text: insert.map(str::to_string),
            documentation: None,
        }
    }

    #[test]
    fn the_word_is_a_command_or_letters_before_the_caret() {
        assert_eq!(word_start("see \\sec"), Some(4));
        assert_eq!(word_start("see sec"), Some(4));
        assert_eq!(word_start("see "), None);
        assert_eq!(word_start("{"), None);
    }

    /// What CodeMirror makes of the source's answer: options matched on the
    /// typed word (its fuzzy filter), a command boosted over a plain word
    /// that matches as well, `insertText` or else the label inserted, and
    /// "TexLab" as the detail when TexLab gives none.
    #[test]
    fn items_match_the_word_with_commands_first() {
        let items = texlab_items(
            vec![
                item("section*", None, None),
                item("\\section", Some("\\section{$1}"), Some("built-in")),
                item("\\emph", None, None),
            ],
            "sec",
        );
        let labels: Vec<_> = items.iter().map(|item| item.label.to_string()).collect();
        assert_eq!(labels, ["section*", "\\section"]);
        let items = texlab_items(
            vec![
                item("section*", None, None),
                item("\\section", Some("\\section{$1}"), Some("built-in")),
            ],
            "\\sec",
        );
        assert_eq!(items[0].label.as_ref(), "\\section");
        assert_eq!(items[0].insert, "\\section{$1}");
        assert_eq!(items[0].detail.as_deref(), Some("built-in"));
        let plain = texlab_items(vec![item("\\label", Some(""), None)], "\\la");
        assert_eq!(plain[0].insert, "\\label");
        assert_eq!(plain[0].detail.as_deref(), Some("TexLab"));
    }
}
