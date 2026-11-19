//! Spell checking in an editor (Settings › Editor & builds › Check
//! spelling), on macOS with the system's NSSpellChecker: the check itself is
//! `lattice_editor::spelling`; this is the checker it asks and what it reads
//! from the app.
//!
//! NSSpellChecker answers through `requestCheckingOfString`, which runs in
//! the system's spelling service and calls back on a queue of its own, so
//! neither the dictionaries nor the work sit on the app's main thread. Each
//! editor holds a spell document tag of its own: Ignore Spelling is that
//! document's alone, as in a text view, and Learn Spelling goes to the
//! writer's own dictionary, which every Mac app shares. The language is the
//! system's: NSSpellChecker identifies each paragraph's, so Chinese prose is
//! never marked.
//!
//! The check reads whether it is on and the project's dictionary (from the
//! manifest, where the Tauri app's Add to project dictionary writes), and
//! checks again when either changes.

use std::rc::Rc;

use gpui::{Context, Entity};
use lattice_editor::spelling::{Checker, Spelling, SpellingInput};

use super::EditorPanel;
use crate::project::Project;

/// The check's input for an editor of `project`, as the settings and the
/// manifest are now.
fn input(project: &Entity<Project>, cx: &gpui::App) -> SpellingInput {
    SpellingInput {
        enabled: crate::settings::get(cx).appearance.editor_spellcheck,
        words: project.read(cx).manifest().spelling_words.clone(),
    }
}

impl EditorPanel {
    /// Start checking this editor's file, when it is prose Lattice checks
    /// and the system has a checker.
    pub(super) fn attach_spelling(&mut self, cx: &mut Context<Self>) {
        if lattice_editor::spelling::Prose::for_path(&self.relative).is_none() {
            return;
        }
        let Some(checker) = system_checker() else {
            return;
        };
        let input = input(&self.project, cx);
        self.spelling = Some(Spelling::attach(
            &self.lattice,
            checker,
            &self.relative,
            input,
            cx,
        ));
    }

    /// The settings or the manifest changed: check with what they say now.
    pub(super) fn refresh_spelling(&mut self, cx: &mut Context<Self>) {
        let input = input(&self.project, cx);
        if let Some(spelling) = &self.spelling {
            spelling.update(cx, |spelling, cx| spelling.set_input(input, cx));
        }
    }

    /// The file moved: the check follows it, or starts once it is prose.
    pub(super) fn spelling_moved(&mut self, cx: &mut Context<Self>) {
        match &self.spelling {
            Some(spelling) => {
                let relative = self.relative.clone();
                spelling.update(cx, |spelling, cx| spelling.set_path(&relative, cx));
            }
            None => self.attach_spelling(cx),
        }
    }

    /// The spell check of this editor, for the right-click menu and a
    /// scenario.
    pub fn spelling(&self) -> Option<&Entity<Spelling>> {
        self.spelling.as_ref()
    }
}

#[cfg(target_os = "macos")]
fn system_checker() -> Option<Rc<dyn Checker>> {
    Some(Rc::new(macos::SystemChecker::new()))
}

#[cfg(not(target_os = "macos"))]
fn system_checker() -> Option<Rc<dyn Checker>> {
    None
}

#[cfg(target_os = "macos")]
pub(crate) mod macos {
    use std::{ops::Range, ptr::NonNull, sync::Mutex};

    use block2::RcBlock;
    use futures::{FutureExt as _, channel::oneshot, future::BoxFuture};
    use lattice_editor::spelling::Checker;
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::{
        NSArray, NSInteger, NSOrthography, NSRange, NSString, NSTextCheckingResult,
        NSTextCheckingType,
    };

    /// One document's session of NSSpellChecker.
    pub struct SystemChecker {
        tag: NSInteger,
    }

    impl SystemChecker {
        pub fn new() -> Self {
            Self {
                tag: NSSpellChecker::uniqueSpellDocumentTag(),
            }
        }
    }

    impl Drop for SystemChecker {
        fn drop(&mut self) {
            NSSpellChecker::sharedSpellChecker().closeSpellDocumentWithTag(self.tag);
        }
    }

    impl Checker for SystemChecker {
        fn check(&self, text: &str) -> BoxFuture<'static, Vec<Range<usize>>> {
            let (sender, answer) = oneshot::channel();
            let sender = Mutex::new(Some(sender));
            let string = NSString::from_str(text);
            let handler = RcBlock::new(
                move |_: NSInteger,
                      results: NonNull<NSArray<NSTextCheckingResult>>,
                      _: NonNull<NSOrthography>,
                      _: NSInteger| {
                    // SAFETY: AppKit hands the block a live array for the
                    // length of the call.
                    let results = unsafe { results.as_ref() };
                    let ranges = results
                        .iter()
                        .filter(|result| result.resultType() == NSTextCheckingType::Spelling)
                        .map(|result| {
                            let range = result.range();
                            range.location..range.location + range.length
                        })
                        .collect();
                    if let Some(sender) = sender.lock().ok().and_then(|mut sender| sender.take()) {
                        sender.send(ranges).ok();
                    }
                },
            );
            // SAFETY: no options dictionary is passed; the block is copied by
            // AppKit and called once, on a queue of its own.
            unsafe {
                NSSpellChecker::sharedSpellChecker()
                    .requestCheckingOfString_range_types_options_inSpellDocumentWithTag_completionHandler(
                        &string,
                        NSRange::new(0, string.length()),
                        NSTextCheckingType::Spelling.0,
                        None,
                        self.tag,
                        Some(&handler),
                    );
            }
            async move { answer.await.unwrap_or_default() }.boxed()
        }

        fn guesses(&self, word: &str) -> Vec<String> {
            let string = NSString::from_str(word);
            NSSpellChecker::sharedSpellChecker()
                .guessesForWordRange_inString_language_inSpellDocumentWithTag(
                    NSRange::new(0, string.length()),
                    &string,
                    None,
                    self.tag,
                )
                .map(|guesses| guesses.iter().map(|guess| guess.to_string()).collect())
                .unwrap_or_default()
        }

        fn learn(&self, word: &str) {
            NSSpellChecker::sharedSpellChecker().learnWord(&NSString::from_str(word));
        }

        fn ignore(&self, word: &str) {
            NSSpellChecker::sharedSpellChecker()
                .ignoreWord_inSpellDocumentWithTag(&NSString::from_str(word), self.tag);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn flagged(checker: &SystemChecker, text: &str) -> Vec<String> {
            let units: Vec<u16> = text.encode_utf16().collect();
            futures::executor::block_on(checker.check(text))
                .into_iter()
                .map(|range| String::from_utf16_lossy(&units[range]))
                .collect()
        }

        /// NSSpellChecker itself: an English misspelling is found with
        /// suggestions, Chinese prose is not marked, and Ignore Spelling
        /// is the document's own.
        #[test]
        fn the_system_checker_finds_english_misspellings_and_leaves_chinese() {
            let checker = SystemChecker::new();
            let found = flagged(
                &checker,
                "This is an introductiom to the method. 这是一个关于方法的中文段落，没有拼写问题。",
            );
            assert_eq!(found, ["introductiom"]);
            assert!(
                checker
                    .guesses("introductiom")
                    .iter()
                    .any(|guess| guess == "introduction")
            );
            checker.ignore("introductiom");
            assert!(flagged(&checker, "An introductiom.").is_empty());
            assert_eq!(
                flagged(&SystemChecker::new(), "An introductiom."),
                ["introductiom"]
            );
        }
    }
}
