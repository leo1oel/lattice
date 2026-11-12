//! The window's arrangement in action: reading it off the dock, installing
//! one, and showing, hiding and closing panels.
//!
//! Every rearrangement goes through [`Shell::install`]: it builds GPUI Kit's
//! layout from an [`Arrangement`] with the window's own panels, so a panel
//! keeps its state wherever it moves, and a region left empty goes away as
//! Trellis lets it. The named workspaces and presets build on it
//! (`workspace_flow`), as do the window's commands (`actions`).

use std::{collections::HashMap, sync::Arc};

use gpui::{
    AnyElement, App, Context, Entity, IntoElement, ParentElement as _, Styled as _, Window, div, px,
};
use gpui_kit::component::dock::{
    BasePanelView, DockPlacement, InsertTarget, PaneRef, PanelId, panel_handle,
};
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    dock::{PanelCloser, PanelMenuItems, PanelMenuRequest},
};

use super::{
    Shell,
    layout::{self, Arrangement, Node, View},
    windows,
};
use crate::editor_panel::EditorPanel;

/// The app's hooks into the dock skin: closing a panel arranges the window
/// without it, and every panel's ⋯ menu offers Float and Hide.
pub(super) fn install_dock_hooks(cx: &mut App) {
    if cx.try_global::<PanelCloser>().is_some() {
        return;
    }
    PanelCloser::set(cx, |panel, window, cx| {
        let Some(shell) = windows::shell_for(window, cx) else {
            return false;
        };
        shell.update(cx, |shell, cx| shell.close_panel(panel, window, cx))
    });
    PanelMenuItems::set(cx, |mut menu, request: &PanelMenuRequest, window, cx| {
        let Some(shell) = windows::shell_for(window, cx) else {
            return menu;
        };
        let panel = request.panel;
        let floated = shell.read(cx).floating.contains(panel);
        let float = shell.downgrade();
        menu = menu.item(
            gpui_kit::component::menu::PopupMenuItem::new(if floated { "Dock" } else { "Float" })
                .icon(
                    if floated {
                        lattice_ui::Icon::MINIMIZE
                    } else {
                        lattice_ui::Icon::PICTURE_IN_PICTURE
                    }
                    .kit(),
                )
                .on_click(move |_, window, cx| {
                    float
                        .update(cx, |shell, cx| shell.toggle_float(panel, window, cx))
                        .ok();
                }),
        );
        let hide = shell.downgrade();
        menu.item(
            gpui_kit::component::menu::PopupMenuItem::new("Hide")
                .icon(lattice_ui::Icon::EYE_OFF.kit())
                .on_click(move |_, window, cx| {
                    hide.update(cx, |shell, cx| {
                        if let Some(view) = shell.view_of(panel, cx) {
                            shell.hide_view(&view, window, cx);
                        }
                    })
                    .ok();
                }),
        )
    });
}

impl Shell {
    /// The view a live panel stands for.
    pub(crate) fn view_of(&self, panel: PanelId, cx: &App) -> Option<View> {
        let is = |id: gpui::EntityId| PanelId::from(id) == panel;
        if is(self.file_tree.entity_id()) {
            return Some(View::Project);
        }
        if is(self.papers.entity_id()) {
            return Some(View::Papers);
        }
        if is(self.agent.entity_id()) {
            return Some(View::Agent);
        }
        if is(self.pdf.entity_id()) {
            return Some(View::Pdf);
        }
        if is(self.build_panel.entity_id()) {
            return Some(View::Build);
        }
        let root = self.root.as_deref()?;
        self.editors
            .iter()
            .filter_map(gpui::WeakEntity::upgrade)
            .find(|editor| is(editor.entity_id()))
            .map(|editor| View::File(layout::document_key(root, editor.read(cx).path())))
    }

    /// The panel a singleton view stands for (Project, Papers, the Agent,
    /// the PDF, the build log).
    pub(crate) fn singleton_panel(&self, view: &View) -> Option<PanelId> {
        let id = match view {
            View::Project => self.file_tree.entity_id(),
            View::Papers => self.papers.entity_id(),
            View::Agent => self.agent.entity_id(),
            View::Pdf => self.pdf.entity_id(),
            View::Build => self.build_panel.entity_id(),
            View::File(_) | View::Documents => return None,
        };
        Some(PanelId::from(id))
    }

