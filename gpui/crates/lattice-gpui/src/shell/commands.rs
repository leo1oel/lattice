//! The one command table (`src/app/use-command-table.ts`): every app-level
//! action as the palette lists it, as the keymap reaches it and as the menu
//! bar and the shortcut sheet show it.
//!
//! Each command is a GPUI action the shell handles; the table adds its label,
//! its palette section, when it applies and its default keys. The keys are
//! the Tauri app's, on ⌘ (Ctrl off macOS): the workspaces on ⌘1 to ⌘9,
//! Project, Papers and the Agent on ⌘⌥1 to ⌘⌥3, focus mode on ⌘⇧D, maximize
//! or restore on ⌘⇧↩, the palette on ⌘K (and ⌘⇧P).

use gpui::{Action, App, KeyBinding, SharedString, actions};
use lattice_i18n::{space_mixed_script, t};

use super::trellis_layout::Preset;

mod appearance;
mod key_labels;
mod projects;
mod section;
mod submission;

pub use key_labels::keys_label;
pub use section::Section;

actions!(
    lattice,
    [
        OpenFolder,
        OpenFolderHere,
        NewProject,
        CloneRepository,
        ImportZip,
        QuickOpen,
        GoBack,
        GoForward,
        FindInProject,
        ReplaceInProject,
        Build,
        Save,
        ForwardSync,
        ToggleVimMode,
        ToggleProjectPanel,
        TogglePapersPanel,
        ToggleAgentPanel,
        TogglePdfPanel,
        ToggleBuildPanel,
        StopBuild,
        CleanRebuild,
        CleanBuildFiles,
        NextProblem,
        PreviousProblem,
        OpenTexDoctor,
        InstallLatexTools,
        OpenSettings,
        CommandPalette,
        ShowShortcuts,
        NewWindow,
        OpenInNewWindow,
        CloseWindow,
        CloseTab,
        ReopenClosedTab,
        NextTab,
        PreviousTab,
        NextPanel,
        PreviousPanel,
        NavigateBack,
        NavigateForward,
        CloseView,
        ToggleMaximize,
        ToggleFocusMode,
        ResetLayout,
        NewWorkspace,
        SaveWorkspace,
        RevertWorkspace,
        WritingPreset,
        ReadingPreset,
        ReturnToWorkspace,
        SwitchWorkspace1,
        SwitchWorkspace2,
        SwitchWorkspace3,
        SwitchWorkspace4,
        SwitchWorkspace5,
        SwitchWorkspace6,
        SwitchWorkspace7,
        SwitchWorkspace8,
        SwitchWorkspace9,
        ThemeLight,
        ThemeDark,
        ThemeSystem,
        LargerInterface,
        SmallerInterface,
        ResetInterfaceSize,
        NextProject,
        PreviousProject,
        CloseProject,
        Quit,
        Hide,
        HideOthers,
        ShowAll,
        Minimize,
        Zoom,
        About,
    ]
);

/// Open a recent project: in a window of its own once this one shows a
/// project, unless `here`.
#[derive(Clone, Debug, PartialEq, Eq, gpui::Action)]
#[action(namespace = lattice, no_json)]
pub struct OpenRecentProject {
    pub path: std::path::PathBuf,
    pub here: bool,
}

/// Switch to the workspace with this id: the palette lists one per
/// workspace, however many there are.
#[derive(Clone, Debug, PartialEq, Eq, gpui::Action)]
#[action(namespace = lattice, no_json)]
pub struct SwitchWorkspace {
    pub id: String,
}

#[cfg(target_os = "macos")]
pub const MOD_LABEL: &str = "⌘";
#[cfg(not(target_os = "macos"))]
pub const MOD_LABEL: &str = "Ctrl+";

/// What the table needs to know about the window to say which commands apply
/// and how they read.
#[derive(Clone, Debug, Default)]
pub struct CommandContext {
    pub in_project: bool,
    pub maximized: bool,
    pub focus_mode: bool,
    pub dirty: bool,
    /// A build is under way or queued.
    pub building: bool,
    pub preset: Option<Preset>,
    /// The workspaces' ids and names, in order.
    pub workspaces: Vec<(String, SharedString)>,
    pub projects: usize,
    /// The recent projects other than this window's, newest first: name and
    /// folder.
    pub recent: Vec<(SharedString, std::path::PathBuf)>,
}

