//! The titlebar's layout switch (`src/trellis/trellis-workspace-switch.tsx`):
//! the named workspaces in a hairline track, then "+". The project's
//! workspace is a raised plate (none while a preset lies over it), with a
//! dot while the project's layout differs from it. A workspace is renamed
//! in place (a double click, or Rename in its context menu, which also
//! saves to it, reverts to it, duplicates, moves and deletes it). Short of
//! room the workspaces fold into one menu button.

use gpui::{
    AnyElement, AnyView, App, AppContext as _, Context, InteractiveElement as _, IntoElement,
    KeyDownEvent, ParentElement as _, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use lattice_i18n::{space_mixed_script, t};
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{
        ContextMenu, LatticeTooltip, Menu, MenuAction, MenuPopover, context_menu_trigger,
        focus_ring,
    },
    elevation::ring,
    icons::{ICON, ICON_SMALL},
    interaction::{mix, tab_stop, track_pointer, use_interaction},
    parity,
    typography::shaped_width,
};

use crate::shell::{
    Shell,
    commands::NewWorkspace,
    workspaces::{RenameError, Workspaces, shortcut_label, shown_name},
};

/// The workspace a folded switch names is cut at about 9em.
const FOLDED_NAME_MAX: f32 = 112.;
/// The track's padding, a tab's side padding and the gap before its dot,
/// the dot, "+", and the rename field's side padding and least width.
const TRACK_PAD: f32 = 2.;
const TAB_PAD: f32 = 10.;
const TAB_GAP: f32 = 6.;
const DOT: f32 = 5.;
const ADD_WIDTH: f32 = 28.;
const RENAME_PAD: f32 = 6.;
const RENAME_MIN: f32 = 6. * 7. + 20.;
/// A workspace chip's corner: the segmented track's thumb
/// (`shape::SEGMENTED`, a control's 6px less the 2px inset), as the chrome
/// draws it (`shape::CHROME`).
fn segment_chip_radius() -> gpui::Pixels {
    let (_, chip) = lattice_ui::shape::SEGMENTED.painted(lattice_ui::shape::CHROME);
    chip
}

/// A workspace tab as the unfolded track draws it.
#[derive(Clone, Copy, Debug)]
pub(super) enum SwitchTab {
    /// A label this wide, with the dot when the project's layout differs
    /// from the workspace.
    Named { label: f32, dot: bool },
    /// The rename field, which keeps its least width whatever is typed
    /// (the text scrolls inside it).
    Renaming,
}

pub(super) fn tab_width(tab: SwitchTab) -> f32 {
    match tab {
        SwitchTab::Named { label, dot } => {
            TAB_PAD * 2. + label + if dot { TAB_GAP + DOT } else { 0. }
        }
        SwitchTab::Renaming => RENAME_MIN,
    }
}

/// The unfolded track's width around tabs this wide, with "+".
pub(super) fn track_width(tabs: impl IntoIterator<Item = f32>) -> f32 {
    TRACK_PAD * 2. + tabs.into_iter().sum::<f32>() + ADD_WIDTH
}

/// How wide the switch draws unfolded, from its labels' shaped widths: the
/// titlebar decides whether it folds without drawing it unfolded first.
pub(super) fn unfolded_switch_width(shell: &Shell, window: &Window, cx: &App) -> f32 {
    let current = shell.layout.workspace.as_deref();
    let renaming = shell.layout.renaming.as_deref();
    let shaped = |text: &str| f32::from(shaped_width(text, TextRole::Caption, None, window, cx));
    track_width(Workspaces::global(cx).list().iter().map(|entry| {
        tab_width(
            if renaming == Some(entry.id.as_str()) && shell.rename_input().is_some() {
                SwitchTab::Renaming
            } else {
                SwitchTab::Named {
                    label: shaped(&shown_name(&entry.name)),
                    dot: shell.layout.dirty && current == Some(entry.id.as_str()),
                }
            },
        )
    }))
}

