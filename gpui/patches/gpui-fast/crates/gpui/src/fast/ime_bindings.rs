//! A printable key bound in the focused context reaches its binding before the
//! input method.
//!
//! While a composition-based input method is selected (Pinyin, Japanese
//! kana, Korean), upstream hands every printable key to it first, so that
//! a key it composes is not taken by the prefix of a multi-stroke binding
//! (`j j` in Vim's insert mode). But a key the input method does not compose
//! is then never seen by the keymap: Pinyin turns `$` into `￥` and `:`
//! into `：` and inserts them, so a LaTeX file's `$` pairing or Vim's `:`
//! did nothing for anyone typing Chinese. A browser sends a key to the page
//! before the input method takes it unless it is composing, which is what
//! the Tauri app's bindings rely on. Here a key that completes a binding on
//! its own goes to the keymap first, as it does without an input method; a
//! key that is only a binding's prefix, or bound nowhere, still goes to the
//! input method, and so does every key while text is marked.

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
