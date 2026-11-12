//! The e2e scenario's shell steps (macOS and Windows): a dock's last panel
//! dragged out with native mouse events, the Writing preset and the way
//! back, a named workspace keeping its own arrangement, a panel closed from
//! its tab and brought back from the Panels menu, a panel floated and docked,
//! the command palette listing the commands, and the window's commands
//! still reaching the shell once the focused document's tab is closed.

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Focusable as _};
use gpui_kit::component::dock::DockPlacement;
use serde_json::{Value, json};

use super::Run;
use crate::shell::{
    commands::{CloseTab, CommandPalette, ReopenClosedTab},
    layout::{Preset, View},
};

/// What one step found: its name, whether it passed, and what it saw.
pub(super) type Step = (&'static str, bool, Value);

impl Run {
    pub(super) async fn shell_steps(&self, cx: &mut AsyncApp) -> Result<Vec<Step>> {
        let mut steps = Vec::new();
        steps.push(self.drag_last_panel_out(cx).await?);
        steps.push(self.writing_preset_round_trip(cx).await?);
        steps.push(self.workspace_keeps_its_arrangement(cx).await?);
        steps.push(self.close_and_bring_back(cx).await?);
        steps.push(self.float_and_dock(cx).await?);
        steps.push(self.palette_lists_commands(cx).await?);
        steps.push(self.closing_the_focused_tab_keeps_the_keyboard(cx).await?);
        Ok(steps)
    }

    fn reset_layout(&self, cx: &mut AsyncApp) -> Result<()> {
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.reset_layout(window, cx))
        })
    }

    /// The PDF, alone in the right dock, dragged by its tab into the center:
    /// GPUI Kit kept a region's last panel, Trellis lets it go and its dock
    /// with it (`patches/gpui-base-dock-drag-out.diff`).
    async fn drag_last_panel_out(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        let (area_bounds, left_width, right_width) = cx.update(|cx| {
            let area = self.shell.read(cx).dock_area().read(cx);
            (
                area.bounds(),
                area.dock_size(DockPlacement::Left).unwrap_or_default(),
                area.dock_size(DockPlacement::Right),
            )
        });
        let right_width = right_width.context("there is no right dock")?;
        // The PDF tab's icon, as the editor's is found in the writing flow.
        let from = gpui::point(
            area_bounds.right() - right_width
                + lattice_ui::dock::GROUP_INSET
                + gpui::px(6. + 14.)
                + lattice_ui::icons::ICON / 2.,
            area_bounds.top() + gpui::px(18.),
        );
        // The middle of the center's card.
        let center_left = area_bounds.left() + left_width;
        let to = gpui::point(
            center_left + (area_bounds.right() - right_width - center_left) / 2.,
            area_bounds.top() + area_bounds.size.height / 2.,
        );
        let mut detail = self.native_drag(cx, from, to).await?;
        let arrangement = cx.update(|cx| {
            serde_json::to_value(self.shell.read(cx).current_arrangement(cx)).unwrap_or_default()
        });
        let (right_dock, pdf_in_center) = cx.update(|cx| {
            let shell = self.shell.read(cx);
            let area = shell.dock_area().read(cx);
            let pdf = shell.singleton_panel(&View::Pdf);
            (
                area.has_dock(DockPlacement::Right),
                pdf.is_some_and(|pdf| {
                    area.layout(DockPlacement::Center)
                        .is_some_and(|tree| tree.find_panel_node(pdf).is_some())
                }),
            )
        });
        detail["right_dock"] = json!(right_dock);
        detail["pdf_in_center"] = json!(pdf_in_center);
        detail["arrangement"] = arrangement;
        Ok((
            "the PDF drags out of its dock into the center, and the dock goes",
            !right_dock && pdf_in_center,
            detail,
        ))
    }

    /// Writing gathers the documents beside the PDF and puts the navigators
    /// away; choosing it again returns to the layout as it was.
    async fn writing_preset_round_trip(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        let (before, during, after) = self.with_window(cx, |shell, window, cx| {
            let before = shell.read(cx).current_arrangement(cx);
            shell.update(cx, |shell, cx| {
                shell.set_preset(Preset::Writing, window, cx)
            });
            let during = shell.read(cx).current_arrangement(cx);
            shell.update(cx, |shell, cx| {
                shell.set_preset(Preset::Writing, window, cx)
            });
            let after = shell.read(cx).current_arrangement(cx);
            (before, during, after)
        })?;
        let laid = during.left.is_none()
            && during
                .right
                .as_ref()
                .is_some_and(|dock| dock.node.views().contains(&&View::Pdf))
            && !during.documents().is_empty();
        let back = after.shape() == before.shape();
        Ok((
            "the Writing preset puts the documents beside the PDF and returns",
            laid && back,
            json!({ "laid": laid, "back": back }),
        ))
    }

    /// A new workspace holds the arrangement it was made from; widened, it
    /// shows the dot until it is saved, and then keeps its width while the
    /// first workspace keeps its own. Each change is its own update, so the
    /// dock's change events reach the shell between them, as they do when
    /// the writer makes them.
    async fn workspace_keeps_its_arrangement(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        let left = |run: &Self, cx: &mut AsyncApp| {
            cx.update(|cx| {
                run.shell
                    .read(cx)
                    .dock_area()
                    .read(cx)
                    .dock_size(DockPlacement::Left)
                    .map(f32::from)
            })
        };
        let first = cx.update(|cx| self.shell.read(cx).layout.workspace.clone());
        let original = left(self, cx);
        let second = self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                let id = shell.new_workspace(window, cx);
                shell.finish_rename(window, cx);
                id
            })
        })?;
        self.with_window(cx, |shell, window, cx| {
            let area = shell.read(cx).dock_area().clone();
            area.update(cx, |area, cx| {
                area.set_dock_size(DockPlacement::Left, gpui::px(400.), window, cx)
            });
        })?;
        let dirty = cx.update(|cx| self.shell.read(cx).layout.dirty);
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.save_workspace(window, cx))
        })?;
        let saved_clean = cx.update(|cx| !self.shell.read(cx).layout.dirty);
        let switch = |run: &Self, cx: &mut AsyncApp, id: &str| {
            let id = id.to_string();
            run.with_window(cx, move |shell, window, cx| {
                shell.update(cx, |shell, cx| shell.switch_workspace(&id, window, cx))
            })
        };
        let first = first.context("the project is in no workspace")?;
        switch(self, cx, &first)?;
        let in_first = left(self, cx);
        switch(self, cx, &second)?;
        let in_second = left(self, cx);
        switch(self, cx, &first)?;
        let passed = dirty && saved_clean && in_first == original && in_second == Some(400.);
        Ok((
            "a new workspace keeps its own arrangement, the dot until it is saved",
            passed,
            json!({
                "original": original,
                "dirty_after_resize": dirty,
                "clean_after_save": saved_clean,
                "first": in_first,
                "second": in_second,
            }),
        ))
    }

    /// Project's tab X takes it off screen; the Panels toggle brings it back.
    async fn close_and_bring_back(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        let (closed, back) = self.with_window(cx, |shell, window, cx| {
            let project = shell.read(cx).singleton_panel(&View::Project);
            if let Some(project) = project {
                shell.update(cx, |shell, cx| shell.close_panel(project, window, cx));
            }
            let closed = !shell.read(cx).view_on_screen(&View::Project, cx);
            shell.update(cx, |shell, cx| shell.toggle_view(View::Project, window, cx));
            let back = shell.read(cx).view_on_screen(&View::Project, cx);
            (closed, back)
        })?;
        Ok((
            "closing Project's tab hides it and the Panels toggle brings it back",
            closed && back,
            json!({ "closed": closed, "back": back }),
        ))
    }

    /// The PDF floats over the dock, its dock going; Dock puts it back.
    async fn float_and_dock(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        let (floated, docked) = self.with_window(cx, |shell, window, cx| {
            let Some(pdf) = shell.read(cx).singleton_panel(&View::Pdf) else {
                return (false, false);
            };
            shell.update(cx, |shell, cx| shell.toggle_float(pdf, window, cx));
            let floated = shell.read(cx).floating.contains(pdf)
                && !shell
                    .read(cx)
                    .dock_area()
                    .read(cx)
                    .has_dock(DockPlacement::Right);
            shell.update(cx, |shell, cx| shell.toggle_float(pdf, window, cx));
            let docked = !shell.read(cx).floating.contains(pdf)
                && shell
                    .read(cx)
                    .dock_area()
                    .read(cx)
                    .layout(DockPlacement::Right)
                    .is_some_and(|tree| tree.find_panel_node(pdf).is_some());
            (floated, docked)
        })?;
        Ok((
            "the PDF floats over the dock and docks back on the right",
            floated && docked,
            json!({ "floated": floated, "docked": docked }),
        ))
    }

    async fn palette_lists_commands(&self, cx: &mut AsyncApp) -> Result<Step> {
        let rows = self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_palette(window, cx));
            let rows = shell.read(cx).palette_rows(cx);
            shell.update(cx, |shell, cx| shell.close_overlays(window, cx));
            rows
        })?;
        Ok((
            "the command palette lists the commands",
            rows.is_some_and(|rows| rows >= 10),
            json!({ "rows": rows }),
        ))
    }

    /// ⌘W on the focused document closes its tab, and the window's commands
    /// still reach the shell: the palette opens from the keyboard after it.
    async fn closing_the_focused_tab_keeps_the_keyboard(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        let (closed, editor_focused) = self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.focus_front(window, cx));
            let before = shell.read(cx).current_arrangement(cx).documents();
            let editor_focused = shell.read(cx).active_editor().is_some_and(|editor| {
                editor
                    .read(cx)
                    .editor()
                    .focus_handle(cx)
                    .contains_focused(window, cx)
            });
            window.dispatch_action(Box::new(CloseTab), cx);
            let after = shell.read(cx).current_arrangement(cx).documents();
            (after.len() + 1 == before.len(), editor_focused)
        })?;
        self.frame_after_input(cx).await?;
        let rows = self.with_window(cx, |shell, window, cx| {
            window.dispatch_action(Box::new(CommandPalette), cx);
            let rows = shell.read(cx).palette_rows(cx);
            shell.update(cx, |shell, cx| shell.close_overlays(window, cx));
            window.dispatch_action(Box::new(ReopenClosedTab), cx);
            rows
        })?;
        Ok((
            "closing the focused document's tab leaves the window's commands working",
            editor_focused && closed && rows.is_some(),
            json!({ "editor_focused": editor_focused, "closed": closed, "palette_rows": rows }),
        ))
    }
}
