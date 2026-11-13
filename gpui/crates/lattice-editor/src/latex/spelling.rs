//! Spell and grammar checking, as the Tauri app's editor has it
//! (`src/editor/harper-spellcheck.ts`, `document-spelling.ts`): Harper's
//! findings, or for a LaTeX document written in another language its
//! Hunspell dictionary's, each a mark (CodeMirror lint's wavy underline: red
//! for spelling, orange for grammar) with the lint card over it.
//!
//! A `.tex` file is read as LaTeX (its syntax masked, [`super::prose`]) and
//! checked with the academic profile; Markdown and plain text with the
//! standard one. The check runs 350 ms after the last edit (CodeMirror's
//! `linter` delay), off the main thread, and again when the project's
//! dictionary or ignores change; a pass that a newer one overtakes is
//! dropped. A finding touching masked syntax, or in a sentence the project
//! ignores, is not shown.
//!
//! The card says what was found (in Simplified Chinese, the rule's name and
//! description over Harper's sentence, translated when it has a known shape)
//! and offers what the Tauri app offers: the first suggestion (Replace with
//! “…”, Remove, Insert “…”), Add “…” to project dictionary for a misspelled
//! word, and Ignore sentence and Ignore rule in project for a grammar
//! finding. The project's own changes are the host's to make
//! ([`SpellingEvent`]); the host also downloads a missing dictionary.

use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap, HashSet},
    ops::Range,
    path::PathBuf,
    rc::Rc,
    sync::LazyLock,
    time::Duration,
};

use gpui::{App, AppContext as _, Context, Entity, EventEmitter, Subscription, Task, WeakEntity};
use language::{Anchor, Buffer, BufferEvent, ToOffset as _};
use lattice_core::{
    harper::{self, HarperDialect, HarperLintOut, HarperOptions, HarperProfile},
    spelling::{self, DictionaryState, SpellingLanguage},
};
use lattice_i18n::{Locale, t};
use regex::Regex;

use super::{diagnostics::Severity, prose};

mod card;

use crate::{
    LatticeEditor,
    decorations::{Mark, MarkStyle},
};
use card::LintCards;
pub use card::describe;

/// The adapter layer the findings are in.
pub const LAYER: &str = "spelling";
/// How long after the last edit the file is checked again.
pub const LINT_DELAY: Duration = Duration::from_millis(350);

/// How a file's prose is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Prose {
    /// LaTeX source: its syntax masked, academic writing.
    Latex,
    /// Markdown and plain text.
    Text,
}

impl Prose {
    /// The prose of a file Lattice checks (`isHarperProseFilePath`): `.tex`,
    /// `.md` and `.txt`.
    pub fn for_path(path: &str) -> Option<Self> {
        let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
        match extension.as_str() {
            "tex" => Some(Prose::Latex),
            "md" | "txt" => Some(Prose::Text),
            _ => None,
        }
    }
}

/// What the check reads from outside the file: whether it is on, the
/// project's dictionary and ignores, and the writer's grammar choices.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SpellingInput {
    pub enabled: bool,
    pub words: Vec<String>,
    pub ignored_rules: Vec<String>,
    pub ignored_sentences: Vec<String>,
    pub dialect: HarperDialect,
    /// `None` reads LaTeX as academic writing and the rest as standard.
    pub profile: Option<HarperProfile>,
    /// The writer's rules switched on or off over the profile.
    pub rules: BTreeMap<String, bool>,
}

/// What the project leaves unchecked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ignore {
    Rule(String),
    Sentence(String),
}

/// Asks of the host.
#[derive(Clone, Debug, PartialEq)]
pub enum SpellingEvent {
    /// Add a word to the project's dictionary.
    AddWord(String),
    /// Leave a rule or a sentence unchecked in the project.
    Ignore(Ignore),
    /// The document is in a language whose dictionary is not downloaded.
    NeedsDictionary(SpellingLanguage),
    /// The document is in a language Lattice has no dictionary for.
    NoDictionary(SpellingLanguage),
}

#[derive(Clone, Debug, PartialEq)]
enum Suggestion {
    Replace(String),
    Remove,
    InsertAfter(String),
}

/// A finding as the pass found it, in buffer byte offsets.
#[derive(Clone, Debug, PartialEq)]
pub struct Finding {
    pub range: Range<usize>,
    pub severity: Severity,
    pub message: String,
    /// The Harper rule that found it; none for a dictionary's finding.
    pub rule: Option<String>,
    /// "Harper", or "Hunspell" for another language's dictionary.
    pub source: &'static str,
    suggestion: Option<Suggestion>,
    /// A misspelled word the project's dictionary can take.
    pub project_word: Option<String>,
    /// The sentence a grammar finding is in, as the project would ignore it.
    pub sentence: Option<String>,
}

