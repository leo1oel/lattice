//! The window's tree: the shell's actions, the titlebar, the dock on the
//! chrome, and the overlays above it (the palette, the shortcut sheet,
//! Settings, notices, the TeX setup dialogs, confirmations).

use super::*;

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        // The Emacs keymap's bindings are loaded under a context of their
        // own (app.rs), which the shell carries while that keymap is chosen.
        let emacs = crate::settings::get(cx).appearance.editor_keymap
            == lattice_settings::EditorKeymap::Emacs;
        let shell = v_flex()
            .id("lattice-shell")
            .key_context(if emacs {
                "LatticeShell LatticeEmacs"
            } else {
                "LatticeShell"
            })
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::open_folder))
            .on_action(cx.listener(Self::build))
            .on_action(cx.listener(Self::save_all))
            .on_action(cx.listener(Self::forward_sync))
            .on_action(cx.listener(Self::toggle_vim_mode))
            .on_action(cx.listener(Self::stop_build))
            .on_action(cx.listener(Self::clean_rebuild))
            .on_action(cx.listener(Self::clean_build_files))
            .on_action(cx.listener(Self::next_problem))
            .on_action(cx.listener(Self::previous_problem))
            .on_action(cx.listener(Self::open_tex_doctor))
            .on_action(cx.listener(Self::install_latex_tools));
        self.register_commands(shell, cx)
            .relative()
            .size_full()
            .bg(palette.window)
            .text_color(palette.text)
            .child(crate::titlebar::render(self, window, cx))
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .bg(palette.chrome)
                    .pt(px(WORKSPACE_TOP))
                    .px(px(WORKSPACE_SIDE))
                    .pb(px(WORKSPACE_SIDE))
                    .children(lattice_ui::parity::probe("workspace"))
                    .child(self.dock_area.clone())
                    .when(
                        self.center_empty(cx) && !self.dock_area.read(cx).is_zoomed(),
                        |this| this.child(arrange::empty_center(self, cx)),
                    )
                    .children(self.floating.render(self.floating_area(window), cx)),
            )
            .children(self.palette.clone())
            .children(self.shortcuts.clone())
            .children(self.settings.clone())
            .child(self.notices.clone())
            .child(self.tex_setup.clone())
            .child(self.confirm.clone())
    }
}
