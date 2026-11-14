//! The e2e checks of Find in the open file (`editor_panel/find_bar.rs`):
//! native ⌘F / Ctrl+F opens the find bar with its query focused, typing marks
//! every match and the counter follows, Enter, Shift+Enter, F3 and ⇧⌘G step
//! round the file, the toggles narrow the matches, Replace and Replace all
//! rewrite the text, and Escape closes the bar and gives the keys back to the
//! text. On a scratch file of its own, so earlier modules' edits do not move
//! its matches.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity, Focusable as _, Keystroke};
use serde_json::json;

use super::Steps;
use crate::{
    editor_panel::{
        EditorPanel,
        find_bar::{FindBar, FindOptions},
    },
    scenario::Run,
};

const TEXT: &str = "alpha beta Alpha\nalphabet alpha\n";

impl Run {
    pub(super) async fn find_in_file(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let scratch = root.join("find-check.txt");
        std::fs::write(&scratch, TEXT)?;
        let editor = self.open(cx, &scratch, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;

        // ⌘F / Ctrl+F, natively, from the text.
        self.press(cx, 'f', true).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let (open, focused) = self.find_focus(cx, &editor)?;
        steps.check(
            "find: ⌘F / Ctrl+F in the source editor opens the find bar with its query focused",
            open && focused,
            json!({ "open": open, "query_focused": focused }),
        );

        // Typing marks every match; the caret before the first counts it.
        self.type_text(cx, "alpha").await?;
        let typed = self.find_settled(cx, &editor, "1/4").await;
        steps.check(
            "find: typing the query finds every match and the counter reads 1/4",
            typed,
            self.find_state(cx, &editor),
        );

        // Enter selects the first, then the second; Shift+Enter goes back;
        // F3 forward and ⇧⌘G back, round the end of the file.
        self.press(cx, '\n', false).await?;
        let first = self.find_settled(cx, &editor, "1/4").await;
        self.press(cx, '\n', false).await?;
        let second = self.find_settled(cx, &editor, "2/4").await;
        self.keystroke(cx, "shift-enter")?;
        let back = self.find_settled(cx, &editor, "1/4").await;
        self.keystroke(cx, "shift-f3")?;
        let wrapped = self.find_settled(cx, &editor, "4/4").await;
        self.keystroke(cx, "f3")?;
        let round = self.find_settled(cx, &editor, "1/4").await;
        let previous = if cfg!(target_os = "macos") {
            "cmd-shift-g"
        } else {
            "ctrl-shift-g"
        };
        self.keystroke(cx, previous)?;
        let shortcut = self.find_settled(cx, &editor, "4/4").await;
        let selected = self.selected_text(cx, &editor);
        steps.check(
            "find: Enter, Shift+Enter, F3, Shift+F3 and ⇧⌘G step through the matches round the file",
            first && second && back && wrapped && round && shortcut && selected == "alpha",
            json!({ "first": first, "second": second, "back": back, "wrapped": wrapped, "round": round, "shortcut": shortcut, "selected": selected }),
        );

        // Match case drops "Alpha"; Whole word, with case off, "alphabet".
        let bar = cx.update(|cx| editor.read(cx).find_bar().clone());
        self.set_find_options(cx, &bar, FindOptions {
            match_case: true,
            ..FindOptions::default()
        })?;
        let case = self.find_count(cx, &editor, 3).await;
        self.set_find_options(cx, &bar, FindOptions {
            whole_word: true,
            ..FindOptions::default()
        })?;
        let word = self.find_count(cx, &editor, 3).await;
        self.set_find_options(cx, &bar, FindOptions {
            regexp: true,
            ..FindOptions::default()
        })?;
        let regexp = {
            let bar = bar.clone();
            self.with_window(cx, move |_, window, cx| {
                bar.update(cx, |bar, cx| bar.set_query("al(p)ha\\b", window, cx))
            })?;
            self.find_count(cx, &editor, 3).await
        };
        steps.check(
            "find: Match case, Whole word and Regular expression narrow the matches",
            case && word && regexp,
            json!({ "case": case, "word": word, "regexp": regexp, "state": self.find_state(cx, &editor) }),
        );

        // Replace with the first selected rewrites it and selects the next;
        // Replace all rewrites the rest, `$1` from the expression's group.
        {
            let bar = bar.clone();
            self.with_window(cx, move |_, window, cx| {
                bar.update(cx, |bar, cx| {
                    bar.replacement_input()
                        .update(cx, |input, cx| input.set_value("[$1]", window, cx));
                    bar.step(false, window, cx);
                })
            })?;
        }
        self.find_settled(cx, &editor, "1/3").await;
        {
            let bar = bar.clone();
            self.with_window(cx, move |_, window, cx| {
                bar.update(cx, |bar, cx| bar.replace_next(window, cx))
            })?;
        }
        let one = self
            .wait_for(cx, Duration::from_secs(5), {
                let editor = editor.clone();
                move |_, cx| editor.read(cx).editor().read(cx).text(cx).starts_with("[p] beta")
            })
            .await;
        let moved_on = self.find_settled(cx, &editor, "1/2").await;
        {
            let bar = bar.clone();
            self.with_window(cx, move |_, window, cx| {
                bar.update(cx, |bar, cx| bar.replace_all(window, cx))
            })?;
        }
        let all = self
            .wait_for(cx, Duration::from_secs(5), {
                let editor = editor.clone();
                move |_, cx| {
                    editor.read(cx).editor().read(cx).text(cx) == "[p] beta [p]\nalphabet [p]\n"
                }
            })
            .await;
        steps.check(
            "find: Replace rewrites the selected match and selects the next, Replace all the rest",
            one && moved_on && all,
            json!({ "one": one, "moved_on": moved_on, "all": all, "text": self.editor_text(cx, &editor) }),
        );

        // Escape, natively, from the query.
        let query = cx.update(|cx| bar.read(cx).query_input().clone());
        self.with_window(cx, move |_, window, cx| {
            query.update(cx, |input, cx| input.focus(window, cx))
        })?;
        self.press(cx, '\u{1b}', false).await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let (open, _) = self.find_focus(cx, &editor)?;
        let text_focused = {
            let editor = editor.clone();
            self.with_window(cx, move |_, window, cx| {
                editor.read(cx).editor().focus_handle(cx).is_focused(window)
            })?
        };
        steps.check(
            "find: Escape closes the find bar and gives the keys back to the text",
            !open && text_focused,
            json!({ "open": open, "text_focused": text_focused }),
        );

        // Undo the rewrite so the file closes clean, then let it go.
        self.with_window(cx, {
            let editor = editor.clone();
            move |_, window, cx| {
                editor.update(cx, |panel, cx| {
                    panel.editor().update(cx, |editor, cx| {
                        editor.set_text(TEXT, window, cx);
                    })
                })
            }
        })?;
        self.wait_for(cx, Duration::from_secs(6), {
            let editor = editor.clone();
            move |_, cx| !editor.read(cx).is_dirty(cx)
        })
        .await;
        std::fs::remove_file(&scratch).ok();
        Ok(())
    }

    fn set_find_options(
        &self,
        cx: &mut AsyncApp,
        bar: &Entity<FindBar>,
        options: FindOptions,
    ) -> Result<()> {
        let bar = bar.clone();
        self.with_window(cx, move |_, window, cx| {
            bar.update(cx, |bar, cx| bar.set_options(options, window, cx))
        })
    }

    fn keystroke(&self, cx: &mut AsyncApp, keys: &'static str) -> Result<()> {
        let keystroke = Keystroke::parse(keys).map_err(|error| anyhow::anyhow!("{error}"))?;
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_keystroke(keystroke, cx);
        })?;
        Ok(())
    }

    /// Whether the bar is open, and whether its query has the keys.
    fn find_focus(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>) -> Result<(bool, bool)> {
        let editor = editor.clone();
        self.with_window(cx, move |_, window, cx| {
            let bar = editor.read(cx).find_bar().read(cx);
            let focused = bar.query_input().read(cx).focus_handle(cx).is_focused(window);
            (bar.is_open(), focused)
        })
    }

    /// Wait until no search is under way and the counter reads `label`.
    async fn find_settled(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>, label: &str) -> bool {
        let editor = editor.clone();
        let label = label.to_string();
        self.wait_for(cx, Duration::from_secs(5), move |_, cx| {
            let bar = editor.read(cx).find_bar().read(cx);
            !bar.pending() && bar.count_label(cx) == label
        })
        .await
    }

    async fn find_count(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>, count: usize) -> bool {
        let editor = editor.clone();
        self.wait_for(cx, Duration::from_secs(5), move |_, cx| {
            let bar = editor.read(cx).find_bar().read(cx);
            !bar.pending() && bar.match_count() == count
        })
        .await
    }

    fn find_state(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>) -> serde_json::Value {
        cx.update(|cx| {
            let bar = editor.read(cx).find_bar().read(cx);
            json!({
                "query": bar.query_text(cx),
                "matches": bar.match_count(),
                "count": bar.count_label(cx),
                "options": format!("{:?}", bar.options()),
            })
        })
    }

    fn selected_text(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>) -> String {
        cx.update(|cx| {
            let editor = editor.read(cx).editor().read(cx);
            let snapshot = editor.buffer().read(cx).snapshot(cx);
            let selection = editor.selections.newest_anchor();
            snapshot.text_for_range(selection.start..selection.end).collect()
        })
    }
}

pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Build,
    rank: 25,
    needs: &[],
    setup: false,
    covers: &["gpui/crates/lattice-gpui/src/editor_panel/find_bar"],
    run: |run, cx, steps, fixture| Box::pin(run.find_in_file(cx, steps, &fixture.root)),
};
