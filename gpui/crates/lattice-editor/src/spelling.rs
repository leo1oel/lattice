//! Spell checking with the system's own checker, as the Tauri app's editor
//! marks a misspelling: CodeMirror lint's red wavy underline under the word
//! (`src/editor/harper-spellcheck.ts`), with Settings › Editor & builds ›
//! Check spelling turning it on and off (`editorSpellcheck`, on until the
//! writer turns it off).
//!
//! The GPUI app does not carry Harper's dictionaries (#1102): the host hands
//! in a [`Checker`], on macOS NSSpellChecker, which keeps its dictionaries and
//! its work in the system's spelling service. It also picks the language,
//! paragraph by paragraph, as the system's text views do, so a passage in a
//! language it does not check (Chinese among them) is never marked.
//!
//! What is read is prose only, every offset kept: a `.tex` file through
//! [`crate::latex::prose`] (commands and their identifier arguments, math,
//! comments, verbatim and the preamble but its title are masked, as the
//! Tauri app masks them), a Markdown file through [`markdown`] (code, math,
//! link targets, URLs and HTML masked), a `.txt` file as it is. A word
//! touching masked syntax is never marked, nor one the project's dictionary
//! holds (the Tauri app's Add to project dictionary).
//!
//! The check is lazy: only the lines on screen and [`MARGIN_ROWS`] either side
//! are checked, [`EDIT_DELAY`] after the last edit (CodeMirror's `linter`
//! delay, which the Tauri app's check keeps), and once a scroll brings
//! lines nobody checked on screen. The mask runs off the main thread and the
//! checker answers asynchronously; a pass that a newer one overtakes is
//! dropped.

mod markdown;

use std::{ops::Range, rc::Rc, time::Duration};

use editor::{DisplayPoint, EditorEvent, display_map::DisplayRow};
use futures::future::BoxFuture;
use gpui::{App, AppContext as _, Context, Entity, Subscription, Task, WeakEntity};
use language::{Anchor, Buffer, BufferEvent, Point, ToOffset as _};

use crate::{
    LatticeEditor,
    decorations::{Mark, MarkStyle},
    latex::{
        diagnostics::Severity,
        prose::{self, Masked},
    },
};

/// The adapter layer the misspellings are marked in.
pub const LAYER: &str = "spelling";
/// How long after the last edit the lines on screen are checked again.
pub const EDIT_DELAY: Duration = Duration::from_millis(350);
/// How long after a scroll starts the lines it brought are checked.
pub const SCROLL_DELAY: Duration = Duration::from_millis(150);
/// How many rows above and below the screen a pass checks too, so a short
/// scroll finds them checked.
pub const MARGIN_ROWS: f64 = 40.;

/// How a file's prose is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Prose {
    Latex,
    Markdown,
    Text,
}

impl Prose {
    /// The prose of a file Lattice checks (`isHarperProseFilePath`): `.tex`,
    /// `.md` and `.txt`.
    pub fn for_path(path: &str) -> Option<Self> {
        let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
        match extension.as_str() {
            "tex" => Some(Prose::Latex),
            "md" => Some(Prose::Markdown),
            "txt" => Some(Prose::Text),
            _ => None,
        }
    }

    fn mask(self, source: &str) -> Masked {
        match self {
            Prose::Latex => prose::mask(source),
            Prose::Markdown => markdown::mask(source),
            Prose::Text => Masked {
                prose: source.to_string(),
                syntax: vec![false; source.encode_utf16().count()],
            },
        }
    }
}

/// The system's spell checker, one document's session of it: what it
/// ignores is this document's alone, what it learns every document's.
pub trait Checker {
    /// The misspelled words of `text`, as UTF-16 unit ranges.
    fn check(&self, text: &str) -> BoxFuture<'static, Vec<Range<usize>>>;
    /// The corrections offered for `word`, best first.
    fn guesses(&self, word: &str) -> Vec<String>;
    /// Add `word` to the writer's own dictionary (Learn Spelling).
    fn learn(&self, word: &str);
    /// Stop marking `word` in this document (Ignore Spelling).
    fn ignore(&self, word: &str);
}

