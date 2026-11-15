//! Vim's command line in the source editor: `:` in Vim's normal or visual
//! mode opens a `:` field at the editor's foot, as the Tauri app's
//! CodeMirror Vim does (its panel at the bottom, `.cm-panels-bottom`), and
//! Enter runs what was typed: `:w` saves (and builds) as ⌘S does, `:q`
//! closes the tab as ⌘W does, `:wq` both (`src/canvas/vim-ex-commands.ts`),
//! and `:N` goes to line N. Escape closes it, the keys back in the text, and
//! it closes when its field loses the keyboard, as CodeMirror Vim's does.
//!
//! Zed's own `:` opens Zed's command palette, which the GPUI app does not
//! host, and its `:w` saves through a Zed workspace, so neither reached
//! Lattice's Save.

use gpui::{
    AnyElement, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement as _, KeyDownEvent, ParentElement as _, Styled as _, Subscription, Window, actions,
    div, px,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _};

use super::EditorPanel;

actions!(lattice, [VimCommandLine]);

/// What a command line asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExCommand {
    Write,
    Quit,
    WriteQuit,
    /// A 1-based line.
    Line(u32),
}

/// The command `text` names (after the `:`): `w` or any longer prefix of
/// `write`, `q` or of `quit`, `wq`, or a line number. Anything else is none.
pub fn ex_command(text: &str) -> Option<ExCommand> {
    let text = text.trim();
    let names = |name: &str| !text.is_empty() && name.starts_with(text);
    if text == "wq" {
        Some(ExCommand::WriteQuit)
    } else if text.starts_with('w') && names("write") {
        Some(ExCommand::Write)
    } else if text.starts_with('q') && names("quit") {
        Some(ExCommand::Quit)
    } else {
        text.parse::<u32>()
            .ok()
            .filter(|line| *line > 0)
            .map(ExCommand::Line)
    }
}

/// The open command line: its field, and what hears its Enter.
pub(super) type VimExLine = (Entity<InputState>, Subscription);

impl EditorPanel {
    /// `:`'s handler, on the panel's element: the line opens while the
    /// keyboard is in the text, else the key goes on.
    pub(super) fn vim_ex_actions(element: gpui::Div, cx: &mut Context<Self>) -> gpui::Div {
        element.on_action(cx.listener(|this, _: &VimCommandLine, window, cx| {
            if !this.editor().focus_handle(cx).is_focused(window) {
                cx.propagate();
                return;
            }
            this.open_vim_ex(window, cx)
        }))
    }

    /// Whether Vim's `:` line is open.
    pub(crate) fn vim_ex_open(&self) -> bool {
        self.vim_ex.is_some()
    }

    fn open_vim_ex(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let input = cx.new(|cx| InputState::new(window, cx));
        let subscription = cx.subscribe_in(
            &input,
            window,
            |this, input, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { .. } => {
                    let command = ex_command(&input.read(cx).value());
                    this.close_vim_ex(window, cx);
                    if let Some(command) = command {
                        this.run_ex(command, window, cx);
                    }
                }
                InputEvent::Blur => {
                    this.vim_ex = None;
                    cx.notify();
                }
                _ => {}
            },
        );
        let focus = input.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
        self.vim_ex = Some((input, subscription));
        cx.notify();
    }

    fn close_vim_ex(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.vim_ex.take().is_some() {
            let focus = self.editor().focus_handle(cx);
            window.focus(&focus, cx);
            cx.notify();
        }
    }

    fn run_ex(&mut self, command: ExCommand, window: &mut Window, cx: &mut Context<Self>) {
        let save = || Box::new(crate::shell::Save) as Box<dyn gpui::Action>;
        let close = || Box::new(crate::shell::commands::CloseTab) as Box<dyn gpui::Action>;
        match command {
            ExCommand::Write => window.dispatch_action(save(), cx),
            ExCommand::Quit => window.dispatch_action(close(), cx),
            ExCommand::WriteQuit => {
                window.dispatch_action(save(), cx);
                window.dispatch_action(close(), cx);
            }
            ExCommand::Line(line) => self.go_to_line(line, window, cx),
        }
    }

    /// The open line at the editor's foot: `:` and its field, on the raised
    /// ground of CodeMirror's bottom panels with their hairline above, in
    /// the editor's face as CodeMirror Vim's dialog is.
    pub(super) fn vim_ex_line(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let (input, _) = self.vim_ex.as_ref()?;
        let palette = cx.palette().clone();
        Some(
            div()
                .id("vim-command-line")
                .absolute()
                .left_0()
                .right_0()
                .bottom_0()
                .flex()
                .items_center()
                .gap(px(2.))
                .px(px(8.))
                .py(px(4.))
                .bg(palette.raised)
                .border_t_1()
                .border_color(palette.line)
                .text_role(TextRole::Caption, cx)
                .font_family(cx.lattice().fonts.editor.clone())
                .text_color(palette.text_secondary)
                .capture_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                    if event.keystroke.key == "escape" {
                        cx.stop_propagation();
                        this.close_vim_ex(window, cx);
                    }
                }))
                .child(":")
                .child(
                    Input::new(input)
                        .appearance(false)
                        .px_0()
                        .py_0()
                        .text_size(TextRole::Caption.font_size(Default::default(), cx)),
                )
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{ExCommand, ex_command};

    #[test]
    fn names_the_commands_vim_and_the_tauri_app_define() {
        for text in ["w", "wr", "write", " w "] {
            assert_eq!(ex_command(text), Some(ExCommand::Write), "{text}");
        }
        for text in ["q", "qu", "quit"] {
            assert_eq!(ex_command(text), Some(ExCommand::Quit), "{text}");
        }
        assert_eq!(ex_command("wq"), Some(ExCommand::WriteQuit));
        assert_eq!(ex_command("12"), Some(ExCommand::Line(12)));
        for text in ["", "0", "writes", "x", "wqa", "qa"] {
            assert_eq!(ex_command(text), None, "{text}");
        }
    }
}
