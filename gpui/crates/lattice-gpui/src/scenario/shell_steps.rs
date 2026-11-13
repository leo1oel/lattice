//! The e2e scenario's shell steps (macOS and Windows), on the Trellis
//! workspace: a panel dragged by its tab with native mouse events to a
//! panel's edge (a new split) and into its middle (a tab), the focused panel
//! maximized and restored, the Writing preset and the way back, a named
//! workspace keeping its own arrangement, a panel closed from its tab and
//! brought back from the Panels menu, a panel floated and docked, the
//! layout surviving a relaunch, the command palette listing the commands,
//! and the window's commands still reaching the shell once the focused
//! document's tab is closed.

use anyhow::{Context as _, Result};
use gpui::{App, AsyncApp, Bounds, Entity, Focusable as _, Pixels, Window};
use serde_json::{Value, json};
use trellis::model::{LayoutDocument, LayoutNode, panel_of_view};
use trellis::runtime::engine::{MenuAction, ViewPlacement};
use trellis::runtime::keymap::Command as Trellis;

use super::Run;
use crate::shell::{
    Shell,
    commands::{CloseTab, CommandPalette, ReopenClosedTab},
    trellis_layout::{Preset, arrangement_of, layout_shape},
    views::documents_of,
    workspaces::{ProjectLayout, Workspaces},
};

