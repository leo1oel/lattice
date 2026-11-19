#![cfg(target_os = "macos")]
//! The e2e checks of the spell check (`lattice_editor::spelling`,
//! `editor_panel/spelling.rs`) with macOS's own NSSpellChecker, on a
//! scratch `spelling.tex` and `spelling.md`: the prose's misspellings are
//! marked and nothing else (not a command's argument, math, a comment, the
//! preamble, Markdown code or Chinese prose); a native right-click on one
//! opens the menu with the checker's guesses, Ignore Spelling and Learn
//! Spelling above the editing items, and a native click on a guess corrects
//! the word and on Ignore Spelling clears its mark; an edit is checked after
//! the typing pause, not during it; lines below the screen are checked only
//! once they are scrolled to; and Check spelling off clears every mark, on
//! brings them back. Learn Spelling is left unclicked: it writes to the
//! Mac's own dictionary, which every app shares.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity, point, px};
use lattice_editor::spelling::{EDIT_DELAY, LAYER, Spelling};
use lattice_i18n::tc;
use lattice_ui::components::{menu_snapshot, record_menus};
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, native, scenario::Run, settings};

const TEX: &str = "\\documentclass{article}\n\\usepackage{takeawayaccent}\n\\begin{document}\nThis is an introductiom to the method, as \\citep{smthng2024} found in $x + yy$.\n这是一个关于方法的中文段落，没有拼写问题。\n% a commnt nobody reads\nA sentnce follows here.\n";
const MARKDOWN: &str = "# Notes\n\nA paragrph with `cdoe` and [a link](https://exmple.test).\n";
/// Lines enough to push the last one well below the screen and the check's
/// margin.
const FILLER_LINES: usize = 400;

impl Run {
    pub(super) async fn spell_check(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        cx.update(record_menus);
        let before = cx.update(|cx| settings::get(cx).appearance.editor_spellcheck);
        cx.update(|cx| settings::update_appearance(cx, |a| a.editor_spellcheck = true));
        let tex = root.join("spelling.tex");
        let filler = "Plain words sit here.\n".repeat(FILLER_LINES);
        std::fs::write(&tex, format!("{TEX}{filler}Bottomm line.\n\\end{{document}}\n"))?;
        std::fs::write(root.join("spelling.md"), MARKDOWN)?;
        let result = self.spell_check_steps(cx, steps, root).await;
        cx.update(|cx| settings::update_appearance(cx, |a| a.editor_spellcheck = before));
        result
    }

