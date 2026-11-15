//! The Project tree's type-to-filter, sticky folders and folder motion
//! (`file_tree/search.rs`, `sticky.rs`, `motion.rs`), as the Tauri app's
//! Pierre tree has them, driven by the platform's own key, pointer and
//! wheel events:
//!
//! - A letter typed in the tree opens the filter field with it; only the
//!   matching rows and their folders show, opened, and nothing matching
//!   leaves the tree empty.
//! - ↓ and Enter pick a match as a click does, closing the field with the
//!   picked row's folders open; Escape closes it and every row is back.
//! - A folder scrolled past stays pinned at the top until its last row
//!   goes; a click on it closes it and brings it back under the top.
//! - A folder opening moves its chevron and rows for the moderate tier,
//!   and with reduced motion nothing moves.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity, Modifiers, PlatformInput, Point, Pixels, px};
use serde_json::json;

use super::Steps;
use crate::{file_tree::FileTreePanel, native, scenario::Run};

/// The files the steps scroll through: enough rows to pass a window.
const NOTES: usize = 40;

impl Run {
    async fn tree_view(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        std::fs::create_dir_all(root.join("notes"))?;
        // queue/ follows notes/, so the tree still scrolls with notes/ closed.
        std::fs::create_dir_all(root.join("queue"))?;
        for n in 1..=NOTES {
            std::fs::write(root.join(format!("notes/n{n:02}.md")), format!("# Note {n}\n"))?;
            std::fs::write(root.join(format!("queue/q{n:02}.md")), format!("# Queued {n}\n"))?;
        }
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());
        cx.update(|cx| tree.update(cx, |tree, cx| tree.refresh(cx)));
        self.wait_for(cx, Duration::from_secs(8), |_, cx| {
            tree.read(cx).all_row_ids(cx).contains("notes/n40.md")
        })
        .await;
        let rows = |cx: &mut AsyncApp| cx.update(|cx| tree.read(cx).row_paths(cx));
        let search = |run: &Self, cx: &mut AsyncApp| {
            let tree = tree.clone();
            run.with_window(cx, move |_, window, cx| tree.read(cx).search_state(window, cx))
        };

        // Typing "i" in the tree opens the field seeded with it; "intro"
        // then leaves its file and the folder holding it, opened.
        let before = rows(cx);
        self.type_in_tree(cx, &tree, "i")?;
        self.pause(cx, Duration::from_millis(200)).await;
        let opened = search(self, cx)?;
        self.with_window(cx, {
            let tree = tree.clone();
            move |_, window, cx| tree.update(cx, |tree, cx| tree.type_in_search("Intro", window, cx))
        })?;
        let filtered = rows(cx);
        self.drop_shot(cx, "tree-filter").await;
        self.with_window(cx, {
            let tree = tree.clone();
            move |_, window, cx| tree.update(cx, |tree, cx| tree.type_in_search("zzq", window, cx))
        })?;
        let nothing = rows(cx);
        steps.check(
            "a letter typed in the tree opens the filter with it; only the matches and their folders show",
            opened.as_ref().is_some_and(|(text, query, _, focused)| text == "i" && query == "i" && *focused)
                && filtered == ["chapters", "chapters/intro.tex"]
                && nothing.is_empty(),
            json!({ "opened": opened, "filtered": filtered, "nothing": nothing }),
        );

        // "n0" matches notes/n01.md to n09.md; ↓ moves to the second and
        // Enter picks it, as a click does.
        self.with_window(cx, {
            let tree = tree.clone();
            move |_, window, cx| tree.update(cx, |tree, cx| tree.type_in_search("n0", window, cx))
        })?;
        let first = search(self, cx)?.and_then(|(.., focus, _)| focus);
        self.type_in_tree(cx, &tree, "down")?;
        self.type_in_tree(cx, &tree, "enter")?;
        let picked = self
            .wait_for(cx, Duration::from_secs(4), |shell, cx| {
                shell.read(cx).active_document(cx).as_deref() == Some("notes/n02.md")
            })
            .await;
        let closed = search(self, cx)?.is_none();
        let (selected, open) = cx.update(|cx| tree.read(cx).selection_state(cx));
        let shown = rows(cx);
        steps.check(
            "↓ and Enter pick a match as a click does, and the field closes with its folder open",
            first.as_deref() == Some("notes/n01.md")
                && picked
                && closed
                && selected == ["notes/n02.md"]
                && open.contains(&"notes".to_string())
                && shown.contains(&"main.tex".to_string()),
            json!({ "first": first, "picked": picked, "closed": closed, "selected": selected }),
        );

