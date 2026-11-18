//! Which page Settings draws for each section, and what a page keeps once it
//! has been drawn (a form's fields, a report read off the main thread), for
//! as long as Settings stays open.

use gpui::{AnyElement, Context, Entity, IntoElement as _, Window};
use lattice_settings::SettingsTab;

use super::{controls::PageWidth, dialog::SettingsDialog};

/// The state the pages make the first time they are drawn.
#[derive(Default)]
pub struct PageStates {
    /// Settings › Model endpoint's form.
    pub model_endpoint: Option<Entity<super::model_endpoint_pane::ModelEndpointPane>>,
    /// Settings › Environment's report.
    pub environment: Option<Entity<super::environment_pane::EnvironmentPane>>,
    /// Settings › Literature services' keys.
    pub literature: Option<Entity<super::literature_pane::LiteraturePane>>,
    /// Settings › Acknowledgements' search, folds and sheet.
    pub acknowledgements: Option<Entity<super::acknowledgements::Acknowledgements>>,
    /// Settings › Plugins' list and install form.
    pub plugins: Option<Entity<super::plugins_pane::PluginsPane>>,
    /// Appearance › Theme files › Browse themes, while its sheet is open.
    pub theme_browse: Option<Entity<super::theme_browse::ThemeBrowse>>,
}

/// The sheet a page holds open over Settings (Acknowledgements' notices or
/// font license), as a layer of its own over the window.
pub fn sheet(dialog: &SettingsDialog, cx: &mut gpui::App) -> Option<AnyElement> {
    if let Some(browse) = dialog.pages.theme_browse.clone() {
        return Some(super::theme_browse::sheet(browse, cx));
    }
    let pane = dialog.pages.acknowledgements.clone()?;
    let surface = {
        let close = pane.downgrade();
        let sheet = pane.read(cx).sheet.clone()?;
        // The sheet's own close plays the layer's exit first.
        sheet.render(
            move |window, cx| {
                let close = close.clone();
                lattice_ui::components::ModalLayer::leave(
                    "settings-sheet-layer",
                    window,
                    cx,
                    move |_, cx| {
                        close.update(cx, |pane, cx| pane.close_sheet(cx)).ok();
                    },
                );
            },
            cx,
        )
    };
    let close = pane.downgrade();
    Some(
        lattice_ui::components::ModalLayer::new(
            "settings-sheet-layer",
            lattice_ui::components::LayerPlacement::Center,
            surface,
            move |_, cx| {
                close.update(cx, |pane, cx| pane.close_sheet(cx)).ok();
            },
        )
        .into_any_element(),
    )
}

/// The dialog's row marks, for a page drawn in an entity of its own.
pub fn marks(dialog: &SettingsDialog) -> super::controls::Marks {
    super::controls::Marks {
        rows: dialog.rows.clone(),
        revealed: dialog.revealed_row().map(|id| (id, dialog.revealed(id))),
    }
}

/// The pages the GPUI app draws; another remembered page opens Appearance.
pub fn drawn(tab: SettingsTab) -> SettingsTab {
    match tab {
        SettingsTab::Editor
        | SettingsTab::Agent
        | SettingsTab::Mcp
        | SettingsTab::Api
        | SettingsTab::Usage
        | SettingsTab::ModelEndpoint
        | SettingsTab::Environment
        | SettingsTab::Literature
        | SettingsTab::Plugins
        | SettingsTab::Acknowledgements
        | SettingsTab::Doctor
        | SettingsTab::Overleaf
        | SettingsTab::Logs => tab,
        _ => SettingsTab::Appearance,
    }
}

/// The page for the dialog's section (Logs aside, which fills the page).
pub fn draw(
    dialog: &mut SettingsDialog,
    width: PageWidth,
    window: &mut Window,
    cx: &mut Context<SettingsDialog>,
) -> AnyElement {
    match dialog.tab {
        SettingsTab::Editor => super::editor_pane::render(dialog, width, window, cx),
        SettingsTab::Agent | SettingsTab::Mcp | SettingsTab::Api | SettingsTab::Usage => {
            let surface = dialog.providers();
            super::providers_pane::render(surface, dialog.tab, width.narrow_dialog, cx)
        }
        SettingsTab::ModelEndpoint => super::model_endpoint_pane::render(dialog, width, window, cx),
        SettingsTab::Environment => super::environment_pane::render(dialog, width, cx),
        SettingsTab::Literature => super::literature_pane::render(dialog, width, window, cx),
        SettingsTab::Plugins => super::plugins_pane::render(dialog, width, window, cx),
        SettingsTab::Acknowledgements => super::acknowledgements::render(dialog, width, window, cx),
        SettingsTab::Doctor => super::editor_pane::doctor(width, cx),
        SettingsTab::Overleaf => super::overleaf_pane::render(dialog, width, window, cx),
        _ => super::appearance_pane::render(dialog, width, window, cx),
    }
}

/// What a scenario reads of the pages.
impl SettingsDialog {
    /// The rows the page on screen drew, Settings search's reveal targets.
    pub fn drawn_rows(&self) -> Vec<&'static str> {
        let mut rows: Vec<&'static str> = self.rows.borrow().keys().copied().collect();
        rows.sort_unstable();
        rows
    }

    /// A project is open in the window, which some rows need.
    pub fn has_project(&self) -> bool {
        self.project.is_some()
    }

    /// The Synara settings section the Agent pages' surface shows.
    pub fn synara_section(&self, cx: &gpui::App) -> &'static str {
        self.providers().read(cx).settings_section()
    }

    /// Settings › Plugins, once drawn.
    pub fn plugins_pane(&self) -> Option<Entity<super::plugins_pane::PluginsPane>> {
        self.pages.plugins.clone()
    }

    /// Acknowledgements' sheet is open over Settings.
    pub fn sheet_open(&self, cx: &gpui::App) -> bool {
        self.pages.theme_browse.is_some()
            || self
                .pages
                .acknowledgements
                .as_ref()
                .is_some_and(|pane| pane.read(cx).sheet.is_some())
    }

    /// Open Acknowledgements' whole notices file, as its header's button does.
    pub fn open_notices(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(pane) = self.pages.acknowledgements.clone() {
            pane.update(cx, |pane, cx| pane.open_whole_notices(window, cx));
        }
    }
}