/// What the check reads from outside the file.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SpellingInput {
    /// Settings › Check spelling.
    pub enabled: bool,
    /// The project's dictionary.
    pub words: Vec<String>,
}

/// A misspelled word as marked now.
#[derive(Clone, Debug)]
pub struct Misspelling {
    /// In buffer bytes.
    pub range: Range<usize>,
    pub word: String,
    anchors: Range<Anchor>,
}

/// A stretch of the source's prose, ready for the checker.
struct Window {
    text: String,
    /// Per UTF-16 unit of `text`, and one past its end: the buffer byte
    /// where it starts.
    bytes: Vec<usize>,
    /// Per UTF-16 unit of `text`: whether it was syntax.
    syntax: Vec<bool>,
}

/// The prose of `source[start..]`, `source` being the buffer from byte
/// `base` on: the mask reads it from its beginning, so a window that opens
/// inside math or a verbatim environment knows it.
fn prose_window(source: &str, base: usize, start: usize, prose: Prose) -> Window {
    let masked = prose.mask(source);
    let skip = source[..start].encode_utf16().count();
    let units: Vec<u16> = masked.prose.encode_utf16().skip(skip).collect();
    let mut bytes = Vec::with_capacity(units.len() + 1);
    for (at, character) in source[start..].char_indices() {
        for _ in 0..character.len_utf16() {
            bytes.push(base + start + at);
        }
    }
    bytes.push(base + source.len());
    Window {
        text: String::from_utf16_lossy(&units),
        bytes,
        syntax: masked.syntax.get(skip..).unwrap_or_default().to_vec(),
    }
}

/// The checker's findings the editor marks, in buffer bytes: none touching
/// syntax, none without a letter, none the project's dictionary holds
/// (`words`, lowercased).
fn misspellings(window: &Window, found: &[Range<usize>], words: &[String]) -> Vec<Range<usize>> {
    let units: Vec<u16> = window.text.encode_utf16().collect();
    found
        .iter()
        .filter_map(|range| {
            let to = range.end.min(units.len());
            let from = range.start.min(to);
            if from == to || window.syntax[from..to].iter().any(|&syntax| syntax) {
                return None;
            }
            let word = String::from_utf16_lossy(&units[from..to]);
            let known = words.contains(&word.to_lowercase());
            (word.chars().any(char::is_alphabetic) && !known)
                .then(|| window.bytes[from]..window.bytes[to])
        })
        .collect()
}

