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
//!
//! TexLab offers nothing for a word of prose, and it filters what it
//! offers by the word typed, so a word it had nothing for has nothing
//! however far it is typed while the text around it stays as it was. Such
//! a word is not asked about again for a second (see [`Unanswered`]); past
//! that it is, in case TexLab said nothing only because it was still
//! reading the project, or before a new file or `.bib` entry. Each ask
//! sends TexLab the whole file, which it parses again, so asking on every
//! letter of prose cost TexLab about a tenth of a core while typing, and
//! the app a frame for each answer.

use std::{
    ops::Range,
    path::Path,
    sync::{
        Arc, LazyLock, Mutex, TryLockError,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use gpui::{App, Task, WeakEntity};
use language::BufferSnapshot;
use lattice_core::texlab::{DocumentAt, TexlabCompletionItem};
use regex::Regex;

use super::{completions::match_rank, diagnostics::TexlabDiagnostics};
use crate::completion::{
    CompletionItem, CompletionKind, CompletionList, CompletionQuery, CompletionSource,
};

/// How often a waiting ask looks whether TexLab is free again.
const POOL_RETRY: Duration = Duration::from_millis(20);

/// How long TexLab's nothing for a word holds for that word typed further.
const UNANSWERED_HOLDS: Duration = Duration::from_secs(1);

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

/// The last word TexLab answered with nothing: the file and the text as
/// they were asked about, and the word, which starts at `from`.
pub struct Unanswered {
    path: String,
    text: BufferSnapshot,
    from: usize,
    word: String,
    at: Instant,
}

impl Unanswered {
    /// Whether `word`, starting at `from` in `text`, is this word typed
    /// further with nothing else in the file changed, which TexLab would
    /// have nothing for either.
    fn covers(&self, path: &str, text: &BufferSnapshot, from: usize, word: &str) -> bool {
        self.at.elapsed() < UNANSWERED_HOLDS
            && self.path == path
            && self.text.remote_id() == text.remote_id()
            && self.from == from
            && word.starts_with(&self.word)
            && edits_within(
                text.edits_since::<usize>(self.text.version())
                    .map(|edit| (edit.old, edit.new)),
                from..from + self.word.len(),
                from..from + word.len(),
            )
    }
}

/// Whether each of `edits` (its range before and after) replaced text
/// within `old` and left its text within `new`: the text outside the word,
/// `old` before and `new` after, is as it was.
fn edits_within(
    edits: impl IntoIterator<Item = (Range<usize>, Range<usize>)>,
    old: Range<usize>,
    new: Range<usize>,
) -> bool {
    edits.into_iter().all(|(was, is)| {
        was.start >= old.start && was.end <= old.end && is.start >= new.start && is.end <= new.end
    })
}

/// TexLab's completions in one editor, for the file its diagnostics follow.
pub struct TexlabCompletions {
    pub diagnostics: WeakEntity<TexlabDiagnostics>,
    /// The last ask made; an earlier one still waiting is dropped.
    pub latest: Arc<AtomicU64>,
    /// Whether TexLab was installed when the editor opened, as the Tauri
    /// app decides once per editor.
    pub available: bool,
    /// The last word TexLab had nothing for, until it answers another.
    pub unanswered: Arc<Mutex<Option<Unanswered>>>,
}

impl TexlabCompletions {
    fn path(&self, cx: &App) -> Option<String> {
        let path = self.diagnostics.upgrade()?.read(cx).path().to_string();
        super::is_tex_source(Path::new(&path)).then_some(path)
    }

    /// Whether TexLab already had nothing for the word before the caret,
    /// as typed so far.
    fn known_unanswered(&self, query: &CompletionQuery, path: &str, start: usize) -> bool {
        let Ok(unanswered) = self.unanswered.lock() else {
            return false;
        };
        unanswered.as_ref().is_some_and(|unanswered| {
            unanswered.covers(
                path,
                query.text,
                query.before_start() + start,
                &query.before[start..],
            )
        })
    }
}

impl CompletionSource for TexlabCompletions {
    fn complete(&self, _: &CompletionQuery, _: &App) -> Option<CompletionList> {
        None
    }

    fn asks_later(&self, query: &CompletionQuery, cx: &App) -> bool {
        if !self.available {
            return false;
        }
        let (Some(start), Some(path)) = (word_start(query.before), self.path(cx)) else {
            return false;
        };
        !self.known_unanswered(query, &path, start)
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
        let caret = query.text.offset_to_point(offset);
        let line = caret.row + 1;
        // TexLab counts UTF-16 units, from 1 as the Tauri app sends them.
        let character = query
            .text
            .text_for_range(offset - caret.column as usize..offset)
            .flat_map(str::encode_utf16)
            .count() as u32
            + 1;
        // The file's text is copied for TexLab off the main thread.
        let snapshot = query.text.clone();
        let unanswered = self.unanswered.clone();
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
            let text = snapshot.text();
            let at = DocumentAt {
                path: &path,
                text: Some(&text),
                revision: None,
                line,
                character,
            };
            let items = pool.completion(&root, &at).ok()?;
            drop(pool);
            if let Ok(mut unanswered) = unanswered.lock() {
                *unanswered = items.is_empty().then(|| Unanswered {
                    path,
                    text: snapshot,
                    from,
                    word: word.clone(),
                    at: Instant::now(),
                });
            }
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

    /// "quick" typed on from "qu", which TexLab had nothing for at 10: the
    /// letters added after it keep the text around the word as it was; an
    /// edit before the word, after the caret, or of the space before the
    /// word does not, and TexLab is asked again.
    #[test]
    fn only_letters_added_to_the_word_keep_texlabs_nothing() {
        let (old, new) = (10..12, 10..15);
        assert!(edits_within([], old.clone(), new.clone()));
        assert!(edits_within(
            [(12..12, 12..13), (12..12, 13..15)],
            old.clone(),
            new.clone()
        ));
        assert!(edits_within([(11..12, 11..15)], old.clone(), new.clone()));
        assert!(!edits_within([(3..3, 3..4)], old.clone(), new.clone()));
        assert!(!edits_within([(12..12, 12..16)], old.clone(), new.clone()));
        assert!(!edits_within([(9..10, 9..9)], old.clone(), new.clone()));
        assert!(!edits_within([(20..21, 23..23)], old, new));
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
