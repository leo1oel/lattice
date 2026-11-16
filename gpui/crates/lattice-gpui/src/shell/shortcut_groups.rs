//! What the shortcut sheet lists (`src/app/shortcut-groups.ts`), built
//! from the keymap itself when the sheet opens: the command table's keyed
//! commands under their palette sections, the workspace's own keys (Panels
//! and tabs), the source editor's keys (Text editing and LaTeX) and the
//! visual Markdown editor's (Visual Markdown). A key that moves in the keymap
//! moves here, so the sheet cannot list a key that does something else.
//!
//! Each workspace or editor row names the actions it stands for; the sheet
//! shows the key that runs each one where it works (a document's editor for
//! the editor's rows), found in the keymap and checked against what that key
//! resolves to there, so a key another binding took is never listed. A row
//! whose action has no such key is left out, as the Tauri sheet leaves out a
//! command App took the key of. A LaTeX key added to the keymap gets its row
//! by adding it to [`LATEX_ROWS`].
//!
//! The visual Markdown editor is the Tauri app's own engine in its island,
//! which binds its keys itself, so its rows are `engine-shortcuts.ts`'s table
//! as the Tauri sheet lists it. Check references' review queue binds its keys
//! in its sheet's own context (`papers/audit/queue.rs`), where they are
//! looked up.

use gpui::{Action, App, KeyBinding, KeyContext, Keymap, SharedString};
use lattice_i18n::{n, t};

use super::commands::{
    self, CloseView, Command, NavigateBack, NavigateForward, NextPanel, NextTab, PreviousPanel,
    PreviousTab, Section, ToggleMaximize,
};

/// One row: what it does, and each combination's keys; several are
/// alternatives, or a range (⌘1 to ⌘9) when `range`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Row {
    pub label: SharedString,
    pub combos: Vec<SharedString>,
    pub range: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Group {
    pub title: SharedString,
    pub rows: Vec<Row>,
}

/// A table of rows by the actions they stand for: each row's label, and
/// each action's name and the input its binding gives it.
type ActionTable = &'static [(
    &'static str,
    &'static [(&'static str, Option<&'static str>)],
)];

/// A row before merging: its label and its combinations' keys.
type Entry = (SharedString, Vec<SharedString>);

/// The order the sheet lists the command table's sections in.
const SECTION_ORDER: [Section; 8] = [
    Section::Navigate,
    Section::Edit,
    Section::Build,
    Section::View,
    Section::Layout,
    Section::Overleaf,
    Section::Project,
    Section::Appearance,
];