/// One row of the table.
pub struct Command {
    /// The Tauri command table's id; the tests, and the recent commands
    /// once the palette keeps them, name a command by it.
    #[cfg_attr(not(test), allow(dead_code))]
    pub id: SharedString,
    pub label: SharedString,
    pub section: Section,
    pub action: Box<dyn Action>,
    /// Whether the palette lists it (⌘W and the like are keys only).
    pub palette: bool,
    pub keywords: &'static str,
}

impl Command {
    fn new(
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        section: Section,
        action: impl Action,
    ) -> Self {
        Command {
            id: id.into(),
            label: label.into(),
            section,
            action: Box::new(action),
            palette: true,
            keywords: "",
        }
    }

    fn keys_only(mut self) -> Self {
        self.palette = false;
        self
    }

    fn keywords(mut self, keywords: &'static str) -> Self {
        self.keywords = keywords;
        self
    }
}

const WORKSPACE_ACTIONS: [fn() -> Box<dyn Action>; 9] = [
    || Box::new(SwitchWorkspace1),
    || Box::new(SwitchWorkspace2),
    || Box::new(SwitchWorkspace3),
    || Box::new(SwitchWorkspace4),
    || Box::new(SwitchWorkspace5),
    || Box::new(SwitchWorkspace6),
    || Box::new(SwitchWorkspace7),
    || Box::new(SwitchWorkspace8),
    || Box::new(SwitchWorkspace9),
];

/// The action that switches to the workspace at `index`, for the first nine.
pub fn switch_workspace_action(index: usize) -> Option<Box<dyn Action>> {
    WORKSPACE_ACTIONS.get(index).map(|action| action())
}