    async fn spell_check_steps(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let panel = self.open(cx, &root.join("spelling.tex"), Some(1))?;
        let Some(spelling) = cx.update(|cx| panel.read(cx).spelling().cloned()) else {
            steps.check("a .tex file is spell checked", false, json!({ "error": "no spell check" }));
            return Ok(());
        };
        let words = |cx: &mut AsyncApp| marked_words(&spelling, cx);
        let marked = self
            .wait_for(cx, Duration::from_secs(10), {
                let spelling = spelling.clone();
                move |_, cx| spelling.read(cx).misspellings(cx).len() >= 2
            })
            .await;
        let found = words(cx);
        let layer = cx.update(|cx| {
            let lattice = panel.read(cx).lattice_editor().clone();
            lattice.read(cx).mark_ranges(LAYER, cx).len()
        });
        steps.check(
            "the spell check marks the LaTeX prose's misspellings with the red underline, and not a command's argument, math, a comment, the preamble, Chinese prose or lines far below the screen",
            marked && found == ["introductiom", "sentnce"] && layer == 2,
            json!({ "marked": found, "underlines": layer }),
        );

        self.spelling_menu(cx, steps, &panel, &spelling).await?;

        // An edit is checked once typing pauses, not on each key.
        cx.update(|cx| {
            let buffer = panel.read(cx).lattice_editor().read(cx).buffer().clone();
            buffer.update(cx, |buffer, cx| {
                let at = buffer.text().find("follows here.").unwrap_or(0) + "follows here".len();
                buffer.edit([(at..at, " anothr")], None, cx);
            });
        });
        self.pause(cx, Duration::from_millis(120)).await;
        let during = words(cx).contains(&"anothr".to_string());
        let after = self
            .wait_for(cx, EDIT_DELAY + Duration::from_secs(3), {
                let spelling = spelling.clone();
                move |_, cx| spelling.read(cx).misspellings(cx).iter().any(|m| m.word == "anothr")
            })
            .await;
        steps.check(
            "an edit is spell checked after the typing pause, not while typing",
            !during && after,
            json!({ "marked_at_120ms": during, "marked_after_pause": after }),
        );

        // Lines below the screen are checked once scrolled to.
        let below = words(cx).contains(&"Bottomm".to_string());
        self.with_window(cx, |_, window, cx| {
            let zed = panel.read(cx).editor().clone();
            zed.update(cx, |zed, cx| zed.set_scroll_position(point(0., 1.0e6), window, cx));
        })?;
        let scrolled = self
            .wait_for(cx, Duration::from_secs(5), {
                let spelling = spelling.clone();
                move |_, cx| spelling.read(cx).misspellings(cx).iter().any(|m| m.word == "Bottomm")
            })
            .await;
        steps.check(
            "the spell check reads only the lines on screen: the last line is checked once it is scrolled to",
            !below && scrolled,
            json!({ "marked_before_scroll": below, "marked_after_scroll": scrolled }),
        );

        // Check spelling off clears the marks; on brings them back.
        cx.update(|cx| settings::update_appearance(cx, |a| a.editor_spellcheck = false));
        let off = self
            .wait_for(cx, Duration::from_secs(5), {
                let spelling = spelling.clone();
                move |_, cx| spelling.read(cx).misspellings(cx).is_empty()
            })
            .await;
        cx.update(|cx| settings::update_appearance(cx, |a| a.editor_spellcheck = true));
        let on = self
            .wait_for(cx, Duration::from_secs(5), {
                let spelling = spelling.clone();
                move |_, cx| !spelling.read(cx).misspellings(cx).is_empty()
            })
            .await;
        steps.check(
            "turning Check spelling off clears the marks, and on checks again",
            off && on,
            json!({ "off": off, "on": on }),
        );

        // Markdown: prose marked, code and link targets not.
        let markdown = self.open(cx, &root.join("spelling.md"), Some(1))?;
        let md = cx.update(|cx| markdown.read(cx).spelling().cloned());
        let md_marked = match &md {
            Some(md) => {
                self.wait_for(cx, Duration::from_secs(10), {
                    let md = md.clone();
                    move |_, cx| !md.read(cx).misspellings(cx).is_empty()
                })
                .await;
                marked_words(md, cx)
            }
            None => Vec::new(),
        };
        steps.check(
            "a Markdown file's prose is spell checked, its code and link targets are not",
            md_marked == ["paragrph"],
            json!({ "marked": md_marked }),
        );
        Ok(())
    }

