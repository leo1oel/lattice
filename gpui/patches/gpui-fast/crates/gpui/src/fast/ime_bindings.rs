//! Whether a printable key typed while an input method is selected is one a
//! key binding takes by itself.
//!
//! While a composition-based input method is selected (Pinyin, Japanese
//! kana, Korean), upstream hands every printable key to it first, so that
//! a key it composes is not taken by the prefix of a multi-stroke binding
//! (`j j` in Vim's insert mode). But a key it does not compose then never
//! reached the keymap: Pinyin inserts its own `￥` for `$` and `：` for
//! `:`, so a LaTeX file's `$` pairing and Vim's `:` did nothing for anyone
//! typing Chinese. The macOS platform still hands the key to the input method
//! (`gpui_macos`'s `fast::ime_keys`), but when this says a binding takes it,
//! what the method inserts for it goes to the binding instead, as a browser's
//! page takes a key it handles from the text the input method would insert.
//! A binding's prefix and an unbound key are the input method's alone.

use crate::{App, Keystroke, Window};

/// Whether `keystroke`, typed now in `window`, completes a key binding of
/// the focused context by itself, with no longer binding waiting on it.
pub(crate) fn binds_printable_key(window: &Window, cx: &App, keystroke: &Keystroke) -> bool {
    if window.has_pending_keystrokes() {
        return false;
    }
    let (bindings, pending) = cx
        .key_bindings()
        .borrow()
        .bindings_for_input(std::slice::from_ref(keystroke), &window.context_stack());
    !bindings.is_empty() && !pending
}

#[cfg(test)]
mod tests {
    use crate::{
        self as gpui, Context, FocusHandle, IntoElement, KeyBinding, Keystroke, Render,
        TestAppContext, VisualTestContext, Window, actions, div, prelude::*,
    };

    actions!(ime_bindings_test, [Dollar, NormalBefore]);

    struct Editor {
        focus_handle: FocusHandle,
    }

    impl Render for Editor {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().key_context("Editor").track_focus(&self.focus_handle)
        }
    }

    fn binds(cx: &mut VisualTestContext, key: &'static str) -> bool {
        let keystroke = Keystroke::parse(key).expect("a keystroke");
        cx.update(|window, cx| super::binds_printable_key(window, cx, &keystroke))
    }

    #[crate::test]
    fn a_key_bound_alone_reaches_its_binding_before_the_input_method(cx: &mut TestAppContext) {
        cx.update(|cx| {
            cx.bind_keys([
                KeyBinding::new("$", Dollar, Some("Editor")),
                KeyBinding::new("j j", NormalBefore, Some("Editor")),
                KeyBinding::new(":", Dollar, Some("Terminal")),
            ])
        });
        let (editor, cx) = cx.add_window_view(|_, cx| Editor {
            focus_handle: cx.focus_handle(),
        });
        let focus_handle = editor.update(cx, |editor, _| editor.focus_handle.clone());
        cx.update(|window, cx| window.focus(&focus_handle, cx));
        cx.run_until_parked();

        assert!(binds(cx, "$"));
        // Only the prefix of `j j`: the input method may compose it.
        assert!(!binds(cx, "j"));
        // Bound nowhere, or only in a context that is not focused.
        assert!(!binds(cx, "a"));
        assert!(!binds(cx, ":"));
    }

    #[crate::test]
    fn a_key_that_can_start_a_longer_binding_goes_to_the_input_method(cx: &mut TestAppContext) {
        cx.update(|cx| {
            cx.bind_keys([
                KeyBinding::new("$", Dollar, Some("Editor")),
                KeyBinding::new("$ $", NormalBefore, Some("Editor")),
            ])
        });
        let (editor, cx) = cx.add_window_view(|_, cx| Editor {
            focus_handle: cx.focus_handle(),
        });
        let focus_handle = editor.update(cx, |editor, _| editor.focus_handle.clone());
        cx.update(|window, cx| window.focus(&focus_handle, cx));
        cx.run_until_parked();

        assert!(!binds(cx, "$"));
    }
}