/// The spell check of one editor, kept in step with its buffer and its
/// scroll.
pub struct Spelling {
    editor: WeakEntity<LatticeEditor>,
    buffer: Entity<Buffer>,
    checker: Rc<dyn Checker>,
    prose: Option<Prose>,
    input: SpellingInput,
    shown: Vec<(Range<Anchor>, String)>,
    /// The buffer's version and the bytes the last pass that landed checked.
    checked: Option<(clock::Global, Range<usize>)>,
    /// A pass is waiting out its delay.
    waiting: bool,
    /// Bumped by every pass, so an overtaken one is dropped.
    generation: u64,
    _check: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl Spelling {
    /// Check `path`'s prose in `editor` with `checker`.
    pub fn attach(
        editor: &Entity<LatticeEditor>,
        checker: Rc<dyn Checker>,
        path: &str,
        input: SpellingInput,
        cx: &mut App,
    ) -> Entity<Self> {
        let buffer = editor.read(cx).buffer().clone();
        let zed = editor.read(cx).editor().clone();
        cx.new(|cx: &mut Context<Self>| {
            let subscriptions = vec![
                cx.subscribe(&buffer, |this, _, event: &BufferEvent, cx| {
                    if matches!(event, BufferEvent::Edited { .. }) {
                        this.schedule(EDIT_DELAY, cx);
                    }
                }),
                cx.subscribe(&zed, |this, _, event: &EditorEvent, cx| {
                    if matches!(event, EditorEvent::ScrollPositionChanged { .. }) && !this.waiting {
                        this.start(SCROLL_DELAY, false, cx);
                    }
                }),
            ];
            let mut this = Self {
                editor: editor.downgrade(),
                buffer,
                checker,
                prose: Prose::for_path(path),
                input: normalized(input),
                shown: Vec::new(),
                checked: None,
                waiting: false,
                generation: 0,
                _check: None,
                _subscriptions: subscriptions,
            };
            this.schedule(Duration::ZERO, cx);
            this
        })
    }

    /// Check Spelling or the project's dictionary changed.
    pub fn set_input(&mut self, input: SpellingInput, cx: &mut Context<Self>) {
        let input = normalized(input);
        if input != self.input {
            self.input = input;
            self.schedule(Duration::ZERO, cx);
        }
    }

    /// The file was renamed or moved.
    pub fn set_path(&mut self, path: &str, cx: &mut Context<Self>) {
        let prose = Prose::for_path(path);
        if prose != self.prose {
            self.prose = prose;
            self.schedule(Duration::ZERO, cx);
        }
    }

    /// The misspellings marked now.
    pub fn misspellings(&self, cx: &App) -> Vec<Misspelling> {
        let text = self.buffer.read(cx).snapshot();
        self.shown
            .iter()
            .map(|(anchors, word)| Misspelling {
                range: anchors.start.to_offset(&text)..anchors.end.to_offset(&text),
                word: word.clone(),
                anchors: anchors.clone(),
            })
            .collect()
    }

    /// The misspelling marked at buffer byte `offset`, its ends included.
    pub fn misspelling_at(&self, offset: usize, cx: &App) -> Option<Misspelling> {
        self.misspellings(cx).into_iter().find(|misspelling| {
            misspelling.range.contains(&offset) || misspelling.range.end == offset
        })
    }

    /// The corrections the checker offers for `word`.
    pub fn guesses(&self, word: &str) -> Vec<String> {
        self.checker.guesses(word)
    }

    /// Put `correction` where `misspelling` is now.
    pub fn correct(&mut self, misspelling: &Misspelling, correction: &str, cx: &mut Context<Self>) {
        self.buffer.update(cx, |buffer, cx| {
            let snapshot = buffer.snapshot();
            let range = misspelling.anchors.start.to_offset(&snapshot)
                ..misspelling.anchors.end.to_offset(&snapshot);
            buffer.edit([(range, correction)], None, cx);
        });
    }

    /// Learn Spelling: the word joins the writer's dictionary, and its marks
    /// go at once.
    pub fn learn(&mut self, word: &str, cx: &mut Context<Self>) {
        self.checker.learn(word);
        self.forget(word, cx);
    }

    /// Ignore Spelling: the word stops being marked in this document.
    pub fn ignore(&mut self, word: &str, cx: &mut Context<Self>) {
        self.checker.ignore(word);
        self.forget(word, cx);
    }

    fn forget(&mut self, word: &str, cx: &mut Context<Self>) {
        let shown = self
            .shown
            .iter()
            .filter(|(_, shown)| shown != word)
            .cloned()
            .collect();
        self.show(shown, cx);
        self.schedule(Duration::ZERO, cx);
    }

    fn schedule(&mut self, delay: Duration, cx: &mut Context<Self>) {
        self.start(delay, true, cx);
    }

    /// Check the lines on screen after `delay`; unless `always`, only when
    /// the last pass did not check them as they are.
    fn start(&mut self, delay: Duration, always: bool, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        let Some(prose) = self.prose.filter(|_| self.input.enabled) else {
            self.waiting = false;
            self._check = None;
            self.checked = None;
            self.show(Vec::new(), cx);
            return;
        };
        self.waiting = true;
        self._check = Some(cx.spawn(async move |this, cx| {
            if !delay.is_zero() {
                cx.background_executor().timer(delay).await;
            }
            let Ok(Some((snapshot, window))) = this.update(cx, |this, cx| {
                this.waiting = false;
                let snapshot = this.buffer.read(cx).snapshot();
                let covered = this.checked.as_ref().is_some_and(|(version, checked)| {
                    *version == *snapshot.version()
                        && this.rows_shown(0., &snapshot, cx).is_some_and(|shown| {
                            checked.start <= shown.start && shown.end <= checked.end
                        })
                });
                if covered && !always {
                    return None;
                }
                let window = this.rows_shown(MARGIN_ROWS, &snapshot, cx)?;
                Some((snapshot, window))
            }) else {
                return;
            };
            let (text, start) = (snapshot.clone(), window.start);
            let window_text = cx
                .background_executor()
                .spawn(async move {
                    let base = if prose == Prose::Text { start } else { 0 };
                    let source: String = text.text_for_range(base..window.end).collect();
                    prose_window(&source, base, start - base, prose)
                })
                .await;
            let Ok(found) = this.update(cx, |this, _| this.checker.check(&window_text.text)) else {
                return;
            };
            let found = found.await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                let shown = misspellings(&window_text, &found, &this.input.words)
                    .into_iter()
                    .map(|range| {
                        let word = snapshot.text_for_range(range.clone()).collect::<String>();
                        (
                            snapshot.anchor_before(range.start)..snapshot.anchor_after(range.end),
                            word,
                        )
                    })
                    .collect();
                this.checked = Some((snapshot.version().clone(), window));
                this.show(shown, cx);
            })
            .ok();
        }));
    }

    /// The buffer bytes of the lines on screen and `margin` rows either
    /// side, whole lines.
    fn rows_shown(
        &self,
        margin: f64,
        text: &language::BufferSnapshot,
        cx: &mut App,
    ) -> Option<Range<usize>> {
        let zed = self.editor.upgrade()?.read(cx).editor().clone();
        let (first, last) = zed.update(cx, |editor, cx| {
            let snapshot = editor.display_snapshot(cx);
            let top = editor.scroll_position(cx).y.max(0.);
            let rows = editor.visible_line_count().unwrap_or(60.);
            let row_at = |row: f64| {
                let row = DisplayRow(row.max(0.).floor() as u32).min(snapshot.max_point().row());
                DisplayPoint::new(row, 0).to_point(&snapshot).row
            };
            (row_at(top - margin), row_at(top + rows + margin))
        });
        let last = last.min(text.max_point().row);
        Some(
            text.point_to_offset(Point::new(first.min(last), 0))
                ..text.point_to_offset(Point::new(last, text.line_len(last))),
        )
    }

    fn show(&mut self, shown: Vec<(Range<Anchor>, String)>, cx: &mut Context<Self>) {
        let text = self.buffer.read(cx).snapshot();
        let offsets = |shown: &[(Range<Anchor>, String)]| -> Vec<Range<usize>> {
            shown
                .iter()
                .map(|(range, _)| range.start.to_offset(&text)..range.end.to_offset(&text))
                .collect()
        };
        let ranges = offsets(&shown);
        // The same marks again would only redraw the editor.
        if ranges == offsets(&self.shown) {
            self.shown = shown;
            return;
        }
        self.shown = shown;
        let Some(editor) = self.editor.upgrade() else {
            return;
        };
        let style = MarkStyle::squiggle(Severity::Error.underline());
        let marks = ranges
            .into_iter()
            .map(|range| Mark { range, style })
            .collect();
        editor.update(cx, |editor, cx| editor.set_marks(LAYER, marks, cx));
        cx.notify();
    }
}