    /// A native right-click on `introductiom`: the guesses, Ignore Spelling
    /// and Learn Spelling; a click on `introduction` corrects it, and Ignore
    /// Spelling on `sentnce` clears its mark.
    async fn spelling_menu(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        panel: &Entity<EditorPanel>,
        spelling: &Entity<Spelling>,
    ) -> Result<()> {
        let native = self.native(cx)?;
        let lattice = cx.update(|cx| panel.read(cx).lattice_editor().clone());
        let learn = tc!("macOS menu bar", "Learn Spelling").to_string();
        let ignore = tc!("macOS menu bar", "Ignore Spelling").to_string();
        let copy = tc!("macOS menu bar", "Copy").to_string();
        let open_on = async |run: &Run, cx: &mut AsyncApp, word: &str| -> Result<Vec<(String, gpui::Point<gpui::Pixels>)>> {
            let (_, rect) = run.text_point(cx, panel, &lattice, word, 2).await?;
            let at = point(rect.left() + px(2.), rect.center().y);
            native::send_mouse(native, native::Mouse::Moved, at)?;
            native::send_right_click(native, at)?;
            run.pause(cx, Duration::from_millis(400)).await;
            Ok(cx.update(|cx| {
                menu_snapshot(&learn, cx)
                    .map(|menu| {
                        menu.rows
                            .into_iter()
                            .map(|(_, label, bounds)| (label.to_string(), bounds.center()))
                            .collect()
                    })
                    .unwrap_or_default()
            }))
        };

        let rows = open_on(self, cx, "introductiom").await?;
        let labels: Vec<&str> = rows.iter().map(|(label, _)| label.as_str()).collect();
        let guess = rows.iter().find(|(label, _)| label == "introduction").map(|(_, at)| *at);
        let ordered = labels.iter().position(|l| *l == "introduction")
            < labels.iter().position(|l| *l == ignore.as_str())
            && labels.iter().position(|l| *l == ignore.as_str())
                < labels.iter().position(|l| *l == learn.as_str())
            && labels.iter().position(|l| *l == learn.as_str())
                < labels.iter().position(|l| *l == copy.as_str());
        if let Some(at) = guess {
            native::send_mouse(native, native::Mouse::Moved, at)?;
            native::send_click(native, at)?;
        } else {
            native::send_key(native, '\u{1b}', false)?;
        }
        let corrected = self
            .wait_for(cx, Duration::from_secs(5), {
                let panel = panel.clone();
                let spelling = spelling.clone();
                move |_, cx| {
                    let text = panel.read(cx).lattice_editor().read(cx).buffer().read(cx).text();
                    text.contains("an introduction to the method")
                        && !spelling.read(cx).misspellings(cx).iter().any(|m| m.word == "introductiom")
                }
            })
            .await;
        steps.check(
            "a native right-click on a misspelling lists the checker's guesses, Ignore Spelling and Learn Spelling above the editing items, and a click on a guess corrects the word",
            ordered && corrected,
            json!({ "menu": labels, "corrected": corrected }),
        );

        let rows = open_on(self, cx, "sentnce").await?;
        let ignore_at = rows.iter().find(|(label, _)| *label == ignore).map(|(_, at)| *at);
        if let Some(at) = ignore_at {
            native::send_mouse(native, native::Mouse::Moved, at)?;
            native::send_click(native, at)?;
        } else {
            native::send_key(native, '\u{1b}', false)?;
        }
        let ignored = self
            .wait_for(cx, Duration::from_secs(5), {
                let spelling = spelling.clone();
                move |_, cx| !spelling.read(cx).misspellings(cx).iter().any(|m| m.word == "sentnce")
            })
            .await;
        self.pause(cx, EDIT_DELAY + Duration::from_millis(300)).await;
        let stays = !marked_words(spelling, cx).contains(&"sentnce".to_string());
        steps.check(
            "Ignore Spelling clears the word's mark, and the next check leaves it unmarked",
            ignore_at.is_some() && ignored && stays,
            json!({ "item": ignore_at.is_some(), "cleared": ignored, "stays_cleared": stays }),
        );
        Ok(())
    }
}

fn marked_words(spelling: &Entity<Spelling>, cx: &mut AsyncApp) -> Vec<String> {
    cx.update(|cx| {
        spelling
            .read(cx)
            .misspellings(cx)
            .into_iter()
            .map(|misspelling| misspelling.word)
            .collect()
    })
}

/// This file's registration as the e2e module `spell_check` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 115,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-editor/src/spelling",
        "gpui/crates/lattice-editor/src/latex/prose.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/spelling.rs",
        "gpui/crates/lattice-gpui/src/editor_panel/source_pointer.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.spell_check(cx, steps, &fixture.root)),
};
