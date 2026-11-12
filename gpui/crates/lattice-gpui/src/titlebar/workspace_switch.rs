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
use gpui_kit::component::{
    input::{Input, InputEvent, InputState},
    menu::{ContextMenuExt as _, DropdownMenu as _, PopupMenu, PopupMenuItem},
};
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{LatticeTooltip, focus_ring},
    elevation::ring,
    icons::{ICON, ICON_SMALL},
    interaction::{mix, tab_stop, track_pointer, use_interaction},
    parity,
};

use crate::shell::{
    Shell,
    commands::NewWorkspace,
    workspaces::{RenameError, Workspaces, shortcut_label},
};

/// The workspace a folded switch names is cut at about 9em.
const FOLDED_NAME_MAX: f32 = 112.;

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
        .map(|entry| (entry.id.clone(), entry.name.clone()))
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
        .p(px(2.))
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
            .rounded(px(7.4))
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
            .child(Icon::CHEVRON_DOWN.element(ICON_SMALL, palette.text_secondary))
            .dropdown_menu(move |mut menu, window, cx| {
                for (ix, (id, name)) in entries.iter().enumerate() {
                    let weak = menu_weak.clone();
                    let id = id.clone();
                    let mut item = PopupMenuItem::new(name.clone())
                        .checked(menu_current.as_deref() == Some(id.as_str()))
                        .on_click(move |_, window, cx| {
                            weak.update(cx, |shell, cx| shell.switch_workspace(&id, window, cx))
                                .ok();
                        });
                    if let Some(action) = crate::shell::commands::switch_workspace_action(ix) {
                        item = item.action(action);
                    }
                    menu = menu.item(item);
                }
                menu = menu
                    .separator()
                    .menu_with_icon("New workspace", Icon::PLUS.kit(), Box::new(NewWorkspace))
                    .separator();
                match &menu_current {
                    Some(id) => workspace_actions(menu, id, dirty, menu_weak.clone(), window, cx),
                    None => menu,
                }
            });
        return track.child(button).into_any_element();
    }

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
                format!("Return to {name}")
            } else {
                name.clone()
            };
            match shortcut_label(ix) {
                Some(keys) => format!("{label} ({keys})").into(),
                None => label.into(),
            }
        };
        let switch_weak = weak.clone();
        let rename_weak = weak.clone();
        let menu_weak = weak.clone();
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
            .gap(px(6.))
            .h(px(24.))
            .px(px(10.))
            .rounded(px(7.4))
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
            .context_menu(move |menu, window, cx| {
                workspace_actions(
                    menu,
                    &menu_id,
                    dirty && is_current,
                    menu_weak.clone(),
                    window,
                    cx,
                )
            })
            .into_any_element()
    });
    let add_weak = weak.clone();
    let tabs: Vec<AnyElement> = tabs.collect();
    track
        .children(tabs)
        .child(
            div()
                .id("workspace-add")
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .w(px(28.))
                .h(px(24.))
                .rounded(px(7.4))
                .cursor_pointer()
                .text_color(palette.text_secondary)
                .hover(|style| style.text_color(palette.text))
                .tooltip(|_, cx| -> AnyView { LatticeTooltip::view("New workspace", None, cx) })
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
    menu: PopupMenu,
    id: &str,
    dirty: bool,
    shell: gpui::WeakEntity<Shell>,
    _: &mut Window,
    cx: &mut Context<PopupMenu>,
) -> PopupMenu {
    let library = Workspaces::global(cx);
    let index = library.index_of(id).unwrap_or(0);
    let count = library.list().len();
    let mut menu = menu;
    let item = |label: &str,
                icon: Icon,
                run: Box<dyn Fn(&mut Shell, &mut Window, &mut Context<Shell>)>| {
        let shell = shell.clone();
        PopupMenuItem::new(label.to_string())
            .icon(icon.kit())
            .on_click(move |_, window, cx| {
                shell.update(cx, |shell, cx| run(shell, window, cx)).ok();
            })
    };
    if dirty {
        menu = menu
            .item(item(
                "Save to workspace",
                Icon::SAVE,
                Box::new(|shell, window, cx| shell.save_workspace(window, cx)),
            ))
            .item(item(
                "Revert to saved",
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
        "Rename",
        Icon::PENCIL,
        Box::new(move |shell, window, cx| shell.start_rename(&rename, window, cx)),
    ))
    .item(item(
        "Duplicate",
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
            "Move left",
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
            "Move right",
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
            "Delete",
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
            .map(|entry| entry.name.clone())
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
        let name = removed.workspace.name.clone();
        let weak = cx.entity().downgrade();
        let id = id.to_string();
        let notification = gpui_kit::component::notification::Notification::new()
            .title("Layout")
            .message(format!("Deleted “{name}”"))
            .action(move |_, _, _| {
                let removed = removed.clone();
                let weak = weak.clone();
                let id = id.clone();
                let moved = moved.clone();
                gpui_kit::component::button::Button::new("undo-delete-workspace")
                    .label("Undo")
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

impl gpui_kit::component::menu::DropdownMenu for FoldedSwitch {}

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
        .min_w(px(6. * 7. + 20.))
        .px(px(6.))
        .flex()
        .items_center()
        .rounded(px(7.4))
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
        .size(px(5.))
        .rounded_full()
        .bg(palette.text_secondary)
}