    /// The live panel for a view, an editor opened for a document.
    fn panel_of(
        &mut self,
        view: &View,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Arc<dyn BasePanelView>> {
        Some(match view {
            View::Project => panel_handle(self.file_tree.clone()),
            View::Papers => panel_handle(self.papers.clone()),
            View::Agent => panel_handle(self.agent.clone()),
            View::Pdf => panel_handle(self.pdf.clone()),
            View::Build => panel_handle(self.build_panel.clone()),
            View::File(key) => {
                let path = self.root.as_ref()?.join(key);
                if !path.is_file() {
                    return None;
                }
                panel_handle(self.editor_for(&path, window, cx)?)
            }
            View::Documents => return None,
        })
    }

    /// Whether `panel` is in the dock area (or floating).
    pub(crate) fn panel_shown(&self, panel: PanelId, cx: &App) -> bool {
        self.dock_area.read(cx).panel(panel).is_some() || self.floating.contains(panel)
    }

    /// The arrangement on screen, the floating panels with it.
    pub(crate) fn current_arrangement(&self, cx: &App) -> Arrangement {
        let area = self.dock_area.read(cx);
        let mut arrangement = layout::read(area, &|panel| self.view_of(panel, cx));
        arrangement.floating = self.floating.records();
        arrangement
    }

    /// Lay the window out as `arrangement`, with the window's own panels.
    pub(crate) fn install(
        &mut self,
        arrangement: &Arrangement,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Every panel first, editors opened as needed; then Kit's layouts
        // from them. The handles are held until the dock holds them.
        let mut panels: HashMap<View, Arc<dyn BasePanelView>> = HashMap::new();
        for view in arrangement.views() {
            if let Some(panel) = self.panel_of(view, window, cx) {
                panels.insert(view.clone(), panel);
            }
        }
        let mut lookup = |view: &View| panels.get(view).cloned();
        let center = layout::describe(&arrangement.center, &mut lookup, cx);
        let docks: Vec<_> = arrangement
            .docks()
            .into_iter()
            .map(|(placement, dock)| {
                let described = dock.and_then(|dock| {
                    layout::describe(&dock.node, &mut lookup, cx)
                        .map(|layout| (layout, dock.size, dock.open))
                });
                (placement, described)
            })
            .collect();
        self.layout.installing = true;
        self.dock_area.update(cx, |area, cx| {
            if area.is_zoomed() {
                area.set_zoomed_out(window, cx);
            }
            for placement in [
                DockPlacement::Left,
                DockPlacement::Right,
                DockPlacement::Bottom,
            ] {
                if area.has_dock(placement) {
                    area.remove_dock(placement, window, cx);
                }
            }
            area.set_center(
                center.unwrap_or_else(gpui_kit::component::dock::DockLayout::v_split),
                window,
                cx,
            );
            for (placement, dock) in docks {
                let Some((layout, size, open)) = dock else {
                    continue;
                };
                area.set_dock(placement, layout, window, cx);
                area.set_dock_size(placement, px(size), window, cx);
                area.set_dock_collapsible(placement, true, window, cx);
                if area.is_dock_open(placement) != open {
                    area.toggle_dock(placement, window, cx);
                }
            }
        });
        let area = self.floating_area(window);
        self.floating.set(&arrangement.floating, &panels, area, cx);
        drop(panels);
        self.layout.installing = false;
        self.refresh_dirty(cx);
        self.schedule_save(window, cx);
        cx.notify();
    }

    /// Put a document that is not on screen beside the documents: in the
    /// group showing the document last focused, else the first group that
    /// holds a document, else the center.
    pub(crate) fn place_document(
        &mut self,
        editor: &Entity<EditorPanel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = PanelId::from(editor.entity_id());
        let target = self.document_group(cx);
        let panel = panel_handle(editor.clone());
        self.dock_area.update(cx, |area, cx| {
            area.add_panel_view(panel, DockPlacement::Center, None, window, cx);
            if let Some(node) = target
                && area
                    .layout(DockPlacement::Center)
                    .and_then(|t| t.find_panel_node(id))
                    != Some(node)
            {
                area.move_panel(
                    id,
                    InsertTarget::Tabs {
                        node,
                        ix: None,
                        activate: true,
                    },
                    window,
                    cx,
                );
            }
        });
    }

    /// The group documents open into.
    pub(super) fn document_group(&self, cx: &App) -> Option<gpui_kit::component::dock::NodeId> {
        let area = self.dock_area.read(cx);
        let mut focused = None;
        let mut first = None;
        for placement in [
            DockPlacement::Center,
            DockPlacement::Left,
            DockPlacement::Right,
            DockPlacement::Bottom,
        ] {
            let Some(tree) = area.layout(placement) else {
                continue;
            };
            tree.root().walk(&mut |node| {
                if let PaneRef::Tabs { panels, .. } = node.kind() {
                    for panel in panels {
                        let Some(view) = area.panel(*panel) else {
                            continue;
                        };
                        if view.view().downcast::<EditorPanel>().is_ok() {
                            first.get_or_insert(node.id());
                            if self.focused_document == Some(*panel) {
                                focused = Some(node.id());
                            }
                        }
                    }
                }
            });
        }
        focused.or(first)
    }

    pub(crate) fn center_empty(&self, cx: &App) -> bool {
        self.dock_area
            .read(cx)
            .layout(DockPlacement::Center)
            .is_none_or(|tree| tree.panels().next().is_none())
    }

    /// Bring `view` forward: select it where it is, or put it back in its
    /// place in the default layout (Project and the Agent over Papers on the
    /// left, the PDF on the right, the build log under the editors).
    pub(crate) fn show_view(&mut self, view: View, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(panel) = self.panel_of(&view, window, cx) {
            let id = panel.panel_id(cx);
            if self.floating.contains(id) {
                return;
            }
            if self.dock_area.read(cx).panel(id).is_some() {
                self.dock_area.update(cx, |area, cx| {
                    for placement in [
                        DockPlacement::Left,
                        DockPlacement::Right,
                        DockPlacement::Bottom,
                    ] {
                        if area
                            .layout(placement)
                            .is_some_and(|t| t.find_panel_node(id).is_some())
                            && !area.is_dock_open(placement)
                        {
                            area.toggle_dock(placement, window, cx);
                        }
                    }
                    area.select_panel(id, window, cx);
                });
                return;
            }
        }
        let mut arrangement = self.current_arrangement(cx);
        place_view(
            &mut arrangement,
            view,
            &Arrangement::default_for(self.room(window)),
        );
        self.install(&arrangement, window, cx);
    }

    /// Take `view` off screen; its region closes when nothing is left in it.
    pub(crate) fn hide_view(&mut self, view: &View, window: &mut Window, cx: &mut Context<Self>) {
        if let View::File(key) = view
            && let Some(root) = &self.root
        {
            self.closed_tabs.push(root.join(key));
        }
        let arrangement = self.current_arrangement(cx).without(view);
        self.install(&arrangement, window, cx);
    }

    /// The Panels menu's toggle: hide a panel on screen, show one that is not.
    pub(crate) fn toggle_view(&mut self, view: View, window: &mut Window, cx: &mut Context<Self>) {
        if self.view_on_screen(&view, cx) {
            self.hide_view(&view, window, cx);
        } else {
            self.show_view(view, window, cx);
        }
    }

    /// Whether `view` is on screen: in the area, in an open dock (or floating).
    pub(crate) fn view_on_screen(&self, view: &View, cx: &App) -> bool {
        let panel = match view {
            View::Project => self.file_tree.entity_id(),
            View::Papers => self.papers.entity_id(),
            View::Agent => self.agent.entity_id(),
            View::Pdf => self.pdf.entity_id(),
            View::Build => self.build_panel.entity_id(),
            _ => return self.current_arrangement(cx).contains(view),
        };
        let id = PanelId::from(panel);
        if self.floating.contains(id) {
            return true;
        }
        let area = self.dock_area.read(cx);
        if area
            .layout(DockPlacement::Center)
            .is_some_and(|tree| tree.find_panel_node(id).is_some())
        {
            return true;
        }
        [
            DockPlacement::Left,
            DockPlacement::Right,
            DockPlacement::Bottom,
        ]
        .into_iter()
        .any(|placement| {
            area.is_dock_open(placement)
                && area
                    .layout(placement)
                    .is_some_and(|tree| tree.find_panel_node(id).is_some())
        })
    }

    /// A tab's X, Close in its menu, or ⌘W on it: the window arranged
    /// without the panel. Always handled here, so a region's last panel
    /// closes too, as Trellis closes it.
    pub(crate) fn close_panel(
        &mut self,
        panel: PanelId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(view) = self.view_of(panel, cx) else {
            return false;
        };
        self.hide_view(&view, window, cx);
        true
    }

    /// The dock changed (a drag, a resize, a tab chosen): note whether the
    /// arrangement still matches the workspace, close regions left empty, and
    /// save the project's layout soon.
    pub(super) fn layout_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.layout.installing {
            return;
        }
        // A region whose last panel was dragged out goes away, as Trellis
        // lets a column go.
        let empty: Vec<DockPlacement> = {
            let area = self.dock_area.read(cx);
            [
                DockPlacement::Left,
                DockPlacement::Right,
                DockPlacement::Bottom,
            ]
            .into_iter()
            .filter(|placement| {
                area.layout(*placement)
                    .is_some_and(|tree| tree.panels().next().is_none())
            })
            .collect()
        };
        if !empty.is_empty() {
            self.layout.installing = true;
            self.dock_area.update(cx, |area, cx| {
                for placement in empty {
                    area.remove_dock(placement, window, cx);
                }
            });
            self.layout.installing = false;
        }
        self.refresh_dirty(cx);
        self.follow_active_document(cx);
        self.schedule_save(window, cx);
        cx.notify();
    }

