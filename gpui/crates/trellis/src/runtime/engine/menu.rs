// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/workspace.ts: menus; packages/core/src/runtime/menu.ts: tidyMenu), with
// Lattice's patch (translated labels).

//! The panel menu's built-in items, as data: the host draws the menu and
//! runs an item's [`MenuAction`] through [`Engine::run_menu_action`].

use crate::model::{DockTarget, Edge, find_stage, panels_of};

use super::{Engine, Region};
use crate::runtime::keymap::{Command, format_combo};
use crate::runtime::labels::{Label, label};

#[derive(Clone, Debug, PartialEq)]
pub enum MenuAction {
    Maximize(String),
    ToggleDock(String),
    Dock(String),
    Float(String),
    /// Move `view` into panel `into`.
    MoveInto { view: String, into: String },
    SplitRight { view: String, panel: String },
    SplitBelow { view: String, panel: String },
    Hide(String),
    Close(String),
    CloseOthers(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct MenuItem {
    /// Identifies the item: `maximize`, `float`, `dock`, `move`,
    /// `move:<panel>`, `split-right`, `split-below`, `hide`, `close`,
    /// `close-others`.
    pub id: String,
    pub label: String,
    /// A hint shown right-aligned, e.g. "⌘⇧↩".
    pub shortcut: Option<String>,
    pub action: Option<MenuAction>,
    pub items: Vec<MenuEntry>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum MenuEntry {
    Item(MenuItem),
    Separator,
}

impl MenuItem {
    fn new(id: impl Into<String>, label: impl Into<String>, action: MenuAction) -> MenuItem {
        MenuItem {
            id: id.into(),
            label: label.into(),
            shortcut: None,
            action: Some(action),
            items: Vec::new(),
        }
    }

    fn shortcut(mut self, shortcut: Option<String>) -> MenuItem {
        self.shortcut = shortcut;
        self
    }
}

/// Leading, trailing and repeated separators removed.
pub fn tidy_menu(entries: Vec<MenuEntry>) -> Vec<MenuEntry> {
    let mut out: Vec<MenuEntry> = Vec::new();
    for entry in entries {
        if entry == MenuEntry::Separator
            && (out.is_empty() || out.last() == Some(&MenuEntry::Separator))
        {
            continue;
        }
        out.push(entry);
    }
    while out.last() == Some(&MenuEntry::Separator) {
        out.pop();
    }
    out
}

impl Engine {
    fn hint(&self, command: Command) -> Option<String> {
        self.options
            .keymap
            .get(&command)
            .cloned()
            .flatten()
            .map(|combo| format_combo(&combo, self.options.mac))
    }

    /// The built-in items for a panel, each with a stable id.
    pub fn built_in_menu(&self, panel_id: &str) -> Vec<MenuEntry> {
        let Some(panel) = self.find_panel(panel_id) else {
            return Vec::new();
        };
        let region = self.region_of(panel_id);
        let mut items = Vec::new();
        if self.navigation_on() && region != Region::Floating {
            let framed = self.nav.framed.as_deref() == Some(panel_id);
            items.push(MenuEntry::Item(
                MenuItem::new(
                    "maximize",
                    label(if framed {
                        Label::RestoreSize
                    } else {
                        Label::Maximize
                    }),
                    MenuAction::Maximize(panel_id.to_string()),
                )
                .shortcut(self.hint(Command::FrameToggle)),
            ));
        }
        let layer = self.floating_layer();
        if region == Region::Floating && layer == Some(crate::model::FloatingLayer::Stage) {
            items.push(MenuEntry::Item(MenuItem::new(
                "dock",
                label(Label::DockBesideStage),
                MenuAction::ToggleDock(panel_id.to_string()),
            )));
        } else if region == Region::Floating {
            items.push(MenuEntry::Item(MenuItem::new(
                "dock",
                label(Label::Dock),
                MenuAction::Dock(panel_id.to_string()),
            )));
        } else if layer.is_some() && self.allowed(&panel.views, Region::Floating) {
            items.push(MenuEntry::Item(MenuItem::new(
                "float",
                label(Label::Float),
                MenuAction::Float(panel_id.to_string()),
            )));
        }
        // Keyboard-accessible alternative to dragging a tab.
        let view_id = panel.selected.clone();
        let mut targets: Vec<_> = panels_of(self.doc.root.as_ref()).into_iter().cloned().collect();
        targets.extend(self.doc.floating.iter().map(|f| f.panel.clone()));
        let mut moves: Vec<MenuEntry> = targets
            .into_iter()
            .filter(|p| {
                p.id != panel_id
                    && self.allowed(std::slice::from_ref(&view_id), self.region_of(&p.id))
            })
            .map(|p| {
                let title = self.title_of(&p.selected);
                let label = if p.views.len() > 1 {
                    format!("{title} +{}", p.views.len() - 1)
                } else {
                    title
                };
                MenuEntry::Item(MenuItem::new(
                    format!("move:{}", p.id),
                    label,
                    MenuAction::MoveInto {
                        view: view_id.clone(),
                        into: p.id.clone(),
                    },
                ))
            })
            .collect();
        if panel.views.len() > 1 && region != Region::Floating {
            moves.push(MenuEntry::Item(MenuItem::new(
                "split-right",
                label(Label::NewSplitRight),
                MenuAction::SplitRight {
                    view: view_id.clone(),
                    panel: panel_id.to_string(),
                },
            )));
            moves.push(MenuEntry::Item(MenuItem::new(
                "split-below",
                label(Label::NewSplitBelow),
                MenuAction::SplitBelow {
                    view: view_id.clone(),
                    panel: panel_id.to_string(),
                },
            )));
        }
        if !moves.is_empty() {
            items.push(MenuEntry::Item(MenuItem {
                id: "move".into(),
                label: label(Label::MoveTo(self.title_of(&view_id))),
                shortcut: None,
                action: None,
                items: moves,
            }));
        }
        items.push(MenuEntry::Item(MenuItem::new(
            "hide",
            label(Label::Hide),
            MenuAction::Hide(panel_id.to_string()),
        )));
        let any_closable = panel.views.iter().any(|v| self.closable(v));
        if any_closable {
            items.push(MenuEntry::Separator);
            if self.closable(&panel.selected) {
                items.push(MenuEntry::Item(
                    MenuItem::new(
                        "close",
                        label(Label::CloseView(self.title_of(&panel.selected))),
                        MenuAction::Close(panel.selected.clone()),
                    )
                    .shortcut(self.hint(Command::ViewClose)),
                ));
            }
            if panel.views.len() > 1 {
                items.push(MenuEntry::Item(MenuItem::new(
                    "close-others",
                    label(Label::CloseOtherTabs),
                    MenuAction::CloseOthers(panel_id.to_string()),
                )));
            }
        }
        items
    }

    /// The panel's full menu: the view type's items (`own`), then the
    /// built-ins.
    pub fn panel_menu(&self, panel_id: &str, own: Vec<MenuEntry>) -> Vec<MenuEntry> {
        let built_in = self.built_in_menu(panel_id);
        let all = if own.is_empty() {
            built_in
        } else {
            let mut all = own;
            all.push(MenuEntry::Separator);
            all.extend(built_in);
            all
        };
        tidy_menu(all)
    }

    /// Run a built-in item. Close and Close other tabs return the views the
    /// host should close (through their close guards).
    pub fn run_menu_action(&mut self, action: &MenuAction) -> Vec<String> {
        match action {
            MenuAction::Maximize(panel) => {
                self.toggle_frame(panel);
            }
            MenuAction::ToggleDock(panel) => self.toggle_dock(panel),
            MenuAction::Dock(panel) => {
                let target = match find_stage(self.doc.root.as_ref()) {
                    Some(_)
                        if self.find_panel(panel).is_some_and(|p| {
                            self.allowed(&p.views, Region::Stage)
                        }) =>
                    {
                        None
                    }
                    _ => Some(DockTarget::Beside {
                        beside: self
                            .doc
                            .root
                            .as_ref()
                            .map(|r| r.id().to_string())
                            .unwrap_or_default(),
                        edge: Edge::Right,
                        share: Some(0.3),
                    }),
                };
                self.dock(panel, target);
            }
            MenuAction::Float(panel) => {
                if self.floating_layer() == Some(crate::model::FloatingLayer::Stage) {
                    self.toggle_dock(panel);
                } else {
                    self.float(panel, None);
                }
            }
            MenuAction::MoveInto { view, into } => {
                self.dock(
                    view,
                    Some(DockTarget::Into {
                        into: into.clone(),
                        index: None,
                    }),
                );
                self.focus_view(view);
            }
            MenuAction::SplitRight { view, panel } | MenuAction::SplitBelow { view, panel } => {
                let edge = if matches!(action, MenuAction::SplitRight { .. }) {
                    Edge::Right
                } else {
                    Edge::Bottom
                };
                self.dock(
                    view,
                    Some(DockTarget::Beside {
                        beside: panel.clone(),
                        edge,
                        share: None,
                    }),
                );
            }
            MenuAction::Hide(panel) => self.hide(panel, None),
            MenuAction::Close(view) => return vec![view.clone()],
            MenuAction::CloseOthers(panel) => {
                if let Some(panel) = self.find_panel(panel) {
                    return panel
                        .views
                        .iter()
                        .filter(|v| **v != panel.selected)
                        .cloned()
                        .collect();
                }
            }
        }
        Vec::new()
    }
}