        // Escape closes the field, and the tree shows what it did.
        let all = rows(cx);
        // "c" leaves chapters/ and references.bib, and no note.
        self.type_in_tree(cx, &tree, "c")?;
        self.pause(cx, Duration::from_millis(100)).await;
        let narrowed = rows(cx).len() < all.len();
        self.type_in_tree(cx, &tree, "escape")?;
        self.pause(cx, Duration::from_millis(100)).await;
        steps.check(
            "Escape closes the filter and every row is back",
            narrowed && search(self, cx)?.is_none() && rows(cx) == all,
            json!({ "before_search": before.len(), "rows": rows(cx).len(), "narrowed": narrowed }),
        );

        // Scrolled a dozen rows into notes/, its row stays pinned at the top.
        cx.update(|cx| {
            tree.update(cx, |tree, cx| tree.reveal_paths(vec!["queue/q01.md".into()], cx))
        });
        self.wait_for(cx, Duration::from_secs(4), |_, cx| {
            tree.read(cx).row_paths(cx).contains(&"queue/q01.md".to_string())
        })
        .await;
        // The reveal's scroll lands with the next frames; then the top.
        self.pause(cx, Duration::from_millis(300)).await;
        self.frame_after_input(cx).await?;
        cx.update(|cx| tree.update(cx, |tree, cx| tree.scroll_rows_to(0., cx)));
        self.pause(cx, Duration::from_millis(200)).await;
        self.frame_after_input(cx).await?;
        let at = self.tree_row_center(cx, "notes/n01.md")?;
        let native = self.native(cx)?;
        native::send_mouse(native, native::Mouse::Moved, at)?;
        self.frame_after_input(cx).await?;
        // Pixel deltas: 9 × 40px, past chapters/ and a dozen rows down.
        for _ in 0..9 {
            native::send_wheel(native, at, -40)?;
            self.frame_after_input(cx).await?;
        }
        self.pause(cx, Duration::from_millis(300)).await;
        self.frame_after_input(cx).await?;
        let scrolled = cx.update(|cx| tree.read(cx).scrolled_rows(cx));
        let pinned = cx.update(|cx| tree.read(cx).pinned_state(cx));
        self.drop_shot(cx, "tree-sticky").await;
        let notes_ix = rows(cx).iter().position(|row| row == "notes").unwrap_or(0);
        steps.check(
            "a folder scrolled past stays pinned at the top while its rows go by",
            scrolled > notes_ix as f32 + 1. && pinned == [("notes".to_string(), 0.)],
            json!({ "scrolled_rows": scrolled, "pinned": pinned }),
        );

        // A click on the pinned row closes the folder and brings its row
        // back to the top.
        let pin = self.pinned_center(cx, &tree, scrolled)?;
        self.click_with(cx, pin, Modifiers::default()).await?;
        let collapsed = self
            .wait_for(cx, Duration::from_secs(2), |_, cx| {
                !tree.read(cx).row_paths(cx).contains(&"notes/n01.md".to_string())
            })
            .await;
        self.pause(cx, Duration::from_millis(250)).await;
        let (selected, _) = cx.update(|cx| tree.read(cx).selection_state(cx));
        let after = cx.update(|cx| tree.read(cx).scrolled_rows(cx));
        steps.check(
            "a click on a pinned folder closes it and scrolls its row back to the top",
            collapsed
                && selected == ["notes"]
                && (after - notes_ix as f32).abs() < 0.01
                && cx.update(|cx| tree.read(cx).pinned_state(cx)).is_empty(),
            json!({ "collapsed": collapsed, "selected": selected, "scrolled_rows": after }),
        );