    /// The Project tree marks the document in front, whichever tab brought
    /// it there.
    pub(super) fn follow_active_document(&mut self, cx: &mut Context<Self>) {
        let (Some(root), Some(active)) = (self.root.clone(), self.active_document(cx)) else {
            return;
        };
        let path = root.join(active);
        self.file_tree
            .update(cx, |tree, cx| tree.set_current(Some(path), cx));
    }

    /// The document in front: the one selected in the group of the editor
    /// last focused, else that editor while it is on screen (floating, or
    /// behind another tab), else the first group's selected one.
    pub(crate) fn active_document(&self, cx: &App) -> Option<String> {
        let root = self.root.as_deref()?;
        let area = self.dock_area.read(cx);
        let mut focused = None;
        let mut first = None;
        for placement in [
            DockPlacement::Center,
            DockPlacement::Left,
            DockPlacement::Right,
            DockPlacement::Bottom,
        ] {
            let Some(tree) = area.layout(placement) else {
                continue;
            };
            tree.root().walk(&mut |node| {
                if let PaneRef::Tabs { panels, active_ix } = node.kind()
                    && let Some(panel) = panels.get(active_ix).and_then(|id| area.panel(*id))
                    && let Ok(editor) = panel.view().downcast::<EditorPanel>()
                {
                    let key = || layout::document_key(root, editor.read(cx).path());
                    if focused.is_none()
                        && self
                            .focused_document
                            .is_some_and(|focused| panels.contains(&focused))
                    {
                        focused = Some(key());
                    }
                    if placement != DockPlacement::Bottom {
                        first.get_or_insert_with(key);
                    }
                }
            });
        }
        focused.or_else(|| self.last_focused_document(cx)).or(first)
    }

