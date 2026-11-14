//! Settings › Providers, where the Agent's "Provider settings" lead
//! (`agent:open-settings`).
//!
//! The Tauri app hosts Synara's own settings page here
//! (`synara-settings-pane.tsx`). The GPUI app does not host that page yet,
//! so this one says where a provider is chosen today, the Agent panel's own
//! picker, and opens the Agent.

use gpui::{AnyElement, Context};
use lattice_i18n::t;
use lattice_ui::components::Button;

use super::{
    controls::{self, PageWidth, Row},
    dialog::SettingsDialog,
};

pub fn render(width: PageWidth, cx: &mut Context<SettingsDialog>) -> AnyElement {
    let this = cx.entity();
    let open = Button::new("providers-open-agent", t!("Open Agent"))
        .compact()
        .on_click(move |_, _, cx| this.update(cx, |dialog, cx| dialog.open_agent(cx)));
    let rows = vec![
        Row::new("provider-binary-paths", t!("Provider settings"))
            .description(
                t!("Claude Code and Codex are found on your PATH. Choose a provider and its model in the Agent panel’s own picker."),
                cx,
            )
            .control(open)
            .render(width, cx),
    ];
    controls::page(
        t!("Providers"),
        width,
        vec![controls::first_group(None, rows, cx)],
        cx,
    )
}
