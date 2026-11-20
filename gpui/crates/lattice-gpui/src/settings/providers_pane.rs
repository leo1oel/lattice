//! Settings › Providers, MCP, Skills, Usage & limits and Archived threads (the
//! Tauri app's `agent`, `mcp`, `api`, `usage` and `archived` tabs): Synara's
//! own settings pages for the open project, the Agent island's `settings`
//! surface, filling the page as `synara-settings-pane.tsx` fills the Tauri dialog's. One surface serves
//! the five, so a switch between them is a message to its loaded page, never
//! a reload. The page scrolls in the island, so the surface takes the whole
//! content column.

use gpui::{AnyElement, App, Entity, IntoElement, ParentElement as _, Styled as _, div};
use lattice_i18n::t;
use lattice_settings::SettingsTab;
use lattice_ui::components::EmptyState;

use crate::agent::SynaraSurface;

/// The Synara settings section a tab shows (`SYNARA_SETTINGS_SECTIONS`),
/// with the tab's label, or none for a tab of the app's own.
pub fn section(tab: SettingsTab) -> Option<(&'static str, String)> {
    Some(match tab {
        SettingsTab::Agent => ("providers", t!("Providers").to_string()),
        SettingsTab::Mcp => ("integrations", t!("MCP").to_string()),
        SettingsTab::Api => ("skills", t!("Skills").to_string()),
        SettingsTab::Usage => ("usage", t!("Usage & limits").to_string()),
        SettingsTab::Archived => ("archived", t!("Archived threads").to_string()),
        _ => return None,
    })
}

pub fn render(
    surface: Entity<SynaraSurface>,
    tab: SettingsTab,
    compact: bool,
    cx: &mut App,
) -> AnyElement {
    let page = div().flex_1().min_h_0().w_full().flex().flex_col();
    if surface.read(cx).root().is_none() {
        return page
            .justify_center()
            .child(EmptyState::new(t!("No project open")))
            .into_any_element();
    }
    let (section, label) = section(tab).unwrap_or(("providers", t!("Providers").to_string()));
    surface.update(cx, |surface, cx| {
        surface.set_settings_layout(compact, section, label, cx)
    });
    page.child(surface).into_any_element()
}