#[derive(Clone)]
struct Anchored {
    range: Range<Anchor>,
    finding: Finding,
}

fn is_spelling_kind(kind: &str) -> bool {
    kind == "Spelling" || kind == "Typo"
}

/// A sentence as a project ignores it: whitespace runs collapsed, so
/// rewrapping keeps it ignored and any edit to its wording checks it again.
pub fn sentence_key(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Stable, deduplicated, case-insensitively: Harper's session is keyed on
/// the list, so it rebuilds only when the dictionary really changes.
fn normalize_words(words: &[String]) -> Vec<String> {
    let mut unique: HashMap<String, String> = HashMap::new();
    for word in words {
        let word = word.trim();
        if !word.is_empty() {
            unique.insert(word.to_lowercase(), word.to_string());
        }
    }
    let mut words: Vec<String> = unique.into_values().collect();
    words.sort();
    words
}

/// What one pass needs, taken on the main thread.
struct Pass {
    text: String,
    prose: Prose,
    root: PathBuf,
    path: String,
    store: Option<PathBuf>,
    input: SpellingInput,
}

/// What one pass found, or why it found nothing.
enum Outcome {
    Findings(Vec<Finding>),
    NeedsDictionary(SpellingLanguage),
    NoDictionary(SpellingLanguage),
}

/// The language's name in the interface language, as `Intl.DisplayNames`
/// gives it, else its code.
pub fn language_name(code: &str) -> String {
    const NAMES: &[(&str, &str, &str)] = &[
        ("bg", "Bulgarian", "保加利亚语"),
        ("ca", "Catalan", "加泰罗尼亚语"),
        ("cs", "Czech", "捷克语"),
        ("cy", "Welsh", "威尔士语"),
        ("de", "German", "德语"),
        ("de-AT", "Austrian German", "奥地利德语"),
        ("de-CH", "Swiss High German", "瑞士高地德语"),
        ("el", "Greek", "希腊语"),
        ("eo", "Esperanto", "世界语"),
        ("es", "Spanish", "西班牙语"),
        ("fr", "French", "法语"),
        ("ga", "Irish", "爱尔兰语"),
        ("hr", "Croatian", "克罗地亚语"),
        ("hu", "Hungarian", "匈牙利语"),
        ("is", "Icelandic", "冰岛语"),
        ("it", "Italian", "意大利语"),
        ("lt", "Lithuanian", "立陶宛语"),
        ("lv", "Latvian", "拉脱维亚语"),
        ("nb", "Norwegian Bokmål", "书面挪威语"),
        ("nl", "Dutch", "荷兰语"),
        ("nn", "Norwegian Nynorsk", "新挪威语"),
        ("pl", "Polish", "波兰语"),
        ("pt-BR", "Brazilian Portuguese", "巴西葡萄牙语"),
        ("pt-PT", "European Portuguese", "欧洲葡萄牙语"),
        ("ro", "Romanian", "罗马尼亚语"),
        ("ru", "Russian", "俄语"),
        ("sk", "Slovak", "斯洛伐克语"),
        ("sl", "Slovenian", "斯洛文尼亚语"),
        ("sv", "Swedish", "瑞典语"),
        ("uk", "Ukrainian", "乌克兰语"),
    ];
    NAMES
        .iter()
        .find(|(known, _, _)| *known == code)
        .map(|(_, en, zh)| match lattice_i18n::locale() {
            Locale::ZhCn => zh.to_string(),
            _ => en.to_string(),
        })
        .unwrap_or_else(|| code.to_string())
}

/// UTF-16 unit offsets of `text`, as byte offsets: index `i` holds the byte
/// where unit `i` starts (one past the end at `len`).
fn byte_offsets(text: &str) -> Vec<usize> {
    let mut offsets = Vec::with_capacity(text.len() + 1);
    for (at, character) in text.char_indices() {
        for _ in 0..character.len_utf16() {
            offsets.push(at);
        }
    }
    offsets.push(text.len());
    offsets
}

/// Run one pass: off the main thread.
fn run(pass: Pass) -> Outcome {
    if pass.text.trim().is_empty() {
        return Outcome::Findings(Vec::new());
    }
    let language = match (&pass.store, pass.prose) {
        (Some(store), Prose::Latex) => spelling::document_language(store, &pass.root, &pass.path),
        _ => None,
    };
    if let Some(language) = &language {
        match language.dictionary {
            DictionaryState::Installed => {}
            // Nothing is checked until the dictionary arrives, and a
            // language with none stays unchecked: never Harper's English.
            DictionaryState::Missing => return Outcome::NeedsDictionary(language.clone()),
            DictionaryState::Unavailable => return Outcome::NoDictionary(language.clone()),
        }
    }
    let masked = prose::mask(&pass.text);
    let words = normalize_words(&pass.input.words);
    let lints: Vec<HarperLintOut> = match (&language, &pass.store) {
        (Some(language), Some(store)) => {
            match spelling::lint(store, &language.code, &masked.prose, &words) {
                Ok(lints) => lints,
                Err(error) => {
                    log::warn!("spelling could not check {}: {error}", pass.path);
                    Vec::new()
                }
            }
        }
        _ => {
            let mut rules = pass.input.rules.clone();
            for rule in &pass.input.ignored_rules {
                rules.insert(rule.clone(), false);
            }
            let options = HarperOptions {
                dialect: pass.input.dialect,
                profile: pass.input.profile.unwrap_or(match pass.prose {
                    Prose::Latex => HarperProfile::Academic,
                    Prose::Text => HarperProfile::Standard,
                }),
                rules,
            };
            harper::lint(&masked.prose, &words, &options)
        }
    };
    Outcome::Findings(findings(&pass, &masked, language.as_ref(), lints))
}

/// The lints a pass keeps, placed in the source.
fn findings(
    pass: &Pass,
    masked: &prose::Masked,
    language: Option<&SpellingLanguage>,
    lints: Vec<HarperLintOut>,
) -> Vec<Finding> {
    static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z'’-]*$").unwrap());
    static WORD_ANY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\p{L}[\p{L}\p{M}'’.-]*$").unwrap());
    let units: Vec<u16> = pass.text.encode_utf16().collect();
    let bytes = byte_offsets(&pass.text);
    let length = units.len();
    let ignored: HashSet<&str> = pass
        .input
        .ignored_sentences
        .iter()
        .map(String::as_str)
        .collect();
    let language_name = language.map(|language| language_name(&language.code));
    lints
        .into_iter()
        .filter_map(|lint| {
            let from = (lint.start as usize).min(length);
            let to = (lint.end as usize).min(length).max(from);
            let problem = String::from_utf16_lossy(&units[from..to]);
            // Harper reads Latin letters only; a dictionary its own script.
            let has_letter = if language.is_some() {
                problem.chars().any(char::is_alphabetic)
            } else {
                problem.chars().any(|c| c.is_ascii_alphabetic())
            };
            // A lint touching masked syntax would land on what the writer
            // never wrote (a long run of spaces, a padded accent).
            if to <= from || !has_letter || masked.syntax[from..to].iter().any(|&s| s) {
                return None;
            }
            let sentence_from = (lint.sentence_start as usize).min(length);
            let sentence_to = (lint.sentence_end as usize).min(length).max(sentence_from);
            let sentence = sentence_key(&String::from_utf16_lossy(
                &units[sentence_from..sentence_to],
            ));
            if ignored.contains(sentence.as_str()) {
                return None;
            }
            let spelling = is_spelling_kind(&lint.kind);
            let word = if language.is_some() {
                &*WORD_ANY
            } else {
                &*WORD
            };
            let suggestion =
                lint.suggestions
                    .first()
                    .map(|suggestion| match suggestion.kind.as_str() {
                        "remove" => Suggestion::Remove,
                        "insert-after" => Suggestion::InsertAfter(suggestion.replacement.clone()),
                        _ => Suggestion::Replace(suggestion.replacement.clone()),
                    });
            Some(Finding {
                range: bytes[from]..bytes[to],
                severity: if spelling {
                    Severity::Error
                } else {
                    Severity::Warning
                },
                message: match &language_name {
                    Some(name) => t!(
                        "“{problem}” isn't in the {languageName} dictionary",
                        problem = problem,
                        languageName = name
                    )
                    .to_string(),
                    None => lint.message.clone(),
                },
                rule: language.is_none().then(|| lint.rule.clone()),
                source: if language.is_some() {
                    "Hunspell"
                } else {
                    "Harper"
                },
                suggestion,
                project_word: (spelling && word.is_match(&problem)).then_some(problem),
                sentence: (!sentence.is_empty()).then_some(sentence),
            })
        })
        .collect()
}

/// The spell check of one editor, kept in step with its buffer.
pub struct Spelling {
    editor: WeakEntity<LatticeEditor>,
    buffer: Entity<Buffer>,
    root: PathBuf,
    path: String,
    store: Option<PathBuf>,
    input: SpellingInput,
    shown: Rc<RefCell<Vec<Anchored>>>,
    /// Bumped by every pass, so an overtaken one is dropped.
    generation: u64,
    _lint: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<SpellingEvent> for Spelling {}

impl Spelling {
    /// Check `path` (project-relative, in the project at `root`) in
    /// `editor`. `store` is where language dictionaries are kept.
    pub fn attach(
        editor: &Entity<LatticeEditor>,
        root: PathBuf,
        path: String,
        store: Option<PathBuf>,
        input: SpellingInput,
        cx: &mut App,
    ) -> Entity<Self> {
        let shown: Rc<RefCell<Vec<Anchored>>> = Rc::default();
        let buffer = editor.read(cx).buffer().clone();
        cx.new(|cx: &mut Context<Self>| {
            let cards = Rc::new(LintCards {
                shown: shown.clone(),
                spelling: cx.weak_entity(),
                buffer: buffer.downgrade(),
            });
            editor.update(cx, |editor, _| editor.add_hover_provider(cards));
            let subscriptions = vec![cx.subscribe(&buffer, |this, _, event: &BufferEvent, cx| {
                if matches!(event, BufferEvent::Edited { .. }) {
                    this.schedule(LINT_DELAY, cx);
                }
            })];
            let mut this = Self {
                editor: editor.downgrade(),
                buffer,
                root,
                path,
                store,
                input,
                shown,
                generation: 0,
                _lint: None,
                _subscriptions: subscriptions,
            };
            this.schedule(Duration::ZERO, cx);
            this
        })
    }

    /// The project's dictionary or ignores, the setting, or the writer's
    /// grammar choices changed: check again at once.
    pub fn set_input(&mut self, input: SpellingInput, cx: &mut Context<Self>) {
        if input != self.input {
            self.input = input;
            self.schedule(Duration::ZERO, cx);
        }
    }

    /// The file was renamed or moved.
    pub fn set_path(&mut self, path: String, cx: &mut Context<Self>) {
        if path != self.path {
            self.path = path;
            self.schedule(Duration::ZERO, cx);
        }
    }

    /// Check again now: a dictionary arrived.
    pub fn relint(&mut self, cx: &mut Context<Self>) {
        self.schedule(Duration::ZERO, cx);
    }

    /// What is shown now, in buffer offsets as the buffer is.
    pub fn findings(&self, cx: &App) -> Vec<Finding> {
        let text = self.buffer.read(cx).snapshot();
        self.shown
            .borrow()
            .iter()
            .map(|anchored| Finding {
                range: anchored.range.start.to_offset(&text)..anchored.range.end.to_offset(&text),
                ..anchored.finding.clone()
            })
            .collect()
    }

    fn schedule(&mut self, delay: Duration, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        let prose = Prose::for_path(&self.path);
        if !self.input.enabled || prose.is_none() {
            self._lint = None;
            self.show(Vec::new(), cx);
            return;
        }
        self._lint = Some(cx.spawn(async move |this, cx| {
            if !delay.is_zero() {
                cx.background_executor().timer(delay).await;
            }
            let Ok((pass, snapshot)) = this.update(cx, |this, cx| {
                let snapshot = this.buffer.read(cx).snapshot();
                let pass = Pass {
                    text: snapshot.text(),
                    prose: prose.unwrap_or(Prose::Text),
                    root: this.root.clone(),
                    path: this.path.clone(),
                    store: this.store.clone(),
                    input: this.input.clone(),
                };
                (pass, snapshot)
            }) else {
                return;
            };
            let outcome = cx
                .background_executor()
                .spawn(async move { run(pass) })
                .await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                match outcome {
                    Outcome::Findings(findings) => {
                        let anchored = findings
                            .into_iter()
                            .map(|finding| Anchored {
                                range: snapshot.anchor_before(finding.range.start)
                                    ..snapshot.anchor_after(finding.range.end),
                                finding,
                            })
                            .collect();
                        this.show(anchored, cx);
                    }
                    Outcome::NeedsDictionary(language) => {
                        this.show(Vec::new(), cx);
                        cx.emit(SpellingEvent::NeedsDictionary(language));
                    }
                    Outcome::NoDictionary(language) => {
                        this.show(Vec::new(), cx);
                        cx.emit(SpellingEvent::NoDictionary(language));
                    }
                }
            })
            .ok();
        }));
    }

    fn show(&mut self, anchored: Vec<Anchored>, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.upgrade() else {
            return;
        };
        let text = self.buffer.read(cx).snapshot();
        let marks = anchored
            .iter()
            .map(|anchored| Mark {
                range: anchored.range.start.to_offset(&text)..anchored.range.end.to_offset(&text),
                style: MarkStyle::squiggle(anchored.finding.severity.underline()),
            })
            .collect();
        *self.shown.borrow_mut() = anchored;
        editor.update(cx, |editor, cx| editor.set_marks(LAYER, marks, cx));
        cx.notify();
    }

    /// Apply a finding's suggestion to the text it covers now.
    fn apply(buffer: &Entity<Buffer>, range: Range<Anchor>, suggestion: &Suggestion, cx: &mut App) {
        buffer.update(cx, |buffer, cx| {
            let snapshot = buffer.snapshot();
            let range = range.start.to_offset(&snapshot)..range.end.to_offset(&snapshot);
            match suggestion {
                Suggestion::Replace(text) => buffer.edit([(range, text.as_str())], None, cx),
                Suggestion::Remove => buffer.edit([(range, "")], None, cx),
                Suggestion::InsertAfter(text) => {
                    buffer.edit([(range.end..range.end, text.as_str())], None, cx)
                }
            };
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pass(text: &str, prose: Prose) -> Pass {
        Pass {
            text: text.to_string(),
            prose,
            root: PathBuf::from("/nonexistent"),
            path: "main.tex".into(),
            store: None,
            input: SpellingInput {
                enabled: true,
                ..SpellingInput::default()
            },
        }
    }

    fn flagged(text: &str, outcome: Outcome) -> Vec<String> {
        let Outcome::Findings(findings) = outcome else {
            panic!("no findings");
        };
        findings
            .into_iter()
            .map(|finding| text[finding.range].to_string())
            .collect()
    }

    #[test]
    fn harper_flags_the_misspelling_not_the_syntax() {
        let text = "\\documentclass{article}\n\\usepackage{takeawayaccent}\n\\begin{document}\nThis is introductiom, as \\citep{smith2024} found in $x + y$.\n\\end{document}";
        let flagged = flagged(text, run(pass(text, Prose::Latex)));
        assert!(flagged.contains(&"introductiom".to_string()), "{flagged:?}");
        assert!(
            flagged
                .iter()
                .all(|span| !span.contains("takeaway") && !span.contains("smith"))
        );
    }

    #[test]
    fn a_misspelling_offers_the_project_dictionary_and_a_fix() {
        let text = "A sentnce with é and 😀 before it.";
        let Outcome::Findings(findings) = run(pass(text, Prose::Text)) else {
            panic!("no findings");
        };
        let finding = findings
            .iter()
            .find(|finding| &text[finding.range.clone()] == "sentnce")
            .expect("sentnce flagged");
        assert_eq!(finding.severity, Severity::Error);
        assert_eq!(finding.project_word.as_deref(), Some("sentnce"));
        assert_eq!(finding.source, "Harper");
        assert!(finding.suggestion.is_some());
    }

    #[test]
    fn the_project_dictionary_and_ignored_sentences_are_honoured() {
        let text = "This is introductiom.";
        let mut words = pass(text, Prose::Text);
        words.input.words = vec!["introductiom".into()];
        assert!(flagged(text, run(words)).is_empty());

        let text = "this sentence starts with lowercase prose.";
        let flagged_before = flagged(text, run(pass(text, Prose::Text)));
        assert!(!flagged_before.is_empty());
        let mut ignored = pass(text, Prose::Text);
        ignored.input.ignored_sentences = vec![sentence_key(text)];
        assert!(flagged(text, run(ignored)).is_empty());
    }

    #[test]
    fn prose_files_are_tex_markdown_and_text() {
        assert_eq!(Prose::for_path("chapters/intro.tex"), Some(Prose::Latex));
        assert_eq!(Prose::for_path("README.MD"), Some(Prose::Text));
        assert_eq!(Prose::for_path("notes.txt"), Some(Prose::Text));
        assert_eq!(Prose::for_path("refs.bib"), None);
        assert_eq!(byte_offsets("é😀a"), vec![0, 2, 2, 6, 7]);
    }
}