/// What one step found: its name, whether it passed, and what it saw.
pub(super) type Step = (&'static str, bool, Value);

/// The panel holding `view`, in `doc`.
fn panel_with(doc: &LayoutDocument, view: &str) -> Option<String> {
    panel_of_view(doc, view).map(|panel| panel.id.clone())
}

/// A layout's arrangement, as a workspace compares it.
fn shape(doc: &LayoutDocument) -> String {
    layout_shape(&arrangement_of(doc))
}

impl Run {
    pub(super) async fn shell_steps(&self, cx: &mut AsyncApp) -> Result<Vec<Step>> {
        let mut steps = Vec::new();
        steps.push(self.drag_to_split(cx).await?);
        steps.push(self.drag_into_tabs(cx).await?);
        steps.push(self.maximize_and_restore(cx).await?);
        steps.push(self.writing_preset_round_trip(cx).await?);
        steps.push(self.workspace_keeps_its_arrangement(cx).await?);
        steps.push(self.close_and_bring_back(cx).await?);
        steps.push(self.float_and_dock(cx).await?);
        steps.push(self.press_on_a_float_reaches_only_the_float(cx).await?);
        steps.push(self.hide_and_restore(cx).await?);
        steps.push(self.layout_survives_a_relaunch(cx).await?);
        steps.push(self.palette_lists_commands(cx).await?);
        steps.push(self.closing_the_focused_tab_keeps_the_keyboard(cx).await?);
        Ok(steps)
    }

    fn reset_layout(&self, cx: &mut AsyncApp) -> Result<()> {
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.reset_layout(window, cx))
        })
    }

    /// Draw frames until the workspace's motion is over (at most 3 s), so
    /// every panel is where the layout puts it. Returns the frames drawn.
    pub(super) async fn settle_workspace(&self, cx: &mut AsyncApp) -> Result<usize> {
        let mut frames = 0;
        for _ in 0..60 {
            self.frame_after_input(cx).await?;
            frames += 1;
            let moving = cx.update(|cx| self.shell.read(cx).workspace().read(cx).engine().moving());
            if !moving && frames > 1 {
                break;
            }
            super::sleep(cx, std::time::Duration::from_millis(50)).await;
        }
        Ok(frames)
    }

    fn document(&self, cx: &mut AsyncApp) -> LayoutDocument {
        cx.update(|cx| self.shell.read(cx).document(cx))
    }

    /// A panel's bounds in the window, as last drawn.
    fn panel_bounds(&self, cx: &mut AsyncApp, panel: &str) -> Option<Bounds<Pixels>> {
        cx.update(|cx| self.shell.read(cx).workspace().read(cx).panel_bounds(panel))
    }

    /// The panel of the active document, after a reset: the documents'.
    fn documents_panel(&self, cx: &mut AsyncApp) -> Result<String> {
        cx.update(|cx| {
            let shell = self.shell.read(cx);
            let key = shell.active_document(cx)?;
            let view = shell.view_of_document(&key, cx)?;
            panel_with(&shell.document(cx), &view)
        })
        .context("no document is open")
    }

    /// Drag a view by its tab (the first tab of its panel) to `to`, a point
    /// given as fractions of panel `onto`.
    async fn drag_tab(
        &self,
        cx: &mut AsyncApp,
        view: &str,
        onto: &str,
        to: (f32, f32),
    ) -> Result<Value> {
        let doc = self.document(cx);
        let from_panel = panel_with(&doc, view).context("the view is in no panel")?;
        let from = self
            .panel_bounds(cx, &from_panel)
            .context("its panel is not drawn")?;
        let drawn = cx.update(|cx| {
            let workspace = self.shell.read(cx).workspace().read(cx);
            format!(
                "workspace bounds {:?}, viewport {:?}, panels {:?}",
                workspace.bounds(),
                workspace.engine().viewport(),
                trellis::model::panels_of(doc.root.as_ref())
                    .iter()
                    .map(|panel| (panel.id.clone(), workspace.engine().panel_rect(&panel.id)))
                    .collect::<Vec<_>>()
            )
        });
        let onto = self
            .panel_bounds(cx, onto)
            .with_context(|| format!("the target panel {onto} is not drawn: {drawn}"))?;
        // The tab's icon: 6px into the strip, 14px into the tab, mid-strip.
        let from = gpui::point(
            from.left() + gpui::px(6. + 14.) + lattice_ui::icons::ICON / 2.,
            from.top() + gpui::px(20.),
        );
        let to = gpui::point(
            onto.left() + onto.size.width * to.0,
            onto.top() + onto.size.height * to.1,
        );
        let detail = self.native_drag(cx, from, to).await;
        self.settle_workspace(cx).await?;
        detail
    }

    /// The PDF dragged by its tab onto the documents' left edge: the drop
    /// slot there becomes a new split, the PDF left of the documents.
    async fn drag_to_split(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        self.settle_workspace(cx).await?;
        let documents = self.documents_panel(cx)?;
        let mut detail = self.drag_tab(cx, "pdf", &documents, (0.08, 0.5)).await?;
        let doc = self.document(cx);
        let pdf = panel_with(&doc, "pdf");
        let pdf_rect = pdf
            .as_deref()
            .and_then(|panel| self.panel_bounds(cx, panel));
        let doc_rect = self.panel_bounds(cx, &documents);
        let split = pdf.as_deref().is_some_and(|pdf| pdf != documents);
        let left_of =
            matches!((pdf_rect, doc_rect), (Some(pdf), Some(doc)) if pdf.left() < doc.left());
        detail["pdf_panel"] = json!(pdf);
        detail["documents_panel"] = json!(documents);
        detail["shape"] = json!(shape(&doc));
        Ok((
            "the PDF dragged to the documents' left edge splits beside them",
            split && left_of,
            detail,
        ))
    }

    /// The PDF dragged by its tab into the documents' middle joins their
    /// tabs, and the panel it left closes up.
    async fn drag_into_tabs(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        self.settle_workspace(cx).await?;
        let documents = self.documents_panel(cx)?;
        // The PDF's panel closes up once the PDF leaves it, unless other
        // PDFs' tabs (another root document's) stay in it.
        let before = self.document(cx);
        let alone = panel_of_view(&before, "pdf").is_some_and(|panel| panel.views.len() == 1);
        let from = panel_with(&before, "pdf");
        let mut detail = self.drag_tab(cx, "pdf", &documents, (0.5, 0.55)).await?;
        let doc = self.document(cx);
        let joined = panel_with(&doc, "pdf").as_deref() == Some(documents.as_str());
        let gone = !alone
            || !trellis::model::panels_of(doc.root.as_ref())
                .iter()
                .any(|panel| Some(&panel.id) == from.as_ref());
        detail["joined"] = json!(joined);
        detail["left_panel_gone"] = json!(gone);
        Ok((
            "the PDF dragged into the documents' middle becomes their tab",
            joined && gone,
            detail,
        ))
    }

    /// ⌘⇧↩ frames the focused panel to the whole workspace, and again
    /// brings the layout back.
    async fn maximize_and_restore(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        self.settle_workspace(cx).await?;
        let documents = self.documents_panel(cx)?;
        let before = self.panel_bounds(cx, &documents);
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                let view = shell
                    .active_document(cx)
                    .and_then(|key| shell.view_of_document(&key, cx));
                if let Some(view) = view {
                    shell.engine_do(cx, |engine| engine.focus_view(&view));
                }
                shell.run_trellis(Trellis::FrameToggle, cx);
            })
        })?;
        self.settle_workspace(cx).await?;
        let framed = cx.update(|cx| {
            self.shell
                .read(cx)
                .workspace()
                .read(cx)
                .engine()
                .framed()
                .map(str::to_string)
        });
        let during = self.panel_bounds(cx, &documents);
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| shell.run_trellis(Trellis::FrameToggle, cx))
        })?;
        self.settle_workspace(cx).await?;
        let restored = cx.update(|cx| {
            self.shell
                .read(cx)
                .workspace()
                .read(cx)
                .engine()
                .framed()
                .is_none()
        });
        let after = self.panel_bounds(cx, &documents);
        let width = |b: Option<Bounds<Pixels>>| b.map(|b| f32::from(b.size.width));
        let grew = matches!((width(before), width(during)), (Some(a), Some(b)) if b > a + 100.);
        let back =
            matches!((width(before), width(after)), (Some(a), Some(b)) if (a - b).abs() < 2.);
        Ok((
            "the focused panel maximizes to the workspace and restores",
            framed.as_deref() == Some(documents.as_str()) && grew && restored && back,
            json!({
                "framed": framed,
                "width_before": width(before),
                "width_maximized": width(during),
                "width_after": width(after),
            }),
        ))
    }

    /// Writing gathers the documents beside the PDF and puts the navigators
    /// away, hidden; choosing it again returns to the layout as it was.
    async fn writing_preset_round_trip(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        let (before, during, after) = self.with_window(cx, |shell, window, cx| {
            let before = shell.read(cx).document(cx);
            shell.update(cx, |shell, cx| {
                shell.set_preset(Preset::Writing, window, cx)
            });
            let during = shell.read(cx).document(cx);
            shell.update(cx, |shell, cx| {
                shell.set_preset(Preset::Writing, window, cx)
            });
            let after = shell.read(cx).document(cx);
            (before, during, after)
        })?;
        let ids: Vec<String> = trellis::model::panels_of(during.root.as_ref())
            .iter()
            .map(|panel| panel.id.clone())
            .collect();
        let laid = ids == ["panel-writing", "panel-pdf"]
            && during
                .hidden
                .iter()
                .any(|entry| entry.panel.views.iter().any(|view| view == "project"));
        let back = shape(&after) == shape(&before);
        Ok((
            "the Writing preset puts the documents beside the PDF and returns",
            laid && back,
            json!({ "during": ids, "laid": laid, "back": back }),
        ))
    }

    /// A new workspace holds the arrangement it was made from; widened, it
    /// shows the dot until it is saved, and then keeps its width while the
    /// first workspace keeps its own.
    async fn workspace_keeps_its_arrangement(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        let left = |run: &Self, cx: &mut AsyncApp| {
            let doc = run.document(cx);
            match doc.root {
                Some(LayoutNode::Split(root)) => {
                    root.weights.first().map(|w| (w * 1000.).round() / 1000.)
                }
                _ => None,
            }
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
        // The navigators' column widened, as a divider drag leaves it.
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                let mut doc = shell.document(cx);
                if let Some(LayoutNode::Split(root)) = &mut doc.root
                    && root.weights.len() > 1
                {
                    root.weights[0] = 0.4;
                    let rest: f64 = root.weights[1..].iter().sum();
                    for weight in &mut root.weights[1..] {
                        *weight *= 0.6 / rest;
                    }
                }
                shell.engine_do(cx, |engine| engine.set_document(doc, false));
            })
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
        let passed = dirty && saved_clean && in_first == original && in_second == Some(0.4);
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

    /// Project's tab X closes it; the Panels toggle brings it back where it
    /// belongs, with the Agent.
    async fn close_and_bring_back(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        self.settle_workspace(cx).await?;
        self.with_window(cx, |shell, _, cx| {
            let workspace = shell.read(cx).workspace().clone();
            workspace.update(cx, |workspace, cx| workspace.close(&["project".into()], cx))
        })?;
        self.settle_workspace(cx).await?;
        let closed = cx.update(|cx| !self.shell.read(cx).view_on_screen("project", cx));
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.toggle_view("project", window, cx))
        })?;
        // Whether a view shows is known once a frame lays it out.
        self.settle_workspace(cx).await?;
        let (back, with_agent) = cx.update(|cx| {
            let shell = self.shell.read(cx);
            let doc = shell.document(cx);
            let with_agent = panel_with(&doc, "project").is_some()
                && panel_with(&doc, "project") == panel_with(&doc, "agent");
            (shell.view_on_screen("project", cx), with_agent)
        });
        Ok((
            "closing Project's tab closes it and the Panels toggle brings it back beside the Agent",
            closed && back && with_agent,
            json!({ "closed": closed, "back": back, "with_agent": with_agent }),
        ))
    }

    /// The PDF floats over the workspace, its panel's room going to its
    /// neighbours; Dock puts it back.
    async fn float_and_dock(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        let (floated, docked) = self.with_window(cx, |shell, _, cx| {
            let placement = |shell: &Entity<Shell>, cx: &mut App| {
                shell
                    .read(cx)
                    .workspace()
                    .read(cx)
                    .engine()
                    .placement_of("pdf")
            };
            let run = |shell: &Entity<Shell>, action: MenuAction, cx: &mut App| {
                shell.update(cx, |shell, cx| {
                    shell.engine_do(cx, |engine| engine.run_menu_action(&action));
                })
            };
            run(shell, MenuAction::Float("pdf".into()), cx);
            let floated = placement(shell, cx) == ViewPlacement::Floating;
            run(shell, MenuAction::Dock("pdf".into()), cx);
            let docked = placement(shell, cx) == ViewPlacement::Docked;
            (floated, docked)
        })?;
        Ok((
            "the PDF floats over the workspace and docks back",
            floated && docked,
            json!({ "floated": floated, "docked": docked }),
        ))
    }

    /// A native double click on a floating panel's tab, over a docked
    /// panel, reaches only the float: its view takes focus, and the docked
    /// panel beneath is not maximized (an overlay float has no frame of its
    /// own, so nothing is).
    async fn press_on_a_float_reaches_only_the_float(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        self.settle_workspace(cx).await?;
        let documents = self.documents_panel(cx)?;
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                shell.engine_do(cx, |engine| {
                    engine.run_menu_action(&MenuAction::Float("pdf".into()))
                });
            })
        })?;
        self.settle_workspace(cx).await?;
        let float = panel_with(&self.document(cx), "pdf").context("the PDF is in no panel")?;
        let float_bounds = self.panel_bounds(cx, &float).context("the float is not drawn")?;
        let at = gpui::point(
            float_bounds.left() + gpui::px(6. + 14.) + lattice_ui::icons::ICON / 2.,
            float_bounds.top() + gpui::px(20.),
        );
        let doc = self.document(cx);
        let mut covered = Vec::new();
        for panel in trellis::model::all_panels(&doc) {
            if panel.id != float
                && let Some(b) = self.panel_bounds(cx, &panel.id)
                && b.contains(&at)
            {
                covered.push(panel.id.clone());
            }
        }
        // Focus somewhere else first, so the press must move it.
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                let view = shell
                    .active_document(cx)
                    .and_then(|key| shell.view_of_document(&key, cx));
                if let Some(view) = view {
                    shell.engine_do(cx, |engine| engine.focus_view(&view));
                }
            })
        })?;
        self.frame_after_input(cx).await?;
        crate::native::send_double_click(self.native(cx)?, at)?;
        self.frame_after_input(cx).await?;
        self.settle_workspace(cx).await?;
        let (framed, focused) = cx.update(|cx| {
            let ws = self.shell.read(cx).workspace().read(cx);
            (
                ws.engine().framed().map(str::to_string),
                ws.engine().focused_view().map(str::to_string),
            )
        });
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                if shell.workspace().read(cx).engine().framed().is_some() {
                    shell.run_trellis(Trellis::FrameToggle, cx);
                }
                shell.engine_do(cx, |engine| {
                    engine.run_menu_action(&MenuAction::Dock("pdf".into()))
                });
            })
        })?;
        self.settle_workspace(cx).await?;
        Ok((
            "a double click on a floating panel's tab reaches the float, not the docked panel beneath it",
            !covered.is_empty()
                && framed.as_ref().is_none_or(|f| !covered.contains(f))
                && focused.as_deref() == Some("pdf"),
            json!({
                "float": float,
                "documents": documents,
                "at": [f32::from(at.x), f32::from(at.y)],
                "covered": covered,
                "framed": framed,
                "focused": focused,
            }),
        ))
    }

    /// Hide puts Papers away with its place kept; its titlebar chip brings
    /// it back there.
    async fn hide_and_restore(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        self.settle_workspace(cx).await?;
        let before = shape(&self.document(cx));
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| shell.hide_view("papers", cx))
        })?;
        self.settle_workspace(cx).await?;
        let chips = cx.update(|cx| self.shell.read(cx).hidden_panels(cx));
        let hidden = cx.update(|cx| !self.shell.read(cx).view_on_screen("papers", cx));
        if let Some((panel, _)) = chips.first().cloned() {
            self.with_window(cx, move |shell, _, cx| {
                shell.update(cx, |shell, cx| shell.restore_panel(&panel, cx))
            })?;
        }
        self.settle_workspace(cx).await?;
        let back = cx.update(|cx| self.shell.read(cx).view_on_screen("papers", cx));
        let same = shape(&self.document(cx)) == before;
        Ok((
            "Hide puts a panel away with a titlebar chip that brings it back where it was",
            hidden && chips.len() == 1 && back && same,
            json!({ "hidden": hidden, "chips": chips, "back": back, "same_place": same }),
        ))
    }

    /// The layout as it is now, written to a state directory and read back
    /// by a library loaded afresh, as the next launch reads it.
    async fn layout_survives_a_relaunch(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        self.settle_workspace(cx).await?;
        let documents = self.documents_panel(cx)?;
        // A layout of the writer's own: the PDF split beside the documents.
        self.drag_tab(cx, "pdf", &documents, (0.08, 0.5)).await?;
        let (root, doc) = cx.update(|cx| {
            let shell = self.shell.read(cx);
            (shell.root(cx), shell.document(cx))
        });
        let root = root.context("no project is open")?;
        let dir =
            std::env::temp_dir().join(format!("lattice-gpui-relaunch-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        {
            let mut library = Workspaces::load(Some(dir.clone()));
            library.save_project(
                &root,
                ProjectLayout {
                    document: Some(doc.clone()),
                    ..ProjectLayout::default()
                },
            );
        }
        let read = Workspaces::load(Some(dir.clone())).project(&root).document;
        std::fs::remove_dir_all(&dir).ok();
        let same = read.as_ref().is_some_and(|read| shape(read) == shape(&doc));
        Ok((
            "the layout comes back as it was after a relaunch",
            same,
            json!({ "saved": shape(&doc), "read": read.as_ref().map(shape) }),
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

    /// ⌘W on the focused document closes its tab, and the keyboard stays in
    /// the window, under the shell, so the window's commands still reach it
    /// and the palette opens from it. A dispatched action runs once the
    /// update that sent it is over, so each is looked at in a later one; and
    /// focus is read through the last drawn frame's dispatch tree, so it is
    /// looked at only after a frame (`frame_after_input`).
    async fn closing_the_focused_tab_keeps_the_keyboard(&self, cx: &mut AsyncApp) -> Result<Step> {
        self.reset_layout(cx)?;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.focus_front(window, cx))
        })?;
        self.frame_after_input(cx).await?;
        let (before, focus_before) = self.with_window(cx, |shell, window, cx| {
            let before = documents_of(&shell.read(cx).document(cx));
            (before, keyboard_holder(shell, window, cx))
        })?;
        self.with_window(cx, |_, window, cx| {
            window.dispatch_action(Box::new(CloseTab), cx)
        })?;
        self.frame_after_input(cx).await?;
        let (closed, focus_after) = self.with_window(cx, |shell, window, cx| {
            let after = documents_of(&shell.read(cx).document(cx));
            (
                after.len() + 1 == before.len(),
                keyboard_holder(shell, window, cx),
            )
        })?;
        let editor_focused = focus_before == "the active editor";
        let keyboard_kept = matches!(
            focus_after,
            "the shell" | "the active editor" | "inside the shell"
        );
        self.with_window(cx, |_, window, cx| {
            window.dispatch_action(Box::new(CommandPalette), cx)
        })?;
        self.frame_after_input(cx).await?;
        let rows = self.with_window(cx, |shell, window, cx| {
            let rows = shell.read(cx).palette_rows(cx);
            shell.update(cx, |shell, cx| shell.close_overlays(window, cx));
            rows
        })?;
        self.with_window(cx, |_, window, cx| {
            window.dispatch_action(Box::new(ReopenClosedTab), cx)
        })?;
        self.frame_after_input(cx).await?;
        let reopened = self.with_window(cx, |shell, _, cx| {
            documents_of(&shell.read(cx).document(cx)).len() == before.len()
        })?;
        Ok((
            "closing the focused document's tab leaves the keyboard in the window",
            editor_focused && closed && keyboard_kept && rows.is_some() && reopened,
            json!({
                "focus_before": focus_before,
                "closed": closed,
                "focus_after": focus_after,
                "palette_rows": rows,
                "reopened": reopened,
            }),
        ))
    }
}