/// The layout switch: a hairline track holding the named workspaces and
/// "+"; the project's workspace a raised plate (none while a preset lies
/// over it), with a dot while the project's layout differs from it. Folded,
/// one menu button names the workspace.
pub(super) fn workspace_switcher(
    shell: &Shell,
    folded: bool,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> AnyElement {
    let palette = cx.palette().clone();
    let workspaces: Vec<(String, String)> = Workspaces::global(cx)
        .list()
        .iter()
        .map(|entry| (entry.id.clone(), shown_name(&entry.name)))
        .collect();
    let current = shell.layout.workspace.clone();
    let preset = shell.layout.preset.as_ref().map(|active| active.preset);
    let dirty = shell.layout.dirty;
    let weak = cx.entity().downgrade();
    let track = div()
        .id("workspace")
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .h(px(28.))
        .p(px(TRACK_PAD))
        .rounded(px(11.))
        .shadow(vec![gpui::BoxShadow {
            inset: true,
            ..ring(palette.line)
        }])
        .children(parity::probe("titlebar/workspace"));

    let renaming = shell.layout.renaming.clone();
    if folded {
        if renaming.is_some()
            && let Some(input) = shell.rename_input()
        {
            return track
                .child(rename_field("workspace-rename", &input, &palette, cx))
                .into_any_element();
        }
        let name = current
            .as_ref()
            .and_then(|id| workspaces.iter().find(|(entry, _)| entry == id))
            .map(|(_, name)| name.clone())
            .unwrap_or_default();
        let menu_weak = weak.clone();
        let entries = workspaces.clone();
        let menu_current = current.clone();
        let button = FoldedSwitch(div().id("workspace-menu"))
            .flex()
            .items_center()
            .gap(px(6.))
            .h(px(24.))
            .px(px(8.))
            .rounded(segment_chip_radius())
            .when(preset.is_none(), |this| {
                this.bg(palette.panel).shadow(raised_plate(&palette))
            })
            .cursor_pointer()
            .child(Icon::LAYOUT_DASHBOARD.element(ICON, palette.text_secondary))
            .child(
                div()
                    .max_w(px(FOLDED_NAME_MAX))
                    .truncate()
                    .text_role(TextRole::Caption, cx)
                    .line_height(px(14.))
                    .text_color(palette.text)
                    .child(name),
            )
            .when(dirty, |this| this.child(dirty_dot(&palette)))
            .child(Icon::CHEVRON_DOWN.element(ICON_SMALL, palette.text_secondary));
        let button = MenuPopover::new("workspace-menu-popover", button, move |mut menu, _, cx| {
            for (ix, (id, name)) in entries.iter().enumerate() {
                let weak = menu_weak.clone();
                let id = id.clone();
                let chosen = menu_current.as_deref() == Some(id.as_str());
                let mut item = MenuAction::new(name.clone(), move |window, cx| {
                    weak.update(cx, |shell, cx| shell.switch_workspace(&id, window, cx))
                        .ok();
                })
                .checked(chosen);
                if let Some(keys) = shortcut_label(ix) {
                    item = item.shortcut(keys);
                }
                menu = menu.item(item);
            }
            menu = menu
                .separator()
                .item(
                    MenuAction::dispatch(t!("New workspace"), Box::new(NewWorkspace))
                        .icon(Icon::PLUS),
                )
                .separator();
            match &menu_current {
                Some(id) => workspace_actions(menu, id, dirty, menu_weak.clone(), cx),
                None => menu,
            }
        });
        return track.child(button).into_any_element();
    }

    // A workspace chip's right-click menu: its id, and whether the project's
    // layout differs from it.
    let chip_menu = ContextMenu::<(String, bool)>::keyed("workspace-chip-menu", window, cx);
    let chip_menu_weak = weak.clone();
    let chip_menu_layer =
        ContextMenu::layer(&chip_menu, window, cx, move |menu, (id, dirty), _, cx| {
            workspace_actions(menu, id, *dirty, chip_menu_weak.clone(), cx)
        });
    let tabs = workspaces.iter().enumerate().map(|(ix, (id, name))| {
        if renaming.as_deref() == Some(id.as_str())
            && let Some(input) = shell.rename_input()
        {
            return rename_field(("workspace-rename", ix), &input, &palette, cx);
        }
        let selected = preset.is_none() && current.as_deref() == Some(id.as_str());
        let underlying = preset.is_some() && current.as_deref() == Some(id.as_str());
        let tab_id: gpui::ElementId = ("workspace-tab", ix).into();
        let (interaction, pointer) = use_interaction(tab_id.clone(), window, cx);
        let ink = if selected || underlying {
            palette.text
        } else {
            mix(palette.text_secondary, palette.text, interaction.hover)
        };
        let tooltip: gpui::SharedString = {
            let label = if underlying {
                t!("Return to {name}", name = name)
            } else {
                name.clone()
            };
            match shortcut_label(ix) {
                Some(keys) => space_mixed_script(&format!("{label} ({keys})")).into(),
                None => space_mixed_script(&label).into(),
            }
        };
        let switch_weak = weak.clone();
        let rename_weak = weak.clone();
        let switch_id = id.clone();
        let rename_id = id.clone();
        let menu_id = id.clone();
        let focus = focus_ring(&palette, palette.titlebar);
        let is_current = current.as_deref() == Some(id.as_str());
        track_pointer(tab_stop(div().id(tab_id)), pointer)
            .focus_visible(move |style| style.shadow(focus))
            .flex()
            .flex_none()
            .items_center()
            .gap(px(TAB_GAP))
            .h(px(24.))
            .px(px(TAB_PAD))
            .rounded(segment_chip_radius())
            .when(selected, |this| {
                this.bg(palette.panel).shadow(raised_plate(&palette))
            })
            .when(!selected, |this| this.cursor_pointer())
            .text_role(TextRole::Caption, cx)
            .line_height(px(14.))
            .text_color(ink)
            .tooltip(move |_, cx| -> AnyView { LatticeTooltip::view(tooltip.clone(), None, cx) })
            .on_click(move |event, window, cx| {
                let id = switch_id.clone();
                if event.click_count() >= 2 {
                    rename_weak
                        .update(cx, |shell, cx| shell.start_rename(&rename_id, window, cx))
                        .ok();
                } else {
                    switch_weak
                        .update(cx, |shell, cx| shell.switch_workspace(&id, window, cx))
                        .ok();
                }
            })
            .children(parity::text_probe("titlebar/workspace", ix, name.clone()))
            .child(name.clone())
            .when(dirty && is_current, |this| this.child(dirty_dot(&palette)))
            .map(|chip| {
                context_menu_trigger(chip, &chip_menu, (menu_id.clone(), dirty && is_current))
            })
            .into_any_element()
    });
    let add_weak = weak.clone();
    let tabs: Vec<AnyElement> = tabs.collect();
    track
        .children(tabs)
        .children(chip_menu_layer)
        .child(
            div()
                .id("workspace-add")
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .w(px(ADD_WIDTH))
                .h(px(24.))
                .rounded(segment_chip_radius())
                .cursor_pointer()
                .text_color(palette.text_secondary)
                .hover(|style| style.text_color(palette.text))
                .tooltip(|_, cx| -> AnyView { LatticeTooltip::view(t!("New workspace"), None, cx) })
                .on_click(move |_, window, cx| {
                    add_weak
                        .update(cx, |shell, cx| shell.new_workspace(window, cx))
                        .ok();
                })
                .child(Icon::PLUS.element(ICON, palette.text_secondary)),
        )
        .into_any_element()
}

/// Save to workspace and Revert (while the project's layout differs from
/// it), then Rename, Duplicate, Move left or right, and Delete.
fn workspace_actions(
    menu: Menu,
    id: &str,
    dirty: bool,
    shell: gpui::WeakEntity<Shell>,
    cx: &App,
) -> Menu {
    let library = Workspaces::global(cx);
    let index = library.index_of(id).unwrap_or(0);
    let count = library.list().len();
    let mut menu = menu;
    let item = |label: &str,
                icon: Icon,
                run: Box<dyn Fn(&mut Shell, &mut Window, &mut Context<Shell>)>| {
        let shell = shell.clone();
        MenuAction::new(label.to_string(), move |window, cx| {
            shell.update(cx, |shell, cx| run(shell, window, cx)).ok();
        })
        .icon(icon)
    };
    if dirty {
        menu = menu
            .item(item(
                t!("Save to workspace"),
                Icon::SAVE,
                Box::new(|shell, window, cx| shell.save_workspace(window, cx)),
            ))
            .item(item(
                t!("Revert to saved"),
                Icon::UNDO,
                Box::new(|shell, window, cx| shell.revert_workspace(window, cx)),
            ))
            .separator();
    }
    let (rename, duplicate, left, right, delete) = (
        id.to_string(),
        id.to_string(),
        id.to_string(),
        id.to_string(),
        id.to_string(),
    );
    menu.item(item(
        t!("Rename"),
        Icon::PENCIL,
        Box::new(move |shell, window, cx| shell.start_rename(&rename, window, cx)),
    ))
    .item(item(
        t!("Duplicate"),
        Icon::COPY,
        Box::new(move |shell, window, cx| {
            if let Some(copy) = Workspaces::update(cx, |library| library.duplicate(&duplicate)) {
                shell.start_rename(&copy, window, cx);
            }
        }),
    ))
    .separator()
    .item(
        item(
            t!("Move left"),
            Icon::ARROW_LEFT,
            Box::new(move |_, _, cx| {
                Workspaces::update(cx, |library| {
                    library.move_to(&left, index.saturating_sub(1))
                });
            }),
        )
        .disabled(index == 0),
    )
    .item(
        item(
            t!("Move right"),
            Icon::ARROW_RIGHT,
            Box::new(move |_, _, cx| {
                Workspaces::update(cx, |library| library.move_to(&right, index + 1));
            }),
        )
        .disabled(index + 1 >= count),
    )
    .separator()
    .item(
        item(
            t!("Delete"),
            Icon::TRASH,
            Box::new(move |shell, window, cx| shell.delete_workspace(&delete, window, cx)),
        )
        .disabled(count < 2),
    )
}

impl Shell {
    pub(crate) fn rename_input(&self) -> Option<gpui::Entity<InputState>> {
        self.rename_input.clone()
    }

    /// Edit workspace `id`'s name in place of its tab: Enter keeps a free
    /// name (one already taken stays in editing), Escape keeps the old one,
    /// and leaving the field keeps a free name or else the old one.
    pub(crate) fn start_rename(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(name) = Workspaces::global(cx)
            .get(id)
            .map(|entry| shown_name(&entry.name))
        else {
            return;
        };
        let input = cx.new(|cx| {
            let mut state = InputState::new(window, cx);
            state.set_value(name, window, cx);
            state
        });
        let target = id.to_string();
        let subscription = cx.subscribe_in(
            &input,
            window,
            move |this, input, event, window, cx| match event {
                InputEvent::PressEnter { .. } => {
                    let name = input.read(cx).value().to_string();
                    let result = Workspaces::update(cx, |library| library.rename(&target, &name));
                    if result != Err(RenameError::Taken) {
                        this.finish_rename(window, cx);
                    }
                }
                InputEvent::Blur => {
                    let name = input.read(cx).value().to_string();
                    let _ = Workspaces::update(cx, |library| library.rename(&target, &name));
                    this.finish_rename(window, cx);
                }
                _ => {}
            },
        );
        input.update(cx, |input, cx| {
            input.focus(window, cx);
            input.select_all(window, cx);
        });
        self.layout.renaming = Some(id.to_string());
        self.rename_input = Some(input);
        self.rename_subscription = Some(subscription);
        cx.notify();
    }

    /// Close the rename field. The keyboard comes back to the window only
    /// from the field itself: a click elsewhere keeps the focus it moved.
    pub(crate) fn finish_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let held = self.rename_input.take().is_some_and(|input| {
            gpui::Focusable::focus_handle(input.read(cx), cx).contains_focused(window, cx)
        });
        self.layout.renaming = None;
        self.rename_subscription = None;
        if held || window.focused(cx).is_none() {
            window.focus(&self.focus_handle, cx);
        }
        cx.notify();
    }

    /// Delete a workspace (never the last); the project in it moves to its
    /// neighbour. A toast offers Undo.
    pub(crate) fn delete_workspace(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let list: Vec<String> = Workspaces::global(cx)
            .list()
            .iter()
            .map(|e| e.id.clone())
            .collect();
        let Some(index) = list.iter().position(|entry| entry == id) else {
            return;
        };
        if list.len() < 2 {
            return;
        }
        let fallback = list.get(index + 1).or_else(|| list.get(index - 1)).cloned();
        let was_current = self.layout.workspace.as_deref() == Some(id);
        let here = window.window_handle().window_id();
        let mut moved = Vec::new();
        if let Some(fallback) = &fallback {
            if was_current {
                self.switch_workspace(fallback, window, cx);
            }
            crate::shell::windows::for_shells(
                cx,
                |other| other != here,
                |shell, window, cx| {
                    if shell.layout.workspace.as_deref() == Some(id) {
                        shell.switch_workspace(fallback, window, cx);
                        moved.push(window.window_handle().window_id());
                    }
                },
            );
        }
        let Some(removed) = Workspaces::update(cx, |library| library.remove(id)) else {
            return;
        };
        let name = shown_name(&removed.workspace.name);
        let weak = cx.entity().downgrade();
        let id = id.to_string();
        let notification = gpui_kit::component::notification::Notification::new()
            .title(t!("Layout"))
            .message(space_mixed_script(&t!("Deleted “{name}”", name = name)))
            .action(move |_, _, _| {
                let removed = removed.clone();
                let weak = weak.clone();
                let id = id.clone();
                let moved = moved.clone();
                gpui_kit::component::button::Button::new("undo-delete-workspace")
                    .label(t!("Undo"))
                    .on_click(move |_, window, cx| {
                        Workspaces::update(cx, |library| library.restore(removed.clone()));
                        if was_current {
                            weak.update(cx, |shell, cx| shell.switch_workspace(&id, window, cx))
                                .ok();
                        }
                        crate::shell::windows::for_shells(
                            cx,
                            |other| moved.contains(&other),
                            |shell, window, cx| shell.switch_workspace(&id, window, cx),
                        );
                    })
            });
        use gpui_kit::component::WindowExt as _;
        window.push_notification(notification, cx);
    }
}