/// The commands that apply now, in the table's order.
pub fn commands(context: &CommandContext) -> Vec<Command> {
    let mut out = Vec::new();
    let project = context.in_project;
    if project {
        out.push(Command::new(
            "build",
            t!("Build project"),
            Section::Build,
            Build,
        ));
        out.push(Command::new("save", t!("Save and build"), Section::Build, Save).keys_only());
        out.push(
            Command::new("rebuild", t!("Clean rebuild"), Section::Build, CleanRebuild)
                .keywords("latexmk"),
        );
        out.push(Command::new(
            "clean",
            t!("Clean aux files"),
            Section::Build,
            CleanBuildFiles,
        ));
        if context.building {
            out.push(Command::new(
                "stop-build",
                t!("Stop build"),
                Section::Build,
                StopBuild,
            ));
        }
        out.push(Command::new(
            "reveal-cursor",
            t!("Reveal cursor in PDF"),
            Section::Build,
            ForwardSync,
        ));
        out.push(Command::new(
            "build-panel",
            t!("Show or hide the build log"),
            Section::Build,
            ToggleBuildPanel,
        ));
    }
    if project {
        out.push(Command::new(
            "quick-open",
            "Quick open file",
            Section::Navigate,
            QuickOpen,
        ));
        out.push(Command::new("back", "Back", Section::Navigate, GoBack).keys_only());
        out.push(Command::new("forward", "Forward", Section::Navigate, GoForward).keys_only());
        out.push(
            Command::new(
                "close-tab",
                t!("Close the document tab, or the window when none is open"),
                Section::Navigate,
                CloseTab,
            )
            .keys_only(),
        );
        out.push(
            Command::new(
                "next-problem",
                t!("Next build problem"),
                Section::Navigate,
                NextProblem,
            )
            .keys_only(),
        );
        out.push(
            Command::new(
                "previous-problem",
                t!("Previous build problem"),
                Section::Navigate,
                PreviousProblem,
            )
            .keys_only(),
        );
        out.push(
            Command::new(
                "reopen-tab",
                t!("Reopen the closed tab"),
                Section::Navigate,
                ReopenClosedTab,
            )
            .keys_only(),
        );
        out.push(Command::new("next-tab", t!("Next tab"), Section::Navigate, NextTab).keys_only());
        out.push(
            Command::new(
                "previous-tab",
                t!("Previous tab"),
                Section::Navigate,
                PreviousTab,
            )
            .keys_only(),
        );
        // The workspace's own keys (`TRELLIS_SHORTCUTS`).
        let nav = Section::Navigate;
        out.push(Command::new("next-panel", "Next panel", nav, NextPanel).keys_only());
        out.push(Command::new("previous-panel", "Previous panel", nav, PreviousPanel).keys_only());
        out.push(
            Command::new("navigate-back", "Previous zoomed view", nav, NavigateBack).keys_only(),
        );
        out.push(
            Command::new("navigate-forward", "Next zoomed view", nav, NavigateForward).keys_only(),
        );
        out.push(Command::new("close-view", "Close the tab", nav, CloseView).keys_only());
    }
    out.push(
        Command::new(
            "palette",
            t!("Command palette"),
            Section::Project,
            CommandPalette,
        )
        .keys_only(),
    );
    out.push(Command::new(
        "shortcuts",
        t!("Keyboard shortcuts"),
        Section::Project,
        ShowShortcuts,
    ));
    if project {
        out.push(Command::new(
            "layout-reset",
            t!("Reset panel layout"),
            Section::Layout,
            ResetLayout,
        ));
        out.push(Command::new(
            "frame",
            if context.maximized {
                t!("Restore the layout")
            } else {
                t!("Maximize focused panel")
            },
            Section::Layout,
            ToggleMaximize,
        ));
        for (id, name) in &context.workspaces {
            out.push(Command::new(
                format!("switch-{id}"),
                space_mixed_script(&t!("Switch to {name}", name = name)),
                Section::Layout,
                SwitchWorkspace { id: id.clone() },
            ));
        }
        for index in 0..context.workspaces.len() {
            if let Some(action) = switch_workspace_action(index) {
                out.push(Command {
                    id: format!("workspace-{}", index + 1).into(),
                    label: t!("Switch to a workspace by its place").into(),
                    section: Section::Layout,
                    action,
                    palette: false,
                    keywords: "",
                });
            }
        }
        out.push(Command::new(
            "focus-mode",
            if context.focus_mode {
                t!("Leave focus mode")
            } else {
                t!("Focus mode")
            },
            Section::Layout,
            ToggleFocusMode,
        ));
        out.push(Command::new(
            "workspace-new",
            t!("New workspace"),
            Section::Layout,
            NewWorkspace,
        ));
        if context.dirty {
            out.push(Command::new(
                "workspace-save",
                t!("Save to workspace"),
                Section::Layout,
                SaveWorkspace,
            ));
            out.push(Command::new(
                "workspace-revert",
                t!("Revert to saved"),
                Section::Layout,
                RevertWorkspace,
            ));
        }
        for preset in Preset::ALL {
            let on = context.preset == Some(preset);
            let (id, action): (&str, Box<dyn Action>) = match (preset, on) {
                (_, true) => ("preset-return", Box::new(ReturnToWorkspace)),
                (Preset::Writing, false) => ("preset-writing", Box::new(WritingPreset)),
                (Preset::Reading, false) => ("preset-reading", Box::new(ReadingPreset)),
            };
            out.push(Command {
                id: id.into(),
                label: match (preset, on) {
                    (Preset::Writing, true) => t!("Leave the Writing layout"),
                    (Preset::Reading, true) => t!("Leave the Reading layout"),
                    (Preset::Writing, false) => t!("Writing layout"),
                    (Preset::Reading, false) => t!("Reading layout"),
                }
                .into(),
                section: Section::Layout,
                action,
                palette: true,
                keywords: "preset",
            });
        }
        for (id, label, action) in [
            (
                "panel-project",
                t!("Show or hide Project"),
                Box::new(ToggleProjectPanel) as Box<dyn Action>,
            ),
            (
                "panel-papers",
                t!("Show or hide Papers"),
                Box::new(TogglePapersPanel),
            ),
            (
                "panel-agent",
                t!("Show or hide the Agent"),
                Box::new(ToggleAgentPanel),
            ),
            (
                "panel-pdf",
                t!("Show or hide the PDF"),
                Box::new(TogglePdfPanel),
            ),
        ] {
            out.push(Command {
                id: id.into(),
                label: label.into(),
                section: Section::Layout,
                action,
                palette: true,
                keywords: "panel",
            });
        }
        out.push(
            Command::new("vim", t!("Vim mode"), Section::Edit, ToggleVimMode).keywords("vi modal"),
        );
        out.push(Command::new(
            "find",
            t!("Find in project"),
            Section::Edit,
            FindInProject,
        ));
        out.push(Command::new(
            "replace",
            t!("Replace in project"),
            Section::Edit,
            ReplaceInProject,
        ));
        submission::edit_commands(&mut out);
    }
    projects::project_commands(context, &mut out);
    appearance::appearance_commands(&mut out);
    out
}

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

/// The default keymap, as the Tauri app's command table and Trellis's keymap
/// bind it, plus the window's own (quit, hide, minimize).
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys(default_bindings());
}

