//! The Agent panel's permission picker, the Tauri app's
//! `src/agent/synara-permission-picker.tsx` in the panel's header
//! (`trellis-panel-actions.tsx`): a 14px glyph naming the mode the Agent's
//! frame runs in, which opens three choices, each label saying the
//! behaviour, the one in force on a sliding plate with its dot, "Ask for
//! risky actions" faded and inert where the frame says it is unavailable,
//! and Pi's note when a model endpoint is saved.
//!
//! The mode is the frame's: the page relays what Synara reports
//! (`synara:agent-permission-mode`, `agent:permission`) and a choice goes
//! back to it (`lattice:set-agent-permission-mode`); this is the window's
//! only copy, which other parts of the window read through the surface.

use gpui::{
    Anchor, AnyElement, App, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{IconButton, MenuSurface, Popover, Surface, TAB_RADIUS},
    interaction::{fade, hover_wash, mix},
    motion::Motion,
    sliding::SlidingPlate,
    tokens::{FONT_WEIGHT_REGULAR, FONT_WEIGHT_SEMIBOLD},
};
use serde_json::Value;

use super::{SynaraSurface, commands};

/// How freely the Agent acts (`SynaraPermissionMode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionMode {
    FullAccess,
    Auto,
    ApprovalRequired,
}

impl PermissionMode {
    pub const ALL: [Self; 3] = [Self::FullAccess, Self::Auto, Self::ApprovalRequired];

    /// The wire name (`app-synara-embed.ts`).
    pub fn name(self) -> &'static str {
        match self {
            Self::FullAccess => "full-access",
            Self::Auto => "auto",
            Self::ApprovalRequired => "approval-required",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|mode| mode.name() == name)
    }

    /// Each label says the behaviour, so no option needs a description.
    pub fn label(self) -> &'static str {
        match self {
            Self::FullAccess => t!("Never ask"),
            Self::Auto => t!("Ask for risky actions"),
            Self::ApprovalRequired => t!("Ask before outside edits and network"),
        }
    }

    fn icon(self) -> Icon {
        match self {
            Self::FullAccess => Icon::SHIELD_CHECK,
            Self::Auto => Icon::SHIELD,
            Self::ApprovalRequired => Icon::HAND,
        }
    }
}

/// The frame's mode as it last reported it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AgentPermission {
    pub mode: PermissionMode,
    /// "Ask for risky actions" can be chosen (`autoModeAvailable`).
    pub auto_available: bool,
}

impl AgentPermission {
    /// The page's report (`agent:permission`): `None` while the frame has
    /// not said, as the Tauri header shows no picker without the runtime.
    pub fn parse(payload: &Value) -> Option<Self> {
        let mode = PermissionMode::parse(payload.get("mode")?.as_str()?)?;
        Some(Self {
            mode,
            auto_available: payload.get("autoModeAvailable") != Some(&Value::Bool(false)),
        })
    }
}

impl SynaraSurface {
    /// The frame's permission mode, once it has said (`None` before): the
    /// window's one copy, for the header's picker and whatever else asks.
    pub fn permission(&self) -> Option<AgentPermission> {
        self.permission
    }

    /// A model endpoint is saved (Pi's note under the choices).
    pub fn endpoint_saved(&self) -> bool {
        self.endpoint_saved
    }

    /// Have the frame run in `mode` (`lattice:set-agent-permission-mode`);
    /// the frame's own report then moves the picker.
    pub fn set_permission_mode(&mut self, mode: PermissionMode, cx: &mut gpui::Context<Self>) {
        self.post(
            "agent:set-permission-mode",
            serde_json::json!({ "mode": mode.name() }),
            cx,
        );
    }

    /// The page relayed the frame's mode (`agent:permission`).
    pub(super) fn permission_reported(&mut self, payload: &Value, cx: &mut gpui::Context<Self>) {
        let permission = AgentPermission::parse(payload);
        if permission != self.permission {
            self.permission = permission;
            cx.notify();
        }
        self.read_endpoint(cx);
    }