/// Zed's editor actions behind the Text editing rows (`EDITOR_SHORTCUTS`
/// in `editor-keymap.ts`), each with the input its default binding gives it.
const EDITOR_ROWS: ActionTable = &[
    (n!("Undo"), &[("editor::Undo", None)]),
    (n!("Redo"), &[("editor::Redo", None)]),
    (
        n!("Select the next occurrence"),
        &[("editor::SelectNext", Some(r#"{"replace_newest": false}"#))],
    ),
    (n!("Select the line"), &[("editor::SelectLine", None)]),
    (
        n!("Move the line up or down"),
        &[("editor::MoveLineUp", None), ("editor::MoveLineDown", None)],
    ),
    (
        n!("Duplicate the line"),
        &[("editor::DuplicateLineDown", None)],
    ),
    (
        n!("Add a cursor above or below"),
        &[
            (
                "editor::AddSelectionAbove",
                Some(r#"{"skip_soft_wrap": true}"#),
            ),
            (
                "editor::AddSelectionBelow",
                Some(r#"{"skip_soft_wrap": true}"#),
            ),
        ],
    ),
    (n!("Insert a line below"), &[("editor::NewlineBelow", None)]),
    (
        n!("Indent or outdent"),
        &[("editor::Tab", None), ("editor::Backtab", None)],
    ),
    (
        n!("Go to the matching bracket"),
        &[("editor::MoveToEnclosingBracket", None)],
    ),
    (
        n!("Fold or unfold"),
        &[("editor::Fold", None), ("editor::UnfoldLines", None)],
    ),
    (
        n!("Fold or unfold everything"),
        &[("editor::FoldAll", None), ("editor::UnfoldAll", None)],
    ),
    (
        n!("Next or previous match"),
        &[
            ("lattice_find::FindNext", None),
            ("lattice_find::FindPrevious", None),
        ],
    ),
];

/// The LaTeX source's keys this app binds (`LATEX_SHORTCUTS`, in its
/// order), by the actions they run in a `.tex` file's editor.
pub(super) const LATEX_ROWS: ActionTable = &[
    (n!("Bold (\\textbf)"), &[("lattice::ToggleBold", None)]),
    (
        n!("Emphasis (\\emph)"),
        &[("lattice::ToggleEmphasis", None)],
    ),
    (n!("Inline math"), &[("lattice::ToggleInlineMath", None)]),
    (
        n!("Comment or uncomment lines"),
        &[("lattice::ToggleLineComments", None)],
    ),
    (
        n!("Wrap in a comment environment"),
        &[("lattice::WrapCommentEnvironment", None)],
    ),
    (
        n!("Wrap in \\iffalse … \\fi"),
        &[("lattice::WrapIfFalse", None)],
    ),
    (n!("Wrap in equation"), &[("lattice::WrapEquation", None)]),
    (n!("Wrap in itemize"), &[("lattice::WrapItemize", None)]),
    (
        n!("Wrap in environment…"),
        &[("lattice::WrapInEnvironment", None)],
    ),
    (
        n!("Rename the environment"),
        &[("lattice::RenameEnvironment", None)],
    ),
    (
        n!("Select the environment"),
        &[("lattice::SelectEnvironment", None)],
    ),
    (
        n!("Go to the matching \\begin or \\end"),
        &[("lattice::MatchingEnvironment", None)],
    ),
    (n!("Sort lines"), &[("lattice::SortLines", None)]),
    (n!("UPPER CASE"), &[("lattice::UpperCase", None)]),
    (n!("lower case"), &[("lattice::LowerCase", None)]),
    (n!("Title Case"), &[("lattice::TitleCase", None)]),
    (n!("Find in document"), &[("buffer_search::Deploy", None)]),
    (n!("Go to definition"), &[("lattice::GotoDefinition", None)]),
    (
        n!("Find references"),
        &[("editor::FindAllReferences", None)],
    ),
    (n!("Rename label or citation"), &[("editor::Rename", None)]),
    (
        n!("Insert a math symbol…"),
        &[("lattice::InsertMathSymbol", None)],
    ),
];

/// Check references' review queue (`REFERENCE_CHECK_SHORTCUTS`, in its
/// order): Apply has two keys, one row.
const REFERENCE_ROWS: ActionTable = &[
    (
        n!("Next reference"),
        &[("check_references::NextReference", None)],
    ),
    (
        n!("Previous reference"),
        &[("check_references::PreviousReference", None)],
    ),
    (n!("Apply the fix"), &[("check_references::ApplyFix", None)]),
    (
        n!("Apply the fix"),
        &[("check_references::ApplyFixChord", None)],
    ),
    (
        n!("Skip to the next finding"),
        &[("check_references::SkipFinding", None)],
    ),
];

/// `ENGINE_SHORTCUTS` (`engine-shortcuts.ts`): the visual Markdown editor's
/// keys, as its engine binds them.
const MARKDOWN_ROWS: &[(&str, &[&str])] = &[
    (n!("Bold"), &["Mod-b"]),
    (n!("Italic"), &["Mod-i"]),
    (n!("Underline"), &["Mod-u"]),
    (n!("Strikethrough"), &["Mod-Shift-s"]),
    (n!("Inline code"), &["Mod-e"]),
    (n!("Add or edit a link"), &["Mod-k"]),
    (n!("Body text"), &["Mod-Alt-0"]),
    (
        n!("Heading 1 to 6"),
        &[
            "Mod-Alt-1",
            "Mod-Alt-2",
            "Mod-Alt-3",
            "Mod-Alt-4",
            "Mod-Alt-5",
            "Mod-Alt-6",
        ],
    ),
    (n!("Bulleted list"), &["Mod-Shift-8"]),
    (n!("Numbered list"), &["Mod-Shift-7"]),
    (n!("Task list"), &["Mod-Shift-9"]),
    (n!("Quote"), &["Mod-Shift-b"]),
    (n!("Code block"), &["Mod-Alt-c"]),
    (n!("Leave a code block"), &["Mod-Enter"]),
    (
        n!("Move the block up or down"),
        &["Mod-Shift-ArrowUp", "Mod-Shift-ArrowDown"],
    ),
    (n!("Find in document"), &["Mod-f"]),
    (n!("Find and replace"), &["Mod-Alt-f"]),
];

/// The workspace's own keys (`TRELLIS_SHORTCUTS`), a row per pair.
fn panel_rows() -> Vec<(SharedString, Vec<Box<dyn Action>>)> {
    vec![
        (
            t!("Previous or next tab").into(),
            vec![Box::new(PreviousTab), Box::new(NextTab)],
        ),
        (t!("Close the tab").into(), vec![Box::new(CloseView)]),
        (
            t!("Previous or next panel").into(),
            vec![Box::new(PreviousPanel), Box::new(NextPanel)],
        ),
        (
            t!("Maximize or restore the focused panel").into(),
            vec![Box::new(ToggleMaximize)],
        ),
        (
            t!("Previous or next zoomed view").into(),
            vec![Box::new(NavigateBack), Box::new(NavigateForward)],
        ),
    ]
}

/// Where a key is looked up: the window's own context, the stack a `.tex`
/// file's editor sits in (the panel's, then Zed's editor's), and Check
/// references' sheet.
struct Places {
    window: Vec<KeyContext>,
    editor: Vec<KeyContext>,
    references: Vec<KeyContext>,
}

impl Places {
    fn new(cx: &App) -> Self {
        let mut root = KeyContext::new_with_defaults(cx.platform_info().os);
        root.add("LatticeShell");
        let mut editor = KeyContext::default();
        editor.add("Editor");
        editor.set("mode", "full");
        editor.set("extension", "tex");
        Self {
            window: vec![root.clone()],
            references: vec![
                root.clone(),
                KeyContext::parse(crate::papers::audit::KEY_CONTEXT).unwrap_or_default(),
            ],
            editor: vec![
                root,
                KeyContext::parse("LatticeEditor").unwrap_or_default(),
                editor,
            ],
        }
    }
}

/// The keys of every binding that runs `action` in `stack`, the one the
/// keymap prefers first: a binding whose keys run something else there (a
/// later binding, or a deeper context's) is not one.
fn keys_in(keymap: &Keymap, action: &dyn Action, stack: &[KeyContext]) -> Vec<SharedString> {
    let mut out: Vec<SharedString> = Vec::new();
    for binding in keymap.bindings_for_action(action).rev() {
        if !runs(keymap, binding, stack) {
            continue;
        }
        let keys: SharedString = commands::keystrokes_label(binding.keystrokes()).into();
        if !out.contains(&keys) {
            out.push(keys);
        }
    }
    out
}

/// Whether `binding`'s keys run its action in `stack`.
fn runs(keymap: &Keymap, binding: &KeyBinding, stack: &[KeyContext]) -> bool {
    let (resolved, _) = keymap.bindings_for_input(binding.keystrokes(), stack);
    resolved
        .first()
        .is_some_and(|first| first.action().partial_eq(binding.action()))
}

/// A row of `actions`, each by the key the keymap prefers for it in `stack`,
/// or none when one of them has no key there.
fn action_row(
    label: SharedString,
    actions: &[Box<dyn Action>],
    keymap: &Keymap,
    stack: &[KeyContext],
) -> Option<Entry> {
    let combos: Vec<SharedString> = actions
        .iter()
        .filter_map(|action| keys_in(keymap, action.as_ref(), stack).into_iter().next())
        .collect();
    (combos.len() == actions.len()).then_some((label, combos))
}

/// The actions a table row names, built as its bindings give them; none
/// when the app does not have one of them.
fn named_actions(names: &[(&str, Option<&str>)], cx: &App) -> Option<Vec<Box<dyn Action>>> {
    names
        .iter()
        .map(|(name, input)| {
            let input = input.and_then(|input| serde_json::from_str(input).ok());
            cx.build_action(name, input).ok()
        })
        .collect()
}

fn table_rows(table: ActionTable, keymap: &Keymap, stack: &[KeyContext], cx: &App) -> Vec<Entry> {
    table
        .iter()
        .filter_map(|(label, names)| {
            let actions = named_actions(names, cx)?;
            action_row(lattice_i18n::tr(label).into(), &actions, keymap, stack)
        })
        .collect()
}

/// Rows of one group, one per label: commands sharing a label (⌘1 to ⌘9)
/// share a row, a range when it stands for more than two.
fn merged_rows(entries: Vec<Entry>) -> Vec<Row> {
    let mut rows: Vec<Row> = Vec::new();
    for (label, combos) in entries {
        match rows.iter_mut().find(|row| row.label == label) {
            Some(row) => {
                for keys in combos {
                    if !row.combos.contains(&keys) {
                        row.combos.push(keys);
                    }
                }
            }
            None => rows.push(Row {
                label,
                combos,
                range: false,
            }),
        }
    }
    for row in &mut rows {
        row.range = row.combos.len() > 2;
    }
    rows
}

/// Every group the sheet lists, for the window's `commands`.
pub(super) fn shortcut_groups(commands: &[Command], cx: &App) -> Vec<Group> {
    let keymap = cx.key_bindings();
    let keymap = keymap.borrow();
    let places = Places::new(cx);
    let panels = panel_rows();
    let is_panel_key = |command: &Command| {
        panels.iter().any(|(_, actions)| {
            actions
                .iter()
                .any(|action| action.partial_eq(command.keys_action()))
        })
    };

    let mut app: Vec<(Section, Vec<Entry>)> = Vec::new();
    // A command listed by the keys of another (Build by Save's ⌘S, a
    // workspace by name with its ⌘N) has no key of its own: the sheet lists
    // the other, as `commandCombo` reads only a command's own `key`.
    for command in commands
        .iter()
        .filter(|command| !is_panel_key(command) && command.keys_of.is_none())
    {
        let combos = keys_in(&keymap, command.action.as_ref(), &places.window);
        if combos.is_empty() {
            continue;
        }
        let at = match app
            .iter()
            .position(|(section, _)| *section == command.section)
        {
            Some(at) => at,
            None => {
                app.push((command.section, Vec::new()));
                app.len() - 1
            }
        };
        app[at].1.push((command.label.clone(), combos));
        // Escape leaves focus mode too, when nothing else takes it
        // (`focus_escape.rs`).
        if command.id == "focus-mode" {
            app[at]
                .1
                .push((t!("Leave focus mode").into(), vec!["⎋".into()]));
        }
    }
    app.sort_by_key(|(section, _)| SECTION_ORDER.iter().position(|order| order == section));
    let mut groups: Vec<Group> = app
        .into_iter()
        .map(|(section, entries)| Group {
            title: section.label().into(),
            rows: merged_rows(entries),
        })
        .collect();

    let panel_entries = panels
        .into_iter()
        .filter_map(|(label, actions)| action_row(label, &actions, &keymap, &places.window))
        .collect();
    let markdown_entries = MARKDOWN_ROWS
        .iter()
        .map(|(label, names)| {
            let combos = names
                .iter()
                .filter_map(|name| commands::tauri_keystroke(name))
                .map(|keystroke| commands::keystrokes_label(&[keystroke]).into())
                .collect();
            (lattice_i18n::tr(label).into(), combos)
        })
        .collect();
    for (title, entries) in [
        (t!("Panels and tabs"), panel_entries),
        (
            t!("Text editing"),
            table_rows(EDITOR_ROWS, &keymap, &places.editor, cx),
        ),
        (
            t!("LaTeX"),
            table_rows(LATEX_ROWS, &keymap, &places.editor, cx),
        ),
        (t!("Visual Markdown"), markdown_entries),
        (
            t!("Check references"),
            table_rows(REFERENCE_ROWS, &keymap, &places.references, cx),
        ),
    ] {
        let rows = merged_rows(entries);
        if !rows.is_empty() {
            groups.push(Group {
                title: title.into(),
                rows,
            });
        }
    }
    groups
}

/// The groups with only the rows `query` finds, by name or by key (⌘⇧J, or
/// "j"); a group whose title matches keeps every row.
pub(super) fn filter_groups(groups: &[Group], query: &str) -> Vec<Group> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return groups.to_vec();
    }
    let matches = |text: &str| text.to_lowercase().contains(&needle);
    groups
        .iter()
        .filter_map(|group| {
            if matches(&group.title) {
                return Some(group.clone());
            }
            let rows: Vec<Row> = group
                .rows
                .iter()
                .filter(|row| {
                    matches(&row.label)
                        || row
                            .combos
                            .iter()
                            .any(|keys| matches(&keys.replace(' ', "")))
                })
                .cloned()
                .collect();
            (!rows.is_empty()).then(|| Group {
                title: group.title.clone(),
                rows,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use gpui::{KeyBinding, Keymap};

    use super::*;

    fn row(label: &str, combos: &[&str]) -> (SharedString, Vec<SharedString>) {
        (
            label.to_string().into(),
            combos.iter().map(|keys| keys.to_string().into()).collect(),
        )
    }

    #[test]
    fn commands_sharing_a_label_share_a_row_a_range_past_two() {
        // shortcut-groups.ts's mergedRows: ⌘1 … ⌘9 is one ranged row, the
        // palette's ⌘K and ⇧⌘P one row of two alternatives.
        let mut entries: Vec<_> = (1..=9)
            .map(|n| row("Switch to a workspace by its place", &[&format!("⌘{n}")]))
            .collect();
        entries.push(row("Command palette", &["⌘K"]));
        entries.push(row("Command palette", &["⇧⌘P"]));
        let rows = merged_rows(entries);
        assert_eq!(rows.len(), 2);
        assert!(rows[0].range && rows[0].combos.len() == 9);
        assert_eq!(rows[1].combos, vec!["⌘K", "⇧⌘P"]);
        assert!(!rows[1].range);
    }

    #[test]
    fn the_filter_finds_rows_by_name_or_key_and_keeps_a_matching_groups_rows() {
        let groups = vec![
            Group {
                title: "Build".into(),
                rows: merged_rows(vec![row("Forward search", &["⇧⌘J"]), row("Save", &["⌘S"])]),
            },
            Group {
                title: "Text editing".into(),
                rows: merged_rows(vec![
                    row("Undo", &["⌘Z"]),
                    row("Fold or unfold everything", &["⌘K ⌘0"]),
                ]),
            },
        ];
        let by_key = filter_groups(&groups, "⇧⌘j");
        assert_eq!(by_key.len(), 1);
        assert_eq!(by_key[0].rows[0].label, "Forward search");
        // A chord matches typed without its space.
        assert_eq!(filter_groups(&groups, "⌘K⌘0")[0].rows.len(), 1);
        assert_eq!(filter_groups(&groups, "text")[0].rows.len(), 2);
        assert_eq!(filter_groups(&groups, "  ").len(), 2);
        assert!(filter_groups(&groups, "nothing like it").is_empty());
    }

    gpui::actions!(shortcut_groups_test, [Taken, Kept, Other]);

    #[test]
    fn a_key_another_binding_took_is_not_listed() {
        // The editor's binding for ⌘[ is shadowed where the window's later
        // binding of the same keys runs something else (GoBack over Zed's
        // Outdent in the Tauri app's keymap).
        let keymap = Keymap::new(vec![
            KeyBinding::new("cmd-[", Taken, Some("Editor")),
            KeyBinding::new("cmd-[", Other, Some("Editor")),
            KeyBinding::new("cmd-]", Kept, Some("Editor")),
            KeyBinding::new("cmd-alt-]", Kept, Some("Editor")),
        ]);
        let stack = vec![KeyContext::parse("Editor").unwrap()];
        assert!(keys_in(&keymap, &Taken, &stack).is_empty());
        let kept = keys_in(&keymap, &Kept, &stack);
        assert_eq!(kept.len(), 2);
        // Outside the editor neither runs.
        assert!(keys_in(&keymap, &Kept, &[KeyContext::parse("Other").unwrap()]).is_empty());
        assert!(
            action_row(
                "Both".into(),
                &[Box::new(Kept), Box::new(Taken)],
                &keymap,
                &stack
            )
            .is_none()
        );
    }
}
