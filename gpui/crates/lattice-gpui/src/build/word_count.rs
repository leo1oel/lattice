//! Word counts, as the Tauri app's status bar gives them
//! (`src/canvas/editor-status-bar.tsx`): the footer names the scope of the
//! one count it shows, the selection while there is one, else the
//! manuscript, else this file; its popover lays every count out by scope.
//! The manuscript count is lattice-core's (`texcount::count_project`: TeXcount
//! on the root document and what it includes, or an estimate without
//! TeXcount), refreshed when the project opens and after each save; the file
//! and selection counts follow the buffer.

use std::{path::PathBuf, sync::LazyLock};

use gpui::{App, AppContext as _, Context, Entity, Global, Task};
use lattice_core::texcount::{self, WordCount};
use regex::Regex;

/// The Tauri app's word: letters and digits, joined by an apostrophe or a
/// hyphen (`latex-edits.ts`'s `WORD`). Commands count too, as there.
static WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*").expect("valid pattern"));

pub fn count_words(text: &str) -> usize {
    WORD.find_iter(text).count()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextStats {
    pub words: usize,
    pub chars: usize,
    pub lines: usize,
}

pub fn text_stats(text: &str) -> TextStats {
    if text.is_empty() {
        return TextStats::default();
    }
    TextStats {
        words: count_words(text),
        chars: text.encode_utf16().count(),
        lines: text.split('\n').count(),
    }
}

/// `120400` → `120,400`.
pub fn format_count(count: usize) -> String {
    let digits = count.to_string();
    let mut out = String::new();
    for (ix, digit) in digits.chars().enumerate() {
        if ix > 0 && (digits.len() - ix).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

fn plural(count: usize, one: &str, many: &str) -> String {
    if count == 1 {
        format!("1 {one}")
    } else {
        format!("{} {many}", format_count(count))
    }
}

/// What the footer and its popover say.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WordCountLabels {
    pub scope: &'static str,
    pub count: String,
    pub manuscript: Option<String>,
    pub manuscript_note: Option<&'static str>,
    pub manuscript_breakdown: Option<String>,
    pub file: String,
    pub file_note: String,
    pub selection: Option<String>,
    pub selection_note: String,
}

/// `file_words` and `file_chars` count the open file, which its editor
/// keeps counted; `selected` is the selection's text.
pub fn labels(
    manuscript: Option<&WordCount>,
    file_words: usize,
    file_chars: usize,
    selected: &str,
) -> WordCountLabels {
    let selection = text_stats(selected);
    let estimated = manuscript.is_some_and(|count| count.source != "texcount");
    let words = |count: usize| plural(count, "word", "words");
    // An estimate reads as one in the footer too, not only in the details.
    let manuscript_words = |count: usize| {
        if estimated {
            format!("≈{}", words(count))
        } else {
            words(count)
        }
    };
    let (scope, count) = if !selected.is_empty() {
        ("Selection", words(selection.words))
    } else if let Some(manuscript) = manuscript {
        ("Manuscript", manuscript_words(manuscript.total as usize))
    } else {
        ("This file", words(file_words))
    };
    WordCountLabels {
        scope,
        count,
        manuscript: manuscript.map(|count| manuscript_words(count.total as usize)),
        // The ≈ marks an estimate; only a missing count needs a note.
        manuscript_note: manuscript
            .is_none()
            .then_some("Needs a root document to count from"),
        manuscript_breakdown: manuscript.filter(|_| !estimated).map(|count| {
            format!(
                "Text {}, headings {}, captions {}",
                format_count(count.text as usize),
                format_count(count.headers as usize),
                format_count(count.captions as usize)
            )
        }),
        file: words(file_words),
        file_note: plural(file_chars, "character", "characters"),
        selection: (!selected.is_empty()).then(|| words(selection.words)),
        selection_note: [
            plural(selection.chars, "character", "characters"),
            plural(selection.lines, "line", "lines"),
        ]
        .join(", "),
    }
}

/// The open project's manuscript count. One per app: the status bars of
/// every editor read it for the project they belong to.
pub struct ManuscriptWords {
    root: Option<PathBuf>,
    count: Option<WordCount>,
    generation: u64,
    _task: Option<Task<()>>,
}

struct ManuscriptWordsGlobal(Entity<ManuscriptWords>);

impl Global for ManuscriptWordsGlobal {}

pub fn manuscript_words(cx: &mut App) -> Entity<ManuscriptWords> {
    if let Some(global) = cx.try_global::<ManuscriptWordsGlobal>() {
        return global.0.clone();
    }
    let entity = cx.new(|_| ManuscriptWords {
        root: None,
        count: None,
        generation: 0,
        _task: None,
    });
    cx.set_global(ManuscriptWordsGlobal(entity.clone()));
    entity
}

/// The count for the project at `root`, when one has been made.
pub fn manuscript_count(root: &std::path::Path, cx: &App) -> Option<WordCount> {
    let words = cx.try_global::<ManuscriptWordsGlobal>()?.0.read(cx);
    words
        .root
        .as_deref()
        .filter(|counted| *counted == root)
        .and(words.count.clone())
}

impl ManuscriptWords {
    /// Count `root`'s manuscript again in the background; `None` forgets
    /// the count of the project that closed. A count of the project open
    /// before never lands on this one.
    pub fn refresh(&mut self, root: Option<PathBuf>, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        if self.root != root {
            self.count = None;
        }
        self.root = root.clone();
        let Some(root) = root else {
            self._task = None;
            cx.notify();
            return;
        };
        self._task = Some(cx.spawn(async move |this, cx| {
            let counted = cx
                .background_spawn(async move { texcount::count_project(&root).ok() })
                .await;
            this.update(cx, |this, cx| {
                if this.generation == generation {
                    this.count = counted;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn count(&self) -> Option<&WordCount> {
        self.count.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counted(total: u32, source: &str) -> WordCount {
        WordCount {
            text: total.saturating_sub(3),
            headers: 2,
            captions: 1,
            total,
            source: source.into(),
        }
    }

    #[test]
    fn words_are_runs_of_letters_and_digits_joined_by_apostrophes_or_hyphens() {
        assert_eq!(count_words("It's a well-known fact, 2 times."), 6);
        assert_eq!(count_words("\\section{Intro} text"), 3);
        assert_eq!(count_words(""), 0);
    }

    #[test]
    fn the_footer_names_its_scope() {
        let manuscript = counted(120_400, "texcount");
        let with_manuscript = labels(Some(&manuscript), 2, 7, "");
        assert_eq!(
            (with_manuscript.scope, with_manuscript.count.as_str()),
            ("Manuscript", "120,400 words")
        );
        assert_eq!(
            with_manuscript.manuscript_breakdown.as_deref(),
            Some("Text 120,397, headings 2, captions 1")
        );
        let file_only = labels(None, 2, 7, "");
        assert_eq!(
            (file_only.scope, file_only.count.as_str()),
            ("This file", "2 words")
        );
        assert_eq!(
            file_only.manuscript_note,
            Some("Needs a root document to count from")
        );
        let selection = labels(Some(&manuscript), 2, 7, "one\ntwo three");
        assert_eq!(
            (selection.scope, selection.count.as_str()),
            ("Selection", "3 words")
        );
        assert_eq!(selection.selection_note, "13 characters, 2 lines");
    }

    #[test]
    fn an_estimate_reads_as_one() {
        let estimate = counted(1, "estimate");
        let shown = labels(Some(&estimate), 0, 0, "");
        assert_eq!(shown.count, "≈1 word");
        assert_eq!(shown.manuscript_breakdown, None);
    }

    #[test]
    fn counts_are_grouped_in_thousands() {
        assert_eq!(format_count(120_400), "120,400");
        assert_eq!(format_count(999), "999");
        assert_eq!(format_count(1_000_000), "1,000,000");
    }
}