    /// Whether a model endpoint is saved, read again as the Tauri picker
    /// reads it on opening (`get_model_endpoint`).
    pub(super) fn read_endpoint(&mut self, cx: &mut gpui::Context<Self>) {
        let Some(root) = self.root.clone() else {
            return;
        };
        let read = commands::invoke(&root, "get_model_endpoint", &Value::Null, cx);
        cx.spawn(async move |this, cx| {
            let saved = read
                .await
                .ok()
                .and_then(|status| status.get("endpoint").cloned())
                .is_some_and(|endpoint| !endpoint.is_null());
            this.update(cx, |this, cx| {
                if this.endpoint_saved != saved {
                    this.endpoint_saved = saved;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }
}

/// The picker for `surface`'s frame, in the panel's header.
pub fn picker(
    surface: &Entity<SynaraSurface>,
    permission: AgentPermission,
    endpoint_saved: bool,
) -> AnyElement {
    let label = t!(
        "Agent permissions: {label}",
        label = permission.mode.label()
    );
    let trigger = IconButton::new("agent-permission-trigger", permission.mode.icon())
        .radius(TAB_RADIUS)
        .surface(Surface::SidePanel)
        .tooltip(label);
    let surface = surface.downgrade();
    Popover::new("agent-permission-picker", trigger, move |window, cx| {
        menu(&surface, permission, endpoint_saved, window, cx)
    })
    .anchor(Anchor::TopRight)
    .into_any_element()
}

/// The three choices on the editor's ground (`.agent-permission-menu`):
/// 292 wide, 4px in, each row 36px, 8px by 10px inside.
fn menu(
    surface: &gpui::WeakEntity<SynaraSurface>,
    permission: AgentPermission,
    endpoint_saved: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let chosen = PermissionMode::ALL
        .iter()
        .position(|mode| *mode == permission.mode);
    let plate = SlidingPlate::new("agent-permission-plate", chosen, window, cx);
    let plate_drawn = plate.is_drawn(cx);
    let rows = PermissionMode::ALL
        .into_iter()
        .enumerate()
        .map(|(ix, mode)| {
            let selected = mode == permission.mode;
            let disabled = mode == PermissionMode::Auto && !permission.auto_available;
            let on = fade(
                ("agent-permission-on", ix),
                selected,
                Motion::Fast,
                window,
                cx,
            );
            // The ring gives way to the dot, which springs in from 30%.
            let radio = div()
                .relative()
                .flex_none()
                .size(px(16.))
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .rounded_full()
                        .border(px(1.5))
                        .border_color(mix(
                            palette.line_strong,
                            palette.line_strong.opacity(0.),
                            on,
                        )),
                )
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .opacity(on)
                        .child(
                            div()
                                .size(px(8. * (0.3 + 0.7 * on)))
                                .rounded_full()
                                .bg(palette.text),
                        ),
                );
            let surface = surface.clone();
            let row = div()
                .id(("agent-permission-option", ix))
                .relative()
                .h(px(36.))
                .flex()
                .items_center()
                .gap(px(8.))
                .px(px(10.))
                .rounded(px(8.))
                .when(disabled, |this| this.opacity(0.42))
                .when(!disabled, |this| this.cursor_pointer())
                .when(selected && !plate_drawn, |this| this.bg(palette.pressed))
                .child(radio)
                .child(
                    div()
                        .text_role(TextRole::Body, cx)
                        .font_weight(if selected {
                            FONT_WEIGHT_SEMIBOLD
                        } else {
                            FONT_WEIGHT_REGULAR
                        })
                        .text_color(if selected {
                            palette.text
                        } else {
                            palette.text_secondary
                        })
                        .child(SharedString::from(mode.label())),
                )
                .when(!disabled, |this| {
                    this.on_click(move |_, _, cx| {
                        surface
                            .update(cx, |surface, cx| surface.set_permission_mode(mode, cx))
                            .ok();
                    })
                });
            let row = if disabled {
                row.into_any_element()
            } else {
                hover_wash(
                    row,
                    ("agent-permission-hover", ix),
                    gpui::transparent_black(),
                    palette.hover,
                    window,
                    cx,
                )
                .into_any_element()
            };
            plate.item(ix, row)
        });
    let rows: Vec<_> = rows.collect();
    let group = plate.strip(
        div()
            .relative()
            .flex()
            .flex_col()
            .children(plate.plate(|plate| plate.rounded(px(8.)).bg(palette.pressed), cx))
            .children(rows),
    );
    MenuSurface::new()
        .w(px(292.))
        .p(px(4.))
        .bg(palette.editor)
        .child(group)
        .when(endpoint_saved, |this| {
            this.child(
                div()
                    .mt(px(4.))
                    .pt(px(6.))
                    .px(px(10.))
                    .pb(px(4.))
                    .border_t_1()
                    .border_color(palette.line)
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(t!(
                        "With a model endpoint, Pi asks before it edits a file or runs a command in “Ask before outside edits and network”, and runs them without asking in “Never ask”. Its edits are checkpointed so you can undo them, and .bib files stay protected."
                    )),
            )
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // `isSynaraPermissionMode` and the page's report: a mode the Tauri
    // host does not know is no report, and only an explicit `false` takes
    // "Ask for risky actions" away.
    #[test]
    fn reads_the_frames_report_as_the_tauri_host_does() {
        assert_eq!(
            AgentPermission::parse(&json!({ "mode": "auto" })),
            Some(AgentPermission {
                mode: PermissionMode::Auto,
                auto_available: true,
            })
        );
        assert_eq!(
            AgentPermission::parse(
                &json!({ "mode": "approval-required", "autoModeAvailable": false })
            ),
            Some(AgentPermission {
                mode: PermissionMode::ApprovalRequired,
                auto_available: false,
            })
        );
        assert_eq!(AgentPermission::parse(&json!({ "mode": "root" })), None);
        assert_eq!(AgentPermission::parse(&json!({ "mode": null })), None);
        for mode in PermissionMode::ALL {
            assert_eq!(PermissionMode::parse(mode.name()), Some(mode));
        }
    }
}