fn default_bindings() -> Vec<KeyBinding> {
    let mut bindings = vec![
        KeyBinding::new(m!("o"), OpenFolder, beside_vim("!(vim_mode == insert)")),
        KeyBinding::new(m!("b"), Build, beside_vim("!VimControl")),
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
    use super::*;

    #[test]
    fn without_a_project_only_project_and_appearance_commands_apply() {
        let commands = commands(&CommandContext::default());
        assert!(
            commands
                .iter()
                .all(|command| matches!(command.section, Section::Project | Section::Appearance))
        );
        assert!(commands.iter().any(|command| command.id == "open-folder"));
    }

    #[test]
    fn save_and_revert_appear_only_while_the_layout_differs() {
        let mut context = CommandContext {
            in_project: true,
            ..CommandContext::default()
        };
        let has = |context: &CommandContext, id: &str| {
            commands(context).iter().any(|command| command.id == id)
        };
        assert!(!has(&context, "workspace-save"));
        context.dirty = true;
        assert!(has(&context, "workspace-save") && has(&context, "workspace-revert"));
    }

    #[test]
    fn a_preset_on_screen_offers_the_way_back() {
        let context = CommandContext {
            in_project: true,
            preset: Some(Preset::Writing),
            ..CommandContext::default()
        };
        let labels: Vec<_> = commands(&context)
            .into_iter()
            .map(|command| command.label.to_string())
            .collect();
        assert!(labels.contains(&"Leave the Writing layout".to_string()));
        assert!(labels.contains(&"Reading layout".to_string()));
    }

    #[test]
    fn a_tenth_workspace_is_reachable_from_the_palette() {
        // The Tauri table lists every workspace by name in the palette and
        // keeps ⌘1 to ⌘9 as keys only (use-command-table.ts).
        let context = CommandContext {
            in_project: true,
            workspaces: (1..=11)
                .map(|n| (format!("ws-{n}"), format!("W{n}").into()))
                .collect(),
            ..CommandContext::default()
        };
        let commands = commands(&context);
        let tenth = commands
            .iter()
            .find(|command| command.palette && command.label == "Switch to W10")
            .expect("the palette lists the tenth workspace");
        assert!(
            tenth
                .action
                .partial_eq(&SwitchWorkspace { id: "ws-10".into() })
        );
        let positional: Vec<_> = commands
            .iter()
            .filter(|command| {
                (0..9).any(|index| {
                    command
                        .action
                        .partial_eq(switch_workspace_action(index).unwrap().as_ref())
                })
            })
            .collect();
        assert_eq!(positional.len(), 9);
        assert!(positional.iter().all(|command| !command.palette));
    }

    #[test]
    fn the_build_commands_reach_the_palette_and_the_shortcut_sheet() {
        // use-command-table.ts: Clean rebuild and Clean aux files in a
        // project, Stop build only while a build runs, the next and previous
        // build problem as keys only, and the TeX doctor everywhere.
        let row = |context: &CommandContext, action: &dyn Action| {
            commands(context)
                .into_iter()
                .find(|command| command.action.partial_eq(action))
                .map(|command| command.palette)
        };
        let mut context = CommandContext {
            in_project: true,
            ..CommandContext::default()
        };
        assert_eq!(row(&context, &CleanRebuild), Some(true));
        assert_eq!(row(&context, &CleanBuildFiles), Some(true));
        assert_eq!(row(&context, &NextProblem), Some(false));
        assert_eq!(row(&context, &PreviousProblem), Some(false));
        assert_eq!(row(&context, &OpenTexDoctor), Some(true));
        assert_eq!(row(&context, &StopBuild), None);
        context.building = true;
        assert_eq!(row(&context, &StopBuild), Some(true));
        assert_eq!(row(&CommandContext::default(), &OpenTexDoctor), Some(true));
        // The shortcut sheet lists a section in table order: the Tauri table
        // puts the build problems before Reopen the closed tab, and the tab
        // pair stays together.
        let navigate: Vec<_> = commands(&context)
            .into_iter()
            .filter(|command| command.section == Section::Navigate)
            .map(|command| command.id.to_string())
            .collect();
        let at = |id: &str| navigate.iter().position(|other| other == id).unwrap();
        assert_eq!(at("previous-problem"), at("next-problem") + 1);
        assert!(at("previous-problem") < at("reopen-tab"));
        assert_eq!(at("previous-tab"), at("next-tab") + 1);
    }
}

#[cfg(test)]
mod keymap_tests {
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