    /// The editor last focused, while it is on screen: in a dock or floating.
    fn last_focused_document(&self, cx: &App) -> Option<String> {
        let panel = self
            .focused_document
            .filter(|panel| self.panel_shown(*panel, cx))?;
        match self.view_of(panel, cx)? {
            View::File(key) => Some(key),
            _ => None,
        }
    }
}

/// `view` put back in its place in the default layout `home`: Project and
/// the Agent over Papers on the left, the PDF on the right, the build log
/// under the editors in a bottom dock of its own, a document beside the
/// documents.
fn place_view(arrangement: &mut Arrangement, view: View, home: &Arrangement) {
    match &view {
        View::Project | View::Agent => {
            let other = if view == View::Project {
                View::Agent
            } else {
                View::Project
            };
            let docked = std::iter::once(&arrangement.center)
                .chain(
                    arrangement
                        .docks()
                        .into_iter()
                        .flat_map(|(_, dock)| dock.map(|d| &d.node)),
                )
                .any(|node| node.views().contains(&&other));
            if docked {
                arrangement.add_view(view, |v| *v == other);
            } else {
                insert_in_dock(&mut arrangement.left, view, home.left.as_ref(), true);
            }
        }
        View::Papers => insert_in_dock(&mut arrangement.left, view, home.left.as_ref(), false),
        View::Pdf => insert_in_dock(&mut arrangement.right, view, home.right.as_ref(), true),
        View::Build => match &mut arrangement.bottom {
            Some(dock) => {
                match &mut dock.node {
                    Node::Tabs { views, active } => {
                        views.push(view);
                        *active = views.len() - 1;
                    }
                    node @ Node::Split { .. } => {
                        let existing = std::mem::take(node);
                        *node = Node::Split {
                            axis: layout::SplitAxis::Row,
                            children: vec![existing, Node::tabs([view])],
                            sizes: vec![None, None],
                        };
                    }
                }
                dock.open = true;
            }
            None => {
                arrangement.bottom = Some(layout::Dock {
                    node: Node::tabs([view]),
                    size: super::BUILD_DOCK,
                    open: true,
                })
            }
        },
        View::File(_) | View::Documents => arrangement.add_view(view, View::is_document),
    }
}