/// Where the keyboard is, for a step's detail: on the shell's own handle, on
/// the editor of the document in front (the one `focus_front` hands the
/// keyboard to), elsewhere inside the shell (whose actions still bubble to
/// the shell's handlers), outside it, or nowhere. Read after a drawn frame,
/// since containment goes through that frame's dispatch tree.
///
/// The front document's editor is looked up from the arrangement, not from
/// the shell's last-focused editor: that one follows GPUI's focus-in
/// events, which only fire while the window is the key window, and the
/// scenario's window never is, so it stays unset for the whole run.
fn keyboard_holder(shell: &Entity<Shell>, window: &mut Window, cx: &mut App) -> &'static str {
    let Some(focused) = window.focused(cx) else {
        return "nowhere";
    };
    let front = shell.update(cx, |shell, cx| {
        let path = shell.root(cx)?.join(shell.active_document(cx)?);
        let editor = shell.open_editor(&path, cx)?;
        Some(editor.read(cx).editor().focus_handle(cx))
    });
    let shell = shell.read(cx);
    if focused == shell.focus_handle {
        "the shell"
    } else if front.is_some_and(|front| front == focused) {
        "the active editor"
    } else if shell.focus_handle.contains_focused(window, cx) {
        "inside the shell"
    } else {
        "outside the shell"
    }
}
