//! Opening Settings over the window, or bringing it to a page, and what it
//! asks of the window (closing, cleaning the build files).

use gpui::{App, AppContext as _, Context, Window};

use super::Shell;

impl Shell {
    /// Open Settings (on `tab`, else where it was left), or bring it to
    /// that page if it is open.
    pub(crate) fn open_settings(
        &mut self,
        tab: Option<lattice_settings::SettingsTab>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(settings) = &self.settings {
            if let Some(tab) = tab {
                settings.update(cx, |settings, cx| settings.open_tab(tab, cx));
            }
            return;
        }
        self.palette = None;
        self.shortcuts = None;
        let weak = cx.entity().downgrade();
        let project = self.project.clone();
        let live = Some(self.live_preview.clone());
        let view =
            cx.new(|cx| crate::settings::SettingsDialog::new(weak, project, live, tab, window, cx));
        cx.subscribe_in(
            &view,
            window,
            |this, _, event: &crate::settings::SettingsEvent, window, cx| match event {
                crate::settings::SettingsEvent::Close => {
                    this.settings = None;
                    this.focus_front(window, cx);
                    cx.notify();
                }
                crate::settings::SettingsEvent::CleanBuildFiles => {
                    window.dispatch_action(Box::new(super::CleanBuildFiles), cx)
                }
            },
        )
        .detach();
        let dialog = view.clone();
        window.on_next_frame(move |window, cx| {
            dialog.update(cx, |dialog, cx| dialog.focus_search(window, cx))
        });
        self.settings = Some(view);
        cx.notify();
    }

    /// Whether this window is cleaning its build files, and building, for
    /// Settings' Clean button.
    pub(crate) fn settings_busy(&self, _: &App) -> (bool, bool) {
        (self.cleaning, self.build_task.is_some())
    }
}
