//! Spell checking in an editor (Settings › Editor & builds › Check spelling),
//! as the Tauri app's source editor has it: the check itself is
//! `lattice_editor::latex::spelling`; this is what it reads from the app and
//! what it asks of it.
//!
//! It reads whether checking is on, the project's dictionary and its ignored
//! rules and sentences (from the manifest, so Settings' Project dictionary
//! and every editor of the project agree), and checks again when any of them
//! changes. It writes a word to the dictionary, or a rule or sentence to the
//! ignores, through lattice-core's manifest, as Settings does.
//!
//! A LaTeX document in another language needs that language's dictionary,
//! downloaded the first time a document needs it (`document-spelling.ts`):
//! the writer is told what is fetched, from where and under which licence,
//! while it downloads, and then that the language is checked; one attempt
//! per language per session. A language with no dictionary is said once.
//! Dictionaries are kept in the app's data folder, beside its other state.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};

use gpui::{App, Context, Entity, Global};
use lattice_core::{project as core_project, spelling::SpellingLanguage};
use lattice_editor::latex::spelling::{
    Ignore, Spelling, SpellingEvent, SpellingInput, language_name,
};
use lattice_i18n::t;
use lattice_ui::components::ToastLevel;

use super::EditorPanel;
use crate::{
    notices::{self, Notice},
    project::Project,
};

/// Where the language dictionaries are kept: the app's data folder, or for
/// a scripted run with none, a folder of its own under the system's temp.
pub fn dictionary_store(cx: &App) -> Option<PathBuf> {
    let scripted = crate::settings::scripted(cx);
    Some(match crate::shell::workspaces::state_dir(scripted) {
        Some(dir) => dir.join("spelling-dictionaries"),
        None => std::env::temp_dir().join("lattice-gpui-spelling-dictionaries"),
    })
}

/// The check's input for an editor of `project`, as the settings and the
/// manifest are now.
pub fn input(project: &Entity<Project>, cx: &App) -> SpellingInput {
    let manifest = project.read(cx).manifest();
    SpellingInput {
        enabled: crate::settings::get(cx).appearance.editor_spellcheck,
        words: manifest.spelling_words.clone(),
        ignored_rules: manifest.grammar_ignored_rules.clone(),
        ignored_sentences: manifest.grammar_ignored_sentences.clone(),
        // The Tauri app's defaults: American English, the profile by the
        // file's prose, Harper's own rule set.
        ..SpellingInput::default()
    }
}

/// The dictionaries asked for this session, so one is downloaded (or said
/// to be missing) once.
#[derive(Default)]
struct Dictionaries {
    installing: HashSet<String>,
    reported: HashSet<String>,
}

impl Global for Dictionaries {}

impl EditorPanel {
    /// Start checking this editor's file, when it is prose Lattice checks.
    pub(super) fn attach_spelling(&mut self, cx: &mut Context<Self>) {
        if lattice_editor::latex::spelling::Prose::for_path(&self.relative).is_none() {
            return;
        }
        let root = self.project.read(cx).root().to_path_buf();
        let input = input(&self.project, cx);
        let store = dictionary_store(cx);
        let spelling =
            Spelling::attach(&self.lattice, root, self.relative.clone(), store, input, cx);
        self._spelling_events = Some(cx.subscribe(&spelling, |this, _, event, cx| {
            this.on_spelling_event(event.clone(), cx)
        }));
        self.spelling = Some(spelling);
    }

    /// The settings or the manifest changed: check with what they say now.
    pub(super) fn refresh_spelling(&mut self, cx: &mut Context<Self>) {
        let input = input(&self.project, cx);
        if let Some(spelling) = &self.spelling {
            spelling.update(cx, |spelling, cx| spelling.set_input(input, cx));
        }
    }

    /// The spell check of this editor, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn spelling(&self) -> Option<&Entity<Spelling>> {
        self.spelling.as_ref()
    }

    fn on_spelling_event(&mut self, event: SpellingEvent, cx: &mut Context<Self>) {
        match event {
            SpellingEvent::AddWord(word) => add_word(&self.project, word, cx),
            SpellingEvent::Ignore(ignore) => ignore_in_project(&self.project, ignore, cx),
            SpellingEvent::NeedsDictionary(language) => install_dictionary(language, cx),
            SpellingEvent::NoDictionary(language) => report_unavailable(language, cx),
        }
    }
}

