//! Preview tabs, pinned tabs and tab eviction (`shell/tab_policy.rs`), as
//! the Tauri app keeps its document tabs, driven by the platform's own
//! pointer and key events:
//!
//! - A click on a tree row opens its file as the panel's preview tab, and
//!   the next one takes its place.
//! - A double-click on the row keeps the tab; so does an edit, each time
//!   the document comes back as a preview.
//! - A pinned preview is never replaced.
//! - A strip out of room closes the tabs it can spare, never a pinned,
//!   edited, root or front one.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Modifiers, MouseButton, PlatformInput, Pixels, Point};
use serde_json::json;

use super::Steps;
use crate::{native, scenario::Run};

/// Long names, so a strip runs out of room after a few.
const SHELF: usize = 9;

impl Run {
    async fn tab_policy(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        for name in ["alpha", "beta", "gamma", "delta"] {
            std::fs::write(root.join(format!("{name}.md")), format!("# {name}\n"))?;
        }
        for n in 1..=SHELF {
            std::fs::write(
                root.join(format!("a-long-chapter-name-{n:02}.md")),
                format!("# Chapter {n}\n"),
            )?;
        }
        let tree = cx.update(|cx| self.shell.read(cx).file_tree().clone());
        cx.update(|cx| tree.update(cx, |tree, cx| tree.refresh(cx)));
        self.wait_for(cx, Duration::from_secs(8), |_, cx| {
            tree.read(cx).row_paths(cx).contains(&"delta.md".to_string())
        })
        .await;
        let state = |cx: &mut AsyncApp, key: &str| {
            let key = key.to_string();
            cx.update(|cx| self.shell.read(cx).tab_state(&key, cx))
        };

        // A row's click opens a preview; the next row's takes its place.
        let alpha = self.tree_row_center(cx, "alpha.md")?;
        self.click_with(cx, alpha, Modifiers::default()).await?;
        self.wait_for(cx, Duration::from_secs(4), |shell, cx| {
            shell.read(cx).tab_state("alpha.md", cx).is_some()
        })
        .await;
        let first = state(cx, "alpha.md");
        let panel = first.as_ref().map(|(panel, ..)| panel.clone()).unwrap_or_default();
        let strip = |cx: &mut AsyncApp| {
            let panel = panel.clone();
            cx.update(|cx| self.shell.read(cx).strip_documents(&panel, cx))
        };
        let before = strip(cx);
        let beta = self.tree_row_center(cx, "beta.md")?;
        self.click_with(cx, beta, Modifiers::default()).await?;
        self.wait_for(cx, Duration::from_secs(4), |shell, cx| {
            shell.read(cx).tab_state("beta.md", cx).is_some()
        })
        .await;
        self.pause(cx, Duration::from_millis(200)).await;
        let (after_alpha, after_beta) = (state(cx, "alpha.md"), state(cx, "beta.md"));
        let after = strip(cx);
        // In alpha's place: the strip as it was, with beta for alpha, less
        // any tab a full strip spared.
        let expected: Vec<String> = before
            .iter()
            .map(|key| if key == "alpha.md" { "beta.md".to_string() } else { key.clone() })
            .filter(|key| after.contains(key))
            .collect();
        steps.check(
            "a tree row's click opens a preview tab, and the next row's takes its place",
            first.as_ref().is_some_and(|(_, _, preview, _)| *preview)
                && after_alpha.is_none()
                && after_beta.as_ref().is_some_and(|(_, _, preview, _)| *preview)
                && after == expected,
            json!({ "alpha": first, "before": before, "after": after, "beta": after_beta }),
        );

        // A double-click on the row keeps it.
        let beta = self.tree_row_center(cx, "beta.md")?;
        self.double_click(cx, beta).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let kept = state(cx, "beta.md");
        steps.check(
            "a double-click on the row keeps its tab",
            kept.as_ref().is_some_and(|(_, _, preview, _)| !*preview),
            json!({ "beta": kept }),
        );

        // An edit keeps a preview too.
        let gamma = self.tree_row_center(cx, "gamma.md")?;
        self.click_with(cx, gamma, Modifiers::default()).await?;
        self.wait_for(cx, Duration::from_secs(4), |shell, cx| {
            shell.read(cx).tab_state("gamma.md", cx).is_some()
        })
        .await;
        self.pause(cx, Duration::from_millis(300)).await;
        let previewed = state(cx, "gamma.md");
        let native = self.native(cx)?;
        native::send_key(native, 'x', false)?;
        let edited = self
            .wait_for(cx, Duration::from_secs(4), |shell, cx| {
                shell
                    .read(cx)
                    .tab_state("gamma.md", cx)
                    .is_some_and(|(_, _, preview, _)| !preview)
            })
            .await;
        steps.check(
            "an edit keeps a preview tab",
            previewed.as_ref().is_some_and(|(_, _, preview, _)| *preview) && edited,
            json!({ "gamma": previewed, "kept": edited }),
        );

        // Saved and closed, then a preview again, an edited document is kept
        // by its next edit, and the next quick look leaves it.
        let gamma_path = root.join("gamma.md").canonicalize()?;
        let editor = cx
            .update(|cx| self.shell.update(cx, |shell, cx| shell.open_editor(&gamma_path, cx)))
            .ok_or_else(|| anyhow::anyhow!("gamma.md has no editor"))?;
        cx.update(|cx| editor.update(cx, |editor, cx| editor.save(cx))).await?;
        self.close_tab(cx, editor)?;
        self.wait_for(cx, Duration::from_secs(4), |shell, cx| {
            shell.read(cx).tab_state("gamma.md", cx).is_none()
        })
        .await;
        let gamma = self.tree_row_center(cx, "gamma.md")?;
        self.click_with(cx, gamma, Modifiers::default()).await?;
        self.wait_for(cx, Duration::from_secs(4), |shell, cx| {
            shell.read(cx).tab_state("gamma.md", cx).is_some()
        })
        .await;
        self.pause(cx, Duration::from_millis(300)).await;
        let reopened = state(cx, "gamma.md");
        native::send_key(native, 'y', false)?;
        let rekept = self
            .wait_for(cx, Duration::from_secs(4), |shell, cx| {
                shell
                    .read(cx)
                    .tab_state("gamma.md", cx)
                    .is_some_and(|(_, _, preview, _)| !preview)
            })
            .await;
        let alpha = self.tree_row_center(cx, "alpha.md")?;
        self.click_with(cx, alpha, Modifiers::default()).await?;
        self.wait_for(cx, Duration::from_secs(4), |shell, cx| {
            shell.read(cx).tab_state("alpha.md", cx).is_some()
        })
        .await;
        self.pause(cx, Duration::from_millis(200)).await;
        let after_alpha = state(cx, "gamma.md");
        steps.check(
            "a document edited before, reopened as a preview and edited again is kept, and the next quick look leaves it",
            reopened.as_ref().is_some_and(|(_, _, preview, _)| *preview)
                && rekept
                && after_alpha.as_ref().is_some_and(|(_, _, preview, _)| !*preview),
            json!({ "reopened": reopened, "kept": rekept, "after_next": after_alpha }),
        );

        // A pinned preview stays when the next quick look comes.
        let delta = self.tree_row_center(cx, "delta.md")?;
        self.click_with(cx, delta, Modifiers::default()).await?;
        self.wait_for(cx, Duration::from_secs(4), |shell, cx| {
            shell.read(cx).tab_state("delta.md", cx).is_some()
        })
        .await;
        cx.update(|cx| self.shell.update(cx, |shell, cx| shell.pin_document("delta.md", true, cx)));
        let pinned = state(cx, "delta.md");
        let chapter = self.tree_row_center(cx, "a-long-chapter-name-01.md")?;
        self.click_with(cx, chapter, Modifiers::default()).await?;
        self.wait_for(cx, Duration::from_secs(4), |shell, cx| {
            shell.read(cx).tab_state("a-long-chapter-name-01.md", cx).is_some()
        })
        .await;
        self.pause(cx, Duration::from_millis(200)).await;
        // delta.md pinned, the chapter its panel's preview in italics.
        self.drop_shot(cx, "tabs-preview-pinned").await;
        let still = state(cx, "delta.md");
        steps.check(
            "Pin tab keeps a preview, and the next quick look leaves it",
            pinned.as_ref().is_some_and(|(_, _, preview, pinned)| !*preview && *pinned)
                && still.as_ref().is_some_and(|(_, _, _, pinned)| *pinned),
            json!({ "pinned": pinned, "after_next": still }),
        );

        // Opened kept, one after another, the chapters run the strip out of
        // room: it closes what it can spare, never the pinned, the edited,
        // the root or the front tab.
        for n in 2..=SHELF {
            let path = root.join(format!("a-long-chapter-name-{n:02}.md"));
            self.open(cx, &path, None)?;
            self.pause(cx, Duration::from_millis(250)).await;
        }
        let last = format!("a-long-chapter-name-{SHELF:02}.md");
        let open: Vec<String> = cx.update(|cx| {
            (1..=SHELF)
                .map(|n| format!("a-long-chapter-name-{n:02}.md"))
                .filter(|key| self.shell.read(cx).tab_state(key, cx).is_some())
                .collect()
        });
        let kept: Vec<(&str, bool)> = cx.update(|cx| {
            ["delta.md", "gamma.md", "main.tex", last.as_str()]
                .into_iter()
                .map(|key| (key, self.shell.read(cx).tab_state(key, cx).is_some()))
                .collect()
        });
        steps.check(
            "a strip out of room closes the tabs it can spare, never a pinned, edited, root or front one",
            open.len() < SHELF && kept.iter().all(|(_, open)| *open),
            json!({ "chapters_open": open, "kept": kept }),
        );

        // The steps after these find the project as they left it.
        cx.update(|cx| self.shell.update(cx, |shell, cx| shell.pin_document("delta.md", false, cx)));
        Ok(())
    }

    /// A double-click at `at`, as the platform sends it.
    async fn double_click(&self, cx: &mut AsyncApp, at: Point<Pixels>) -> Result<()> {
        for click_count in [1, 2] {
            for event in [
                PlatformInput::MouseDown(gpui::MouseDownEvent {
                    button: MouseButton::Left,
                    position: at,
                    modifiers: Modifiers::default(),
                    click_count,
                    first_mouse: false,
                }),
                PlatformInput::MouseUp(gpui::MouseUpEvent {
                    button: MouseButton::Left,
                    position: at,
                    modifiers: Modifiers::default(),
                    click_count,
                }),
            ] {
                self.with_window(cx, |_, window, cx| {
                    window.dispatch_event(event, cx);
                })?;
            }
            self.frame_after_input(cx).await?;
        }
        Ok(())
    }
}

/// This file's registration as the e2e module `tab_policy` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 34,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/tab_policy.rs",
        "gpui/crates/lattice-ui/src/components/tab.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.tab_policy(cx, steps, &fixture.root)),
};