/// The project's dictionary lowercased, so a word matches it in any case,
/// as the Tauri app's does.
fn normalized(mut input: SpellingInput) -> SpellingInput {
    input.words = input
        .words
        .iter()
        .map(|word| word.trim().to_lowercase())
        .filter(|word| !word.is_empty())
        .collect();
    input.words.sort();
    input.words.dedup();
    input
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A checker that knows a few words: anything else made of letters is
    /// misspelled, and a CJK character is never checked.
    fn check(text: &str) -> Vec<Range<usize>> {
        const KNOWN: &[&str] = &[
            "this", "is", "a", "an", "and", "as", "found", "in", "follows", "x", "the", "with",
            "some", "text", "after",
        ];
        let is_letter = |unit: u16| {
            char::from_u32(u32::from(unit))
                .is_some_and(|c| c.is_alphabetic() && !('\u{4e00}'..='\u{9fff}').contains(&c))
        };
        let units: Vec<u16> = text.encode_utf16().collect();
        let mut found = Vec::new();
        let mut at = 0;
        while at < units.len() {
            if !is_letter(units[at]) {
                at += 1;
                continue;
            }
            let start = at;
            while at < units.len() && is_letter(units[at]) {
                at += 1;
            }
            let word = String::from_utf16_lossy(&units[start..at]).to_lowercase();
            if !KNOWN.contains(&word.as_str()) {
                found.push(start..at);
            }
        }
        found
    }

    fn marked(source: &str, start: usize, prose: Prose, words: &[&str]) -> Vec<String> {
        let window = prose_window(source, 0, start, prose);
        let words: Vec<String> = words.iter().map(|word| word.to_string()).collect();
        misspellings(&window, &check(&window.text), &words)
            .into_iter()
            .map(|range| source[range].to_string())
            .collect()
    }

    #[test]
    fn latex_marks_the_prose_not_the_syntax() {
        let source = "\\documentclass{article}\n\\usepackage{takeawayaccent}\n\\begin{document}\nThis is introductiom, as \\citep{smith2024} found in $x + yy$.\n% a commnt\n\\begin{verbatim}\nverbtim\n\\end{verbatim}\n中文句子 and Andr\\'e.\n\\end{document}";
        assert_eq!(marked(source, 0, Prose::Latex, &[]), ["introductiom"]);
    }

    #[test]
    fn a_window_inside_math_or_verbatim_still_knows_it() {
        let source = "Some text.\n\\begin{verbatim}\nfirst\nsecnd\n\\end{verbatim}\nAfter wrds.\n";
        let start = source.find("secnd").unwrap();
        assert_eq!(marked(source, start, Prose::Latex, &[]), ["wrds"]);
    }

    #[test]
    fn markdown_and_text_and_the_project_dictionary() {
        let source = "A sentnce with `cdoe` and [lnk](https://exmple.test) follows.";
        assert_eq!(marked(source, 0, Prose::Markdown, &[]), ["sentnce", "lnk"]);
        assert_eq!(
            marked(source, 0, Prose::Markdown, &["lnk", "sentnce"]),
            Vec::<String>::new()
        );
        assert_eq!(
            marked("中文 😀 an introductiom", 0, Prose::Text, &[]),
            ["introductiom"]
        );
    }

    #[test]
    fn offsets_map_back_to_buffer_bytes() {
        let source = "中文 😀 wrd";
        let window = prose_window(source, 100, 0, Prose::Text);
        let found = check(&window.text);
        let ranges = misspellings(&window, &found, &[]);
        let wrd = 100 + source.find("wrd").unwrap();
        assert_eq!(ranges, vec![wrd..100 + source.len()]);
    }

    #[test]
    fn prose_files_are_tex_markdown_and_text() {
        assert_eq!(Prose::for_path("chapters/intro.tex"), Some(Prose::Latex));
        assert_eq!(Prose::for_path("README.MD"), Some(Prose::Markdown));
        assert_eq!(Prose::for_path("notes.txt"), Some(Prose::Text));
        assert_eq!(Prose::for_path("refs.bib"), None);
    }

    #[test]
    fn the_dictionary_matches_in_any_case() {
        let input = normalized(SpellingInput {
            enabled: true,
            words: vec![" Lattice ".into(), "lattice".into(), "".into()],
        });
        assert_eq!(input.words, ["lattice"]);
    }
}