/// Add `word` to the project's dictionary (`project-spelling-action.ts`): a
/// word it holds already, in any case, is not added twice.
fn add_word(project: &Entity<Project>, word: String, cx: &mut App) {
    let mut words = project.read(cx).manifest().spelling_words.clone();
    if words
        .iter()
        .any(|known| known.to_lowercase() == word.to_lowercase())
    {
        return;
    }
    words.push(word);
    crate::settings::set_spelling_words(project, words, cx);
}

/// Leave a rule or a sentence unchecked in the project
/// (`project-grammar-action.ts`).
fn ignore_in_project(project: &Entity<Project>, ignore: Ignore, cx: &mut App) {
    let manifest = project.read(cx).manifest();
    let mut rules = manifest.grammar_ignored_rules.clone();
    let mut sentences = manifest.grammar_ignored_sentences.clone();
    match ignore {
        Ignore::Rule(rule) if !rules.contains(&rule) => rules.push(rule),
        Ignore::Sentence(sentence) if !sentences.contains(&sentence) => sentences.push(sentence),
        _ => return,
    }
    let root = project.read(cx).root().to_path_buf();
    match core_project::set_grammar_ignores(&root, rules, sentences) {
        Ok(_) => project.update(cx, |project, cx| project.reload_manifest(cx)),
        Err(error) => notices::error(t!("Could not save the setting"), error, cx),
    }
}

/// Download `language`'s dictionary the first time a document needs it,
/// telling the writer what is fetched and under which licence; a failure
/// leaves the language unchecked with a warning, and never blocks the editor.
fn install_dictionary(language: SpellingLanguage, cx: &mut App) {
    let state = cx.default_global::<Dictionaries>();
    if !state.installing.insert(language.code.clone()) {
        return;
    }
    let Some(store) = dictionary_store(cx) else {
        return;
    };
    let name = language_name(&language.code);
    let key = format!("spelling-dictionary:{}", language.code);
    let megabytes = format!("{:.1}", f64::from(language.size_kib.unwrap_or(0)) / 1024.);
    let license = language.license.clone().unwrap_or_default();
    notices::show(
        Notice::new(
            ToastLevel::Info,
            t!("Downloading the {name} spelling dictionary", name = name),
        )
        .detail(t!(
            "{megabytes} MB from wooorm/dictionaries, licensed {license}. Until it arrives, spelling in this document isn't checked.",
            megabytes = megabytes,
            license = license
        ))
        .key(key.clone())
        .running(),
        cx,
    );
    let code = language.code.clone();
    let download = cx.background_executor().spawn(async move {
        lattice_core::spelling::install_dictionary(
            &store,
            &code,
            &lattice_core::spelling::HttpFetch,
        )
    });
    cx.spawn(async move |cx| {
        let result = download.await;
        cx.update(|cx| {
            match result {
                Ok(()) => {
                    notices::show(
                        Notice::new(
                            ToastLevel::Success,
                            t!("{name} spelling is now checked", name = name),
                        )
                        .detail(t!("The dictionary is licensed {license}.", license = license))
                        .key(key),
                        cx,
                    );
                    relint_everywhere(cx);
                }
                Err(error) => notices::show(
                    Notice::new(
                        ToastLevel::Warning,
                        t!("Couldn't download the {name} spelling dictionary", name = name),
                    )
                    .detail(t!(
                        "Spelling in {name} isn't checked. Lattice tries again the next time it opens. {error}",
                        name = name,
                        error = error
                    ))
                    .key(key),
                    cx,
                ),
            }
        });
    })
    .detach();
}

/// Say once per session that a document's language has no dictionary, so
/// its silence is explained.
fn report_unavailable(language: SpellingLanguage, cx: &mut App) {
    let state = cx.default_global::<Dictionaries>();
    if !state.reported.insert(language.code.clone()) {
        return;
    }
    notices::show(
        Notice::new(
            ToastLevel::Info,
            t!("No spelling dictionary for “{name}”", name = language.code),
        )
        .detail(t!(
            "This document's babel or polyglossia language has no dictionary in Lattice, so its spelling isn't checked."
        ))
        .key(format!("spelling-unavailable:{}", language.code)),
        cx,
    );
}

/// Every open editor checks again: a dictionary arrived.
fn relint_everywhere(cx: &mut App) {
    let mut editors: HashMap<gpui::EntityId, Entity<Spelling>> = HashMap::new();
    crate::shell::windows::for_shells(
        cx,
        |_| true,
        |shell, _, cx| {
            for editor in shell.open_editors() {
                if let Some(spelling) = editor.read(cx).spelling.clone() {
                    editors.insert(spelling.entity_id(), spelling);
                }
            }
        },
    );
    for spelling in editors.into_values() {
        spelling.update(cx, |spelling, cx| spelling.relint(cx));
    }
}