/// The folded switch's button, which a dropdown menu opens from.
#[derive(IntoElement)]
struct FoldedSwitch(gpui::Stateful<gpui::Div>);

impl gpui::Styled for FoldedSwitch {
    fn style(&mut self) -> &mut gpui::StyleRefinement {
        self.0.style()
    }
}

impl gpui::InteractiveElement for FoldedSwitch {
    fn interactivity(&mut self) -> &mut gpui::Interactivity {
        self.0.interactivity()
    }
}

impl gpui::StatefulInteractiveElement for FoldedSwitch {}

impl gpui::ParentElement for FoldedSwitch {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.0.extend(elements)
    }
}

impl gpui_kit::component::Selectable for FoldedSwitch {
    fn selected(self, _: bool) -> Self {
        self
    }

    fn is_selected(&self) -> bool {
        false
    }
}

impl gpui::RenderOnce for FoldedSwitch {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        self.0
    }
}

/// The field a workspace's name is edited in, where its tab (or the folded
/// switch) stands; Escape keeps the old name.
fn rename_field(
    id: impl Into<gpui::ElementId>,
    input: &gpui::Entity<InputState>,
    palette: &lattice_ui::Palette,
    cx: &mut Context<Shell>,
) -> AnyElement {
    div()
        .id(id)
        .h(px(24.))
        .min_w(px(RENAME_MIN))
        .px(px(RENAME_PAD))
        .flex()
        .items_center()
        .rounded(segment_chip_radius())
        .bg(palette.panel)
        .shadow(raised_plate(palette))
        .text_role(TextRole::Caption, cx)
        .capture_key_down(cx.listener(|shell, event: &KeyDownEvent, window, cx| {
            if event.keystroke.key == "escape" {
                shell.finish_rename(window, cx);
                cx.stop_propagation();
            }
        }))
        .child(Input::new(input).appearance(false).bordered(false))
        .into_any_element()
}

/// The selected segment's plate: the panel surface raised, with the strong
/// hairline for its edge.
fn raised_plate(palette: &lattice_ui::Palette) -> Vec<gpui::BoxShadow> {
    let mut plate = vec![ring(palette.line_strong)];
    plate.extend(Elevation::Raised.shadows(palette).into_iter().skip(1));
    plate
}

/// Unsaved changes: the project's layout differs from its workspace.
fn dirty_dot(palette: &lattice_ui::Palette) -> impl IntoElement {
    div()
        .flex_none()
        .size(px(DOT))
        .rounded_full()
        .bg(palette.text_secondary)
}