        // Opening it again moves: its chevron and rows for 160ms, then rest.
        let notes = self.tree_row_center(cx, "notes")?;
        self.click_with(cx, notes, Modifiers::default()).await?;
        let moving = cx.update(|cx| tree.read(cx).motion_state(cx));
        self.pause(cx, Duration::from_millis(300)).await;
        self.frame_after_input(cx).await?;
        let rest = cx.update(|cx| tree.read(cx).motion_state(cx));
        // Closing it with reduced motion moves nothing.
        cx.update(|cx| cx.set_reduce_motion(true));
        let notes = self.tree_row_center(cx, "notes")?;
        self.click_with(cx, notes, Modifiers::default()).await?;
        let reduced = cx.update(|cx| tree.read(cx).motion_state(cx));
        cx.update(|cx| cx.set_reduce_motion(false));
        steps.check(
            "a folder opening moves its rows in the moderate tier, and reduced motion moves nothing",
            moving == Some(("notes".to_string(), true, NOTES))
                && rest.is_none()
                && reduced.is_none()
                && !rows(cx).contains(&"notes/n01.md".to_string()),
            json!({ "moving": moving, "rest": rest, "reduced": reduced }),
        );

        // The steps after these find the project as they left it.
        std::fs::remove_dir_all(root.join("notes"))?;
        std::fs::remove_dir_all(root.join("queue"))?;
        cx.update(|cx| tree.update(cx, |tree, cx| tree.refresh(cx)));
        self.wait_for(cx, Duration::from_secs(8), |_, cx| {
            !tree.read(cx).all_row_ids(cx).contains("notes")
                && !tree.read(cx).all_row_ids(cx).contains("queue")
        })
        .await;
        Ok(())
    }

    /// Type `key` in the tree: a key name ("down", "enter", "escape") or one
    /// character, sent as the keyboard sends it.
    fn type_in_tree(&self, cx: &mut AsyncApp, tree: &Entity<FileTreePanel>, key: &'static str) -> Result<()> {
        let tree = tree.clone();
        let mut keystroke = gpui::Keystroke::parse(key)?;
        if key.chars().count() == 1 {
            keystroke.key_char = Some(key.to_string());
        }
        self.with_window(cx, move |_, window, cx| {
            let focus = gpui::Focusable::focus_handle(tree.read(cx), cx);
            if !focus.contains_focused(window, cx) {
                window.focus(&focus, cx);
            }
            window.dispatch_event(
                PlatformInput::KeyDown(gpui::KeyDownEvent {
                    keystroke,
                    is_held: false,
                    prefer_character_input: false,
                }),
                cx,
            );
        })
    }

    /// The middle of the row pinned at the top, from a drawn row's bounds
    /// and the rows' scroll.
    fn pinned_center(
        &self,
        cx: &mut AsyncApp,
        tree: &Entity<FileTreePanel>,
        scrolled: f32,
    ) -> Result<Point<Pixels>> {
        cx.update(|cx| {
            let tree = tree.read(cx);
            let snapshot = tree.hover_snapshot(cx).context("the tree was drawn")?;
            let (ix, bounds, _) = snapshot.rows.first().context("a row is drawn")?;
            let top = bounds.top() - px((*ix as f32 - scrolled) * 28.);
            Ok(gpui::point(bounds.center().x, top + px(14.)))
        })
    }
}

/// This file's registration as the e2e module `tree_view` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 33,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/file_tree/search.rs",
        "gpui/crates/lattice-gpui/src/file_tree/sticky.rs",
        "gpui/crates/lattice-gpui/src/file_tree/motion.rs",
        "gpui/crates/lattice-gpui/src/file_tree/view.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.tree_view(cx, steps, &fixture.root)),
};
