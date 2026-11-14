//! Settings › Providers (the Tauri app's `agent` tab): Synara's own settings
//! page for the open project, the Agent island's `settings` surface, filling
//! the page as `synara-settings-pane.tsx` fills the Tauri dialog's. The page
//! scrolls in the island, so the surface takes the whole content column.

use gpui::{AnyElement, App, Entity, IntoElement, ParentElement as _, Styled as _, div};
use lattice_i18n::t;
use lattice_ui::components::EmptyState;

use crate::agent::SynaraSurface;

pub fn render(surface: Option<Entity<SynaraSurface>>, compact: bool, cx: &mut App) -> AnyElement {
    let page = div().flex_1().min_h_0().w_full().flex().flex_col();
    let Some(surface) = surface.filter(|surface| surface.read(cx).root().is_some()) else {
        return page
            .justify_center()
            .child(EmptyState::new(t!("No project open")))
            .into_any_element();
    };
    surface.update(cx, |surface, cx| surface.set_settings_compact(compact, cx));
    page.child(surface).into_any_element()
}
