//! The compile repair on the card, as the Tauri app draws it
//! (`compile-diagnostics-panel.tsx`, `.compile-repair-*` in app-shell.css):
//! Fix all in the bar, or while the repair runs its progress with Cancel
//! repair (and Unlock anyway once a Cancel has not stopped it); the relay's
//! last word under the bar; and a footer with View repair once the task
//! has a thread, saying whether the build after it still fails.

use gpui::{
    AnimationExt as _, AnyElement, App, Entity, IntoElement as _, ParentElement as _, Styled as _,
    Transformation, div, percentage, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    components::{Button, IconButton},
};

use crate::{
    build::{
        icons,
        repair::{RepairStatus, relay_message},
    },
    build_panel::{BuildAction, BuildPanel, LastBuild},
};

fn act(
    build: &Entity<BuildPanel>,
    action: fn() -> BuildAction,
) -> impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut App) + 'static {
    let build = build.clone();
    move |_, _, cx| build.update(cx, |build, cx| build.act(action(), cx))
}

/// The bar's repair control: the progress of a running repair, else Fix
/// all when there is an error or a warning to fix.
pub(super) fn bar_control(
    panel: &BuildPanel,
    last: &LastBuild,
    build: &Entity<BuildPanel>,
    cx: &App,
) -> Option<AnyElement> {
    let palette = cx.palette().clone();
    if let Some(repair) = panel.repair().filter(|repair| repair.busy()) {
        let spinner = icons::LOADER
            .element(px(13.), palette.text_secondary)
            .with_animation(
                "compile-repair-loader",
                gpui::Animation::new(std::time::Duration::from_secs(1)).repeat(),
                |mark, t| mark.with_transformation(Transformation::rotate(percentage(t))),
            );
        let cancel = (repair.status != RepairStatus::Compiling).then(|| {
            IconButton::new("compile-repair-cancel", icons::SQUARE)
                .frame(px(24.), px(24.))
                .icon_size(px(11.))
                .tooltip(t!("Cancel repair"))
                .on_click(act(build, || BuildAction::CancelRepair))
        });
        let unlock = repair.stopping.then(|| {
            Button::new("compile-repair-unlock", t!("Unlock anyway"))
                .ghost()
                .compact()
                .on_click(act(build, || BuildAction::UnlockRepair))
        });
        return Some(
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(6.))
                .whitespace_nowrap()
                .text_role(TextRole::Caption, cx)
                .child(spinner)
                .child(repair.progress())
                .children(cancel)
                .children(unlock)
                .into_any_element(),
        );
    }
    let counts = crate::build::diagnostics::summarize(&last.diagnostics);
    (counts.error + counts.warning > 0).then(|| {
        Button::new("compile-repair-fix-all", t!("Fix all"))
            .ghost()
            .compact()
            .icon(icons::WAND_SPARKLES)
            .disabled(panel.fix_disabled())
            .on_click(act(build, || BuildAction::FixAll))
            .into_any_element()
    })
}

/// `.compile-repair-detail`: under the bar, a caption that scrolls past
/// 120px.
fn detail(text: String, cx: &App) -> AnyElement {
    div()
        .flex_none()
        .max_h(px(120.))
        .overflow_hidden()
        .pt(px(4.))
        .pb(px(8.))
        .px(px(10.))
        .text_role(TextRole::Caption, cx)
        .child(text)
        .into_any_element()
}

/// What the repair says under the bar: that a Cancel has not stopped it,
/// and the relay's last word.
pub(super) fn details(panel: &BuildPanel, cx: &App) -> Vec<AnyElement> {
    let Some(repair) = panel.repair() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if repair.busy() && repair.stopping {
        out.push(detail(
            t!("The repair has not stopped yet, and the agent may still be editing this file. Unlock anyway only if you want to edit it now.").into(),
            cx,
        ));
    }
    if let Some(message) = &repair.message {
        out.push(detail(relay_message(message), cx));
    }
    out
}

/// The footer once the task has a thread: its outcome, and View repair.
pub(super) fn footer(
    panel: &BuildPanel,
    last: &LastBuild,
    build: &Entity<BuildPanel>,
    cx: &App,
) -> Option<AnyElement> {
    let repair = panel.repair()?;
    repair.thread_id.as_ref()?;
    let palette = cx.palette().clone();
    let status = (repair.status == RepairStatus::Completed).then(|| {
        // The build after the repair is what the card shows: errors still
        // here were not fixed.
        let errors = crate::build::diagnostics::summarize(&last.diagnostics).error;
        div().mr_auto().child(if errors > 0 {
            t!("Repair finished, but the build still has errors")
        } else {
            t!("Repair finished")
        })
    });
    Some(
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_end()
            .gap(px(8.))
            .py(px(4.))
            .px(px(8.))
            .border_t_1()
            .border_color(palette.line)
            .text_role(TextRole::Caption, cx)
            .children(status)
            .child(
                Button::new("compile-repair-view", t!("View repair"))
                    .ghost()
                    .compact()
                    .on_click(act(build, || BuildAction::ViewRepair)),
            )
            .into_any_element(),
    )
}