/// `view` into the dock `slot`, made from `home` (the default layout's dock)
/// when there is none: Project and the Agent into its first group (`first`),
/// Papers into a group of its own under it.
fn insert_in_dock(
    slot: &mut Option<layout::Dock>,
    view: View,
    home: Option<&layout::Dock>,
    first: bool,
) {
    match slot {
        Some(dock) => {
            dock.open = true;
            match (&mut dock.node, first) {
                (Node::Split { children, .. }, true) => match children.first_mut() {
                    Some(Node::Tabs { views, active }) => {
                        views.push(view);
                        *active = views.len() - 1;
                    }
                    _ => children.insert(0, Node::tabs([view])),
                },
                (
                    Node::Split {
                        children, sizes, ..
                    },
                    false,
                ) => {
                    children.push(Node::tabs([view]));
                    sizes.push(None);
                }
                (Node::Tabs { views, active }, true) => {
                    views.push(view);
                    *active = views.len() - 1;
                }
                (node @ Node::Tabs { .. }, false) => {
                    let existing = std::mem::take(node);
                    *node = Node::Split {
                        axis: layout::SplitAxis::Column,
                        children: vec![existing, Node::tabs([view])],
                        sizes: vec![None, None],
                    };
                }
            }
        }
        None => {
            *slot = Some(layout::Dock {
                node: Node::tabs([view]),
                size: home.map(|home| home.size).unwrap_or(300.),
                open: true,
            });
        }
    }
}

/// The center with no document open: where documents go, said plainly.
pub(super) fn empty_center(shell: &Shell, cx: &mut Context<Shell>) -> AnyElement {
    let palette = cx.palette().clone();
    let area = shell.dock_area.read(cx);
    let left = area
        .dock_size(DockPlacement::Left)
        .filter(|_| area.is_dock_open(DockPlacement::Left))
        .unwrap_or_default();
    let right = area
        .dock_size(DockPlacement::Right)
        .filter(|_| area.is_dock_open(DockPlacement::Right))
        .unwrap_or_default();
    let message = if shell.root.is_some() {
        "Open a file from Project to start writing"
    } else {
        "Open a LaTeX project folder to start"
    };
    div()
        .absolute()
        .top(px(super::WORKSPACE_TOP) + px(3.))
        .bottom(px(super::WORKSPACE_SIDE) + px(3.))
        .left(px(super::WORKSPACE_SIDE) + left + px(3.))
        .right(px(super::WORKSPACE_SIDE) + right + px(3.))
        .rounded(lattice_ui::dock::PANEL_RADIUS)
        .bg(palette.editor)
        .shadow(lattice_ui::elevation::panel_ring(&palette))
        .flex()
        .items_center()
        .justify_center()
        .text_role(TextRole::Body, cx)
        .text_color(palette.text_secondary)
        .child(message)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::layout::Room;

    fn home() -> Arrangement {
        Arrangement::default_for(Room {
            width: 1440.,
            height: 900.,
        })
    }

    #[test]
    fn a_floated_pdf_comes_back_as_the_default_right_dock() {
        let home = home();
        let mut floated = home.without(&View::Pdf);
        assert!(floated.right.is_none());
        place_view(&mut floated, View::Pdf, &home);
        assert_eq!(floated, home);
    }

    #[test]
    fn a_floated_papers_panel_comes_back_under_project_and_the_agent() {
        let home = home();
        let mut floated = home.without(&View::Papers);
        place_view(&mut floated, View::Papers, &home);
        let groups = match floated.left.map(|dock| dock.node) {
            Some(Node::Split {
                axis: layout::SplitAxis::Column,
                children,
                ..
            }) => children
                .into_iter()
                .map(|child| match child {
                    Node::Tabs { views, .. } => views,
                    Node::Split { .. } => Vec::new(),
                })
                .collect(),
            _ => Vec::new(),
        };
        assert_eq!(
            groups,
            vec![vec![View::Project, View::Agent], vec![View::Papers]]
        );
    }

    #[test]
    fn the_agent_docks_on_the_left_while_project_floats() {
        let home = home();
        let mut arrangement = home.without(&View::Project).without(&View::Agent);
        arrangement.floating.push(layout::FloatingView {
            view: View::Project,
            x: 600.,
            y: 72.,
            width: 420.,
            height: 480.,
        });
        place_view(&mut arrangement, View::Agent, &home);
        assert!(!arrangement.center.views().contains(&&View::Agent));
        assert!(
            arrangement
                .left
                .is_some_and(|dock| dock.node.views().contains(&&View::Agent))
        );
    }
}
