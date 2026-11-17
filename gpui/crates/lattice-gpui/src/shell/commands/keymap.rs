//! The default keymap (`bind_keys`): the Tauri app's keys, on ⌘ (Ctrl off
//! macOS), with Vim's own keys left to it off macOS.

use gpui::{App, KeyBinding};

use super::*;

/// `mod-<keys>`: ⌘ on macOS, Ctrl elsewhere, as a `'static` keystroke.
#[cfg(target_os = "macos")]
macro_rules! m {
    ($keys:literal) => {
        concat!("cmd-", $keys)
    };
}
#[cfg(not(target_os = "macos"))]
macro_rules! m {
    ($keys:literal) => {
        concat!("ctrl-", $keys)
    };
}

/// Off macOS a shortcut's Ctrl key is Vim's in the editor where `context`
/// does not hold: vim.json binds it there to an action of its own, so the
/// shortcut yields in those Vim modes and works everywhere else. Quitting
/// there is Alt+F4 or the menu.
#[cfg(target_os = "macos")]
fn beside_vim(_context: &'static str) -> Option<&'static str> {
    None
}
#[cfg(not(target_os = "macos"))]
fn beside_vim(context: &'static str) -> Option<&'static str> {
    Some(context)
}

/// Where the LaTeX source's own format keys apply: a text editor (the panel
/// passes them on unless its file is LaTeX), and off macOS outside Vim's
/// normal and visual modes, where Ctrl+B and Ctrl+I are Vim's.
#[cfg(target_os = "macos")]
const LATEX_FORMAT_KEYS: &str = "Editor";
#[cfg(not(target_os = "macos"))]
const LATEX_FORMAT_KEYS: &str = "Editor && !VimControl";

/// The default keymap, as the Tauri app's command table and Trellis's keymap
/// bind it, plus the window's own (quit, hide, minimize).
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys(default_bindings());
    cx.bind_keys(crate::terminal::key_bindings());
}

fn default_bindings() -> Vec<KeyBinding> {
    let mut bindings = vec![
        KeyBinding::new(m!("o"), OpenFolder, beside_vim("!(vim_mode == insert)")),
        // The source editor's base keys where Zed's differ, as CodeMirror's
        // `defaultKeymap` and `foldKeymap` bind them in the Tauri app
        // (`editor-keymap.ts`). ⌘I selects the enclosing syntax node; it is
        // bound before the LaTeX source's Emphasis below, which takes the
        // key first in a `.tex` file and passes it on elsewhere.
        KeyBinding::new(
            m!("i"),
            editor::actions::SelectLargerSyntaxNode,
            Some(LATEX_FORMAT_KEYS),
        ),
        KeyBinding::new(
            if cfg!(target_os = "macos") {
                "ctrl-l"
            } else {
                "alt-l"
            },
            editor::actions::SelectLine,
            Some("Editor && !VimControl && !LatticeEmacs"),
        ),
        KeyBinding::new(
            m!("alt-\\"),
            editor::actions::AutoIndent,
            Some(LATEX_FORMAT_KEYS),
        ),
        KeyBinding::new(
            "ctrl-alt-[",
            editor::actions::FoldAll,
            Some("Editor && !VimControl"),
        ),
        KeyBinding::new(
            "ctrl-alt-]",
            editor::actions::UnfoldAll,
            Some("Editor && !VimControl"),
        ),
        // No ⌘B for Build: it has no key of its own, as in the Tauri app,
        // where ⌘S saves and builds (`use-command-table.ts`). ⌘B and ⌘I are
        // the LaTeX source's Bold and Emphasis (`latex-shortcuts.ts`), over
        // Zed's own keys there.
        KeyBinding::new(
            m!("b"),
            crate::editor_panel::latex_format::ToggleBold,
            Some(LATEX_FORMAT_KEYS),
        ),
        KeyBinding::new(
            m!("i"),
            crate::editor_panel::latex_format::ToggleEmphasis,
            Some(LATEX_FORMAT_KEYS),
        ),
        // The rest of `latex-shortcuts.ts`, in the LaTeX source.
        KeyBinding::new(
            m!("shift-m"),
            crate::editor_panel::latex_format::ToggleInlineMath,
            Some(LATEX_FORMAT_KEYS),
        ),
        KeyBinding::new(
            m!("/"),
            crate::editor_panel::latex_format::ToggleLineComments,
            Some(LATEX_FORMAT_KEYS),
        ),
        KeyBinding::new(
            m!("alt-/"),
            crate::editor_panel::latex_format::WrapCommentEnvironment,
            Some(LATEX_FORMAT_KEYS),
        ),
        KeyBinding::new(
            m!("alt-;"),
            crate::editor_panel::latex_format::WrapIfFalse,
            Some(LATEX_FORMAT_KEYS),
        ),
        // Margin review's walk, from a pip or card that has focus
        // (`overleaf-margin-review.tsx`'s `walk`): J or ↓ on, K or ↑ back,
        // Escape back out.
        KeyBinding::new(
            "j",
            crate::editor_panel::NextReviewItem,
            Some(crate::editor_panel::MARGIN_CONTEXT),
        ),
        KeyBinding::new(
            "shift-j",
            crate::editor_panel::NextReviewItem,
            Some(crate::editor_panel::MARGIN_CONTEXT),
        ),
        KeyBinding::new(
            "down",
            crate::editor_panel::NextReviewItem,
            Some(crate::editor_panel::MARGIN_CONTEXT),
        ),
        KeyBinding::new(
            "k",
            crate::editor_panel::PreviousReviewItem,
            Some(crate::editor_panel::MARGIN_CONTEXT),
        ),
        KeyBinding::new(
            "shift-k",
            crate::editor_panel::PreviousReviewItem,
            Some(crate::editor_panel::MARGIN_CONTEXT),
        ),
        KeyBinding::new(
            "up",
            crate::editor_panel::PreviousReviewItem,
            Some(crate::editor_panel::MARGIN_CONTEXT),
        ),
        KeyBinding::new(
            "escape",
            crate::editor_panel::LeaveReviewItem,
            Some(crate::editor_panel::MARGIN_CONTEXT),
        ),
        KeyBinding::new(
            m!("alt-k"),
            crate::editor_panel::citation_card::ShowCitationCard,
            Some(LATEX_FORMAT_KEYS),
        ),
        // Tab and ⇧Tab in that card walk its actions, as a browser's focus
        // order does in the Tauri card, over the window root's Tab, which
        // walks every tab stop in the window.
        KeyBinding::new(
            "tab",
            lattice_editor::hover::NextCardAction,
            Some(lattice_editor::hover::KEYBOARD_CARD_CONTEXT),
        ),
        KeyBinding::new(
            "shift-tab",
            lattice_editor::hover::PreviousCardAction,
            Some(lattice_editor::hover::KEYBOARD_CARD_CONTEXT),
        ),
        KeyBinding::new(
            m!("alt-e"),
            crate::editor_panel::latex_format::WrapEquation,
            Some(LATEX_FORMAT_KEYS),
        ),
        KeyBinding::new(
            m!("alt-i"),
            crate::editor_panel::latex_format::WrapItemize,
            Some(LATEX_FORMAT_KEYS),
        ),
        KeyBinding::new(
            m!("alt-s"),
            crate::editor_panel::latex_format::SortLines,
            Some(LATEX_FORMAT_KEYS),
        ),
        KeyBinding::new(
            m!("alt-u"),
            crate::editor_panel::latex_format::UpperCase,
            Some(LATEX_FORMAT_KEYS),
        ),
        KeyBinding::new(
            m!("alt-l"),
            crate::editor_panel::latex_format::LowerCase,
            Some(LATEX_FORMAT_KEYS),
        ),
        KeyBinding::new(
            m!("alt-c"),
            crate::editor_panel::latex_format::TitleCase,
            Some(LATEX_FORMAT_KEYS),
        ),
        KeyBinding::new(
            m!("alt-a"),
            crate::editor_panel::latex_format::SelectEnvironment,
            Some(LATEX_FORMAT_KEYS),
        ),
        KeyBinding::new(
            m!("shift-e"),
            crate::shell::WrapInEnvironment,
            Some(LATEX_FORMAT_KEYS),
        ),
        KeyBinding::new(
            m!("alt-r"),
            crate::shell::RenameEnvironment,
            Some(LATEX_FORMAT_KEYS),
        ),
        // ⌥⌘M, the math symbol palette (`symbolPalette`).
        KeyBinding::new(
            m!("alt-m"),
            crate::editor_panel::symbol_palette::InsertMathSymbol,
            Some(LATEX_FORMAT_KEYS),
        ),
        // Ctrl-M is no ⌘ key, so on every platform Vim's normal and visual
        // modes keep it as their next-line start.
        KeyBinding::new(
            "ctrl-m",
            crate::editor_panel::latex_format::MatchingEnvironment,
            Some("Editor && !VimControl"),
        ),
        // F12, Go to definition (`latexCommandKeymap`'s `definition`), over
        // Zed's own, which needs a language server this editor has not.
        KeyBinding::new(
            "f12",
            crate::editor_panel::definition::GotoDefinition,
            Some(LATEX_FORMAT_KEYS),
        ),
        // Vim's `:` (`editor_panel/vim_ex.rs`): Lattice's command line, over
        // Zed's, which opens a command palette this app does not host.
        KeyBinding::new(
            ":",
            crate::editor_panel::vim_ex::VimCommandLine,
            Some("Editor && mode == full && VimControl && !menu"),
        ),
        // The typing rules (`editor_panel/latex_input.rs`): with Vim on they
        // act only in its insert mode, so every other mode keeps `$` and
        // Enter, the ones waiting for a character (`f$`, `r⏎`, `R`, Ctrl-V)
        // too, and a menu keeps Enter to accept its item. Bound after Zed's
        // keymap, they come before its Newline, which a rule with nothing to
        // do passes the key on to.
        KeyBinding::new(
            "$",
            crate::editor_panel::latex_input::TypeDollar,
            Some("Editor && mode == full && (!vim_mode || vim_mode == insert)"),
        ),
        KeyBinding::new(
            "enter",
            crate::editor_panel::latex_input::LatexNewline,
            Some("Editor && mode == full && (!vim_mode || vim_mode == insert) && !menu"),
        ),
        // Vim's insert mode keeps Ctrl+P for its word completion.
        KeyBinding::new(m!("p"), QuickOpen, beside_vim("!(vim_mode == insert)")),
        KeyBinding::new(m!("shift-f"), FindInProject, None),
        // Back and forward through the places visited, over Zed's outdent
        // and indent in the editor, as the Tauri app's are over
        // CodeMirror's. Off macOS every Vim mode keeps Ctrl+[ as its Escape
        // and Ctrl+] as go to definition.
        KeyBinding::new(m!("["), GoBack, beside_vim("!vim_mode")),
        KeyBinding::new(m!("]"), GoForward, beside_vim("!vim_mode")),
        KeyBinding::new(m!("shift-h"), ReplaceInProject, None),
        // ⌘⇧K and ⌘⇧L are the app's Insert citation and Insert reference,
        // and ⌘⇧O its Go to symbol (`command-keys.ts`), in the editor too:
        // never Zed's delete line and select all matches, which the Tauri
        // app's editor keymaps drop (`editor-app-shortcuts.ts`).
        KeyBinding::new(m!("shift-k"), crate::shell::InsertCitation, None),
        KeyBinding::new(m!("shift-l"), crate::shell::InsertReference, None),
        KeyBinding::new(m!("shift-o"), crate::shell::GoToSymbol, None),
        KeyBinding::new(m!("shift-k"), crate::shell::InsertCitation, Some("Editor")),
        KeyBinding::new(m!("shift-l"), crate::shell::InsertReference, Some("Editor")),
        KeyBinding::new(m!("shift-o"), crate::shell::GoToSymbol, Some("Editor")),
        // ⌘G is Go to line (`GOTO_LINE_KEY`), over Zed's find next in the
        // editor; find next stays on Enter and F3 in the find bar. Off
        // macOS Vim's normal mode keeps Ctrl+G.
        KeyBinding::new(m!("g"), crate::shell::GoToLine, beside_vim("!VimControl")),
        KeyBinding::new(m!("g"), crate::shell::GoToLine, Some(LATEX_FORMAT_KEYS)),
        KeyBinding::new(m!("shift-n"), NewProject, None),
        KeyBinding::new(m!("s"), Save, beside_vim("!(vim_mode == insert)")),
        KeyBinding::new(m!("shift-j"), ForwardSync, None),
        // The Tauri app's next and previous build problem, in the editor
        // too, where Zed's keymap binds them to its own diagnostics.
        KeyBinding::new("f8", NextProblem, None),
        KeyBinding::new("shift-f8", PreviousProblem, None),
        KeyBinding::new("f8", NextProblem, Some("Editor")),
        KeyBinding::new("shift-f8", PreviousProblem, Some("Editor")),
        // ⌘K last: the later binding is the one menus and keycaps show.
        KeyBinding::new(m!("shift-p"), CommandPalette, None),
        KeyBinding::new(
            m!("k"),
            CommandPalette,
            beside_vim("!(vim_mode == insert || vim_mode == replace || vim_mode == waiting)"),
        ),
        KeyBinding::new(m!("shift-/"), ShowShortcuts, None),
        KeyBinding::new(m!(","), OpenSettings, None),
        KeyBinding::new(m!("w"), CloseTab, beside_vim("!vim_mode")),
        KeyBinding::new(m!("shift-w"), CloseWindow, None),
        KeyBinding::new(m!("shift-t"), ReopenClosedTab, None),
        KeyBinding::new(m!("shift-]"), NextTab, None),
        KeyBinding::new(m!("shift-["), PreviousTab, None),
        KeyBinding::new(m!("shift-enter"), ToggleMaximize, None),
        KeyBinding::new("f6", NextPanel, None),
        KeyBinding::new("shift-f6", PreviousPanel, None),
        KeyBinding::new(m!("alt-left"), NavigateBack, None),
        KeyBinding::new(m!("alt-right"), NavigateForward, None),
        KeyBinding::new(m!("alt-w"), CloseView, None),
        KeyBinding::new(m!("shift-d"), ToggleFocusMode, None),
        // ⌘= is ⌘+ without Shift; ⌘+ comes last, so it is the one shown.
        KeyBinding::new(m!("="), LargerInterface, None),
        KeyBinding::new(m!("+"), LargerInterface, None),
        KeyBinding::new(m!("-"), SmallerInterface, None),
        KeyBinding::new(m!("0"), ResetInterfaceSize, None),
        KeyBinding::new(m!("alt-1"), ToggleProjectPanel, None),
        KeyBinding::new(m!("alt-2"), TogglePapersPanel, None),
        KeyBinding::new(m!("alt-3"), ToggleAgentPanel, None),
        KeyBinding::new(m!("1"), SwitchWorkspace1, None),
        KeyBinding::new(m!("2"), SwitchWorkspace2, None),
        KeyBinding::new(m!("3"), SwitchWorkspace3, None),
        KeyBinding::new(m!("4"), SwitchWorkspace4, None),
        KeyBinding::new(m!("5"), SwitchWorkspace5, None),
        KeyBinding::new(m!("6"), SwitchWorkspace6, None),
        KeyBinding::new(m!("7"), SwitchWorkspace7, None),
        KeyBinding::new(m!("8"), SwitchWorkspace8, None),
        KeyBinding::new(m!("9"), SwitchWorkspace9, None),
        // Projects in this window go round on ⌃Tab, as the Tauri app's do.
        KeyBinding::new("ctrl-tab", NextProject, None),
        KeyBinding::new("ctrl-shift-tab", PreviousProject, None),
    ];
    bindings.extend(crate::editor_panel::find_bar::bindings());
    bindings.extend(crate::editor_panel::proofread::bindings());
    bindings.extend(crate::papers::audit::bindings());
    bindings.extend(submission::bindings());
    #[cfg(target_os = "macos")]
    bindings.extend([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-h", Hide, None),
        KeyBinding::new("cmd-alt-h", HideOthers, None),
        KeyBinding::new("cmd-m", Minimize, None),
    ]);
    bindings
}

#[cfg(test)]
mod tests {
    use gpui::{KeyContext, Keymap, Keystroke};

    use super::*;

    /// What `keys` runs in a focused full-mode editor inside the window, with
    /// Zed's default keymap loaded before Lattice's, as the app loads them.
    fn resolve_in_editor(zed: KeyBinding, keys: &'static str) -> Option<&'static str> {
        let mut bindings = vec![zed];
        bindings.extend(default_bindings());
        resolve(bindings, "Editor mode = full", keys)
    }

    /// What `keys` runs with `bindings` loaded in order, in a focused editor
    /// whose own context is `editor`.
    fn resolve(
        bindings: Vec<KeyBinding>,
        editor: &str,
        keys: &'static str,
    ) -> Option<&'static str> {
        let keymap = Keymap::new(bindings);
        let stack = ["LatticeShell", "LatticeEditor", editor]
            .map(|context| KeyContext::parse(context).unwrap());
        let (matched, _) = keymap.bindings_for_input(&[Keystroke::parse(keys).unwrap()], &stack);
        matched.first().map(|binding| binding.action().name())
    }

    /// vim.json, "vim_mode == insert": ctrl-w deletes the previous word.
    fn vim_insert_ctrl_w() -> KeyBinding {
        KeyBinding::new(
            "ctrl-w",
            editor::actions::DeleteToPreviousWordStart::default(),
            Some("vim_mode == insert"),
        )
    }

    #[test]
    fn vim_keeps_ctrl_w_in_its_editor_however_vim_was_turned_on() {
        let deletes = Some(editor::actions::DeleteToPreviousWordStart::default().name());
        let insert = "Editor mode = full vim_mode = insert";
        // At startup Vim's keymap loads before Lattice's; turned on later,
        // after it, and Lattice's binds again.
        let mut startup = vec![vim_insert_ctrl_w()];
        startup.extend(default_bindings());
        let mut turned_on = default_bindings();
        turned_on.push(vim_insert_ctrl_w());
        turned_on.extend(default_bindings());
        assert_eq!(resolve(startup, insert, "ctrl-w"), deletes);
        assert_eq!(resolve(turned_on, insert, "ctrl-w"), deletes);
    }

    #[test]
    fn save_keeps_its_key_in_vims_normal_mode() {
        // vim.json binds ctrl-s only in insert mode (and its literal and
        // helix modes): normal mode leaves it to the shell.
        let mut bindings = vec![KeyBinding::new(
            "ctrl-s",
            editor::actions::ShowSignatureHelp,
            Some("vim_mode == insert"),
        )];
        bindings.extend(default_bindings());
        let normal = "Editor mode = full vim_mode = normal VimControl";
        assert_eq!(resolve(bindings, normal, m!("s")), Some(Save.name()));
    }

    #[test]
    fn close_tab_survives_vims_null_ctrl_w_outside_an_editor() {
        // vim.json unbinds ctrl-w wherever no editor or terminal has focus.
        // Turned on at runtime, it loads after Lattice's keymap, which then
        // binds again.
        let mut bindings = default_bindings();
        bindings.push(KeyBinding::new(
            "ctrl-w",
            gpui::NoAction,
            Some("VimControl && !menu || !Editor && !Terminal"),
        ));
        bindings.extend(default_bindings());
        let keymap = Keymap::new(bindings);
        let stack = [KeyContext::parse("LatticeShell").unwrap()];
        let (matched, _) = keymap.bindings_for_input(&[Keystroke::parse(m!("w")).unwrap()], &stack);
        assert_eq!(
            matched.first().map(|binding| binding.action().name()),
            Some(CloseTab.name())
        );
    }

    #[test]
    fn close_tab_keeps_its_key_outside_a_vim_editor() {
        let mut bindings = default_bindings();
        bindings.push(vim_insert_ctrl_w());
        assert_eq!(
            resolve(bindings, "Editor mode = full", m!("w")),
            Some(CloseTab.name())
        );
    }

    #[test]
    fn ctrl_l_selects_the_line_but_recenters_under_emacs() {
        // emacs.json binds ctrl-l to recenter-top-bottom in an editor, as the
        // Tauri app's Emacs keymap does; the app loads it under its Emacs
        // context, then Lattice's keymap again.
        let mut bindings = default_bindings();
        bindings.push(KeyBinding::new(
            "ctrl-l",
            editor::actions::ScrollCursorCenterTopBottom,
            Some(&format!("{} > Editor", crate::app::EMACS_CONTEXT)),
        ));
        bindings.extend(default_bindings());
        let keymap = Keymap::new(bindings);
        let run = |shell: &str| {
            let stack = [shell, "LatticeEditor", "Editor mode = full"]
                .map(|context| KeyContext::parse(context).unwrap());
            let (matched, _) =
                keymap.bindings_for_input(&[Keystroke::parse("ctrl-l").unwrap()], &stack);
            matched.first().map(|binding| binding.action().name())
        };
        let emacs = format!("LatticeShell {}", crate::app::EMACS_CONTEXT);
        assert_eq!(
            run(&emacs),
            Some(editor::actions::ScrollCursorCenterTopBottom.name())
        );
        if cfg!(target_os = "macos") {
            assert_eq!(
                run("LatticeShell"),
                Some(editor::actions::SelectLine.name())
            );
        }
    }

    #[test]
    fn each_workspace_key_switches_to_the_workspace_at_that_place() {
        // The README: ⌘1 … ⌘9 (Ctrl off macOS) is the workspace at that place.
        let keymap = Keymap::new(default_bindings());
        let stack = [KeyContext::parse("LatticeShell").unwrap()];
        let keys = [
            m!("1"),
            m!("2"),
            m!("3"),
            m!("4"),
            m!("5"),
            m!("6"),
            m!("7"),
            m!("8"),
            m!("9"),
        ];
        for (index, keys) in keys.into_iter().enumerate() {
            let (matched, _) =
                keymap.bindings_for_input(&[Keystroke::parse(keys).unwrap()], &stack);
            let bound = matched.first().map(|binding| binding.action());
            let palette = switch_workspace_action(index).unwrap();
            assert!(
                bound.is_some_and(|bound| bound.partial_eq(palette.as_ref())),
                "{keys} should switch to workspace {}",
                index + 1
            );
        }
        assert!(switch_workspace_action(9).is_none());
    }

    #[test]
    fn typing_rules_take_dollar_and_enter_only_outside_vims_other_modes() {
        // Zed's Vim (vim.rs, `extend_key_context`): `f`, `t` and `r` wait
        // for their character in `vim_mode = waiting`, Ctrl-V in `literal`,
        // `R` types over in `replace`, none of them with `VimControl`.
        let dollar = Some(crate::editor_panel::latex_input::TypeDollar.name());
        let newline = Some(crate::editor_panel::latex_input::LatexNewline.name());
        for editor in ["Editor mode = full", "Editor mode = full vim_mode = insert"] {
            assert_eq!(resolve(default_bindings(), editor, "$"), dollar, "{editor}");
            assert_eq!(
                resolve(default_bindings(), editor, "enter"),
                newline,
                "{editor}"
            );
        }
        for mode in [
            "normal VimControl",
            "visual VimControl",
            "operator VimControl",
            "waiting",
            "literal",
            "replace",
        ] {
            let editor = format!("Editor mode = full vim_mode = {mode}");
            for keys in ["$", "enter"] {
                assert_eq!(
                    resolve(default_bindings(), &editor, keys),
                    None,
                    "{keys} in {mode}"
                );
            }
        }
        let menu = "Editor mode = full vim_mode = insert menu";
        assert_eq!(resolve(default_bindings(), menu, "enter"), None);
    }

    #[test]
    fn only_macos_binds_a_quit_key() {
        let quit = resolve(default_bindings(), "Editor mode = full", m!("q"));
        assert_eq!(quit == Some(Quit.name()), cfg!(target_os = "macos"));
    }

    #[test]
    fn maximize_wins_over_zeds_newline_above_in_an_editor() {
        // default-macos.json: "Editor && mode == full": cmd-shift-enter.
        let zed = KeyBinding::new(
            m!("shift-enter"),
            editor::actions::NewlineAbove,
            Some("Editor && mode == full"),
        );
        assert_eq!(
            resolve_in_editor(zed, m!("shift-enter")),
            Some(ToggleMaximize.name())
        );
    }

    #[test]
    fn back_and_forward_win_over_zeds_indent_in_an_editor() {
        let outdent = KeyBinding::new(m!("["), editor::actions::Outdent, Some("Editor"));
        assert_eq!(resolve_in_editor(outdent, m!("[")), Some(GoBack.name()));
        let indent = KeyBinding::new(m!("]"), editor::actions::Indent, Some("Editor"));
        assert_eq!(resolve_in_editor(indent, m!("]")), Some(GoForward.name()));
    }

    #[test]
    fn vim_keeps_ctrl_brackets_in_its_editor() {
        // vim.json, "vim_mode == insert": ctrl-[ is Escape; "VimControl &&
        // !menu": ctrl-] goes to the definition.
        let bindings = || {
            let mut bindings = vec![
                KeyBinding::new(
                    "ctrl-[",
                    editor::actions::Cancel,
                    Some("vim_mode == insert"),
                ),
                KeyBinding::new(
                    "ctrl-]",
                    editor::actions::GoToDefinition::default(),
                    Some("VimControl && !menu"),
                ),
            ];
            bindings.extend(default_bindings());
            bindings
        };
        let insert = "Editor mode = full vim_mode = insert";
        let normal = "Editor mode = full vim_mode = normal VimControl";
        assert_eq!(
            resolve(bindings(), insert, "ctrl-["),
            Some(editor::actions::Cancel.name())
        );
        assert_eq!(
            resolve(bindings(), normal, "ctrl-]"),
            Some(editor::actions::GoToDefinition::default().name())
        );
        assert_eq!(
            resolve(bindings(), "Editor mode = full", m!("[")),
            Some(GoBack.name())
        );
    }

    #[test]
    fn build_has_no_key_of_its_own_and_b_and_i_format_in_the_editor() {
        // ⌘S saves and builds; ⌘B and ⌘I are the LaTeX source's Bold and
        // Emphasis, over Zed's signature help on ⌘I.
        let keymap = Keymap::new(default_bindings());
        assert!(keymap.bindings_for_action(&Build).next().is_none());
        assert_eq!(
            resolve(default_bindings(), "Editor mode = full", m!("b")),
            Some(crate::editor_panel::latex_format::ToggleBold.name())
        );
        let zed = KeyBinding::new(m!("i"), editor::actions::ShowSignatureHelp, Some("Editor"));
        assert_eq!(
            resolve_in_editor(zed, m!("i")),
            Some(crate::editor_panel::latex_format::ToggleEmphasis.name())
        );
        // Outside an editor ⌘B runs nothing.
        let keymap = Keymap::new(default_bindings());
        let stack = [KeyContext::parse("LatticeShell").unwrap()];
        let (matched, _) = keymap.bindings_for_input(&[Keystroke::parse(m!("b")).unwrap()], &stack);
        assert!(matched.is_empty());
    }

    #[test]
    fn cite_and_ref_keys_win_over_zeds_delete_line_and_select_all_matches() {
        // default-macos.json, "Editor": cmd-shift-k deletes the line and
        // cmd-shift-l selects every match.
        let delete = KeyBinding::new(m!("shift-k"), editor::actions::DeleteLine, Some("Editor"));
        assert_eq!(
            resolve_in_editor(delete, m!("shift-k")),
            Some(crate::shell::InsertCitation.name())
        );
        let select = KeyBinding::new(
            m!("shift-l"),
            editor::actions::SelectAllMatches,
            Some("Editor"),
        );
        assert_eq!(
            resolve_in_editor(select, m!("shift-l")),
            Some(crate::shell::InsertReference.name())
        );
        let keymap = Keymap::new(default_bindings());
        let stack = [KeyContext::parse("LatticeShell").unwrap()];
        let (matched, _) =
            keymap.bindings_for_input(&[Keystroke::parse(m!("shift-o")).unwrap()], &stack);
        assert_eq!(
            matched.first().map(|binding| binding.action().name()),
            Some(crate::shell::GoToSymbol.name())
        );
    }

    #[test]
    fn tab_switching_wins_over_zeds_folding_in_an_editor() {
        // default-windows.json: "Editor": ctrl-shift-] unfolds, ctrl-shift-[ folds.
        let unfold = KeyBinding::new(m!("shift-]"), editor::actions::UnfoldLines, Some("Editor"));
        assert_eq!(
            resolve_in_editor(unfold, m!("shift-]")),
            Some(NextTab.name())
        );
        let fold = KeyBinding::new(m!("shift-["), editor::actions::Fold, Some("Editor"));
        assert_eq!(
            resolve_in_editor(fold, m!("shift-[")),
            Some(PreviousTab.name())
        );
    }
}
