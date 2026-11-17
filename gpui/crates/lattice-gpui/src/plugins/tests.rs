//! The pure parts of plugins: the permissions' words, errors by code,
//! result rows, Markdown blocks, and a bibliography change worked out.

use lattice_core::plugins::{
    Action, ActionKind, CommandResult, Diagnostic, Item, Permissions, PluginError, ProjectRead,
    Severity,
};

use super::{
    actions::{BibChange, diff_lines, plan},
    markdown::{self, Block, Mark},
    results::{self, Row},
    text,
};

#[test]
fn permissions_read_as_plain_sentences_in_the_manifests_order() {
    let permissions = Permissions {
        project_read: vec![ProjectRead::Context, ProjectRead::Bibliography],
        network_local: vec![23119],
        network: vec!["https://api.crossref.org".into()],
        secrets: vec!["api-key".into()],
    };
    assert_eq!(
        text::permission_lines(&permissions),
        [
            "Read the open file, selection and cursor",
            "Read the project’s bibliography",
            "Connect to localhost:23119",
            "Send requests to https://api.crossref.org",
            "Use the saved secret “api-key”",
        ]
    );
    assert_eq!(
        text::permission_lines(&Permissions::default()),
        ["No access beyond the project’s name"]
    );
}

#[test]
fn errors_are_worded_by_code_and_keep_the_plugins_own_message() {
    let own = text::error_text(&PluginError::Plugin {
        message: "Zotero is not running".into(),
    });
    assert_eq!(own.text, "Zotero is not running");
    assert!(own.detail.is_none() && !own.settings);
    let broken = text::error_text(&PluginError::Broken {
        message: "main.js is missing".into(),
    });
    assert_eq!(broken.text, "The plugin is broken: main.js is missing");
    assert!(text::error_text(&PluginError::Disabled).settings);
    assert!(text::error_text(&PluginError::NeedsReview).settings);
    assert!(!text::error_text(&PluginError::Timeout).settings);
    assert_eq!(
        text::error_text(&PluginError::Plugin {
            message: " ".into()
        })
        .text,
        "The plugin failed."
    );
}

#[test]
fn rows_and_labels_read_as_the_tauri_palette_writes_them() {
    assert_eq!(
        text::command_label("Zotero search", "Search Zotero…"),
        "Zotero search: Search Zotero…"
    );
    assert_eq!(
        text::result_header("Bib check", Some("3 problems"), "Check"),
        "Bib check · 3 problems"
    );
    assert_eq!(
        text::result_header("Bib check", Some("  "), "Check"),
        "Bib check · Check"
    );
    assert_eq!(text::running("Search Zotero…"), "Running Search Zotero…");
    let titled = Action {
        title: Some("Copy key".into()),
        kind: ActionKind::Copy { text: "k".into() },
    };
    assert_eq!(text::action_label(&titled), "Copy key");
    let plain = Action {
        title: None,
        kind: ActionKind::InsertCitation { key: "k".into() },
    };
    assert_eq!(text::action_label(&plain), "Insert citation");
}

fn diagnostic(id: &str, file: &str, line: u32) -> Diagnostic {
    Diagnostic {
        id: id.into(),
        file: file.into(),
        line: Some(line),
        severity: Severity::Warning,
        code: None,
        message: id.into(),
        fixes: Vec::new(),
    }
}

#[test]
fn diagnostics_group_by_file_in_first_seen_order_and_the_keys_skip_headers() {
    let result = CommandResult::Diagnostics {
        summary: None,
        items: vec![
            diagnostic("a", "refs.bib", 3),
            diagnostic("b", "main.tex", 1),
            diagnostic("c", "refs.bib", 9),
        ],
    };
    let rows = results::rows(&result);
    assert_eq!(
        rows,
        [
            Row::File("refs.bib".into()),
            Row::Diagnostic(0),
            Row::Diagnostic(2),
            Row::File("main.tex".into()),
            Row::Diagnostic(1),
        ]
    );
    assert_eq!(results::first(&rows), 1);
    assert_eq!(results::step(&rows, 2, 1), 4);
    assert_eq!(results::step(&rows, 4, 1), 1);
    assert_eq!(results::step(&rows, 1, -1), 4);
    let CommandResult::Diagnostics { items, .. } = &result else {
        unreachable!()
    };
    assert_eq!(
        results::diagnostic_default(&items[1]),
        ActionKind::Reveal {
            file: "main.tex".into(),
            line: Some(1)
        }
    );
}

#[test]
fn items_keep_their_order_and_return_runs_the_first_action() {
    let item = Item {
        id: "x".into(),
        title: "X".into(),
        subtitle: None,
        detail: None,
        badges: Vec::new(),
        actions: vec![Action {
            title: None,
            kind: ActionKind::OpenUrl {
                url: "https://example.org".into(),
            },
        }],
    };
    let result = CommandResult::Items {
        summary: None,
        items: vec![item.clone(), item.clone()],
    };
    assert_eq!(results::rows(&result), [Row::Item(0), Row::Item(1)]);
    assert!(matches!(
        results::item_default(&item),
        Some(ActionKind::OpenUrl { .. })
    ));
    let message = CommandResult::Message {
        summary: None,
        markdown: "x".into(),
    };
    assert!(results::rows(&message).is_empty());
}

#[test]
fn markdown_keeps_its_structure_and_never_renders_html() {
    let blocks = markdown::parse(
        "# Title\n\nSome **bold** and a [link](https://example.org) and [bad](javascript:x).\n\n1. one\n2. two\n\n<b>raw</b>\n",
    );
    assert!(matches!(&blocks[0], Block::Heading(text) if text.text == "Title"));
    let Block::Paragraph(paragraph) = &blocks[1] else {
        panic!("{blocks:?}")
    };
    assert_eq!(paragraph.text, "Some bold and a link and bad.");
    assert!(
        paragraph
            .marks
            .iter()
            .any(|(range, mark)| *mark == Mark::Strong && &paragraph.text[range.clone()] == "bold")
    );
    assert_eq!(paragraph.links.len(), 1);
    assert_eq!(paragraph.links[0].1, "https://example.org");
    assert!(matches!(&blocks[2], Block::Item { marker, .. } if marker == "1."));
    assert!(matches!(&blocks[3], Block::Item { marker, .. } if marker == "2."));
    assert!(matches!(&blocks[4], Block::Paragraph(text) if text.text.contains("<b>raw</b>")));
}

#[test]
fn a_bibliography_change_is_worked_out_before_the_writer_is_asked() {
    let text = "@article{a,\n  title = {A},\n}\n";
    let added = plan(
        text,
        &BibChange::Add {
            bibtex: "@book{b, title = {B}}".into(),
        },
    )
    .unwrap();
    assert_eq!(added.key, "b");
    assert_eq!(
        added.after,
        "@article{a,\n  title = {A},\n}\n\n@book{b, title = {B}}\n"
    );
    assert!(
        plan(
            text,
            &BibChange::Add {
                bibtex: "@misc{A, title={x}}".into()
            }
        )
        .is_err()
    );
    let replaced = plan(
        text,
        &BibChange::Replace {
            key: "a".into(),
            bibtex: "@article{a,\n  title = {A2},\n}".into(),
        },
    )
    .unwrap();
    assert_eq!(replaced.after, "@article{a,\n  title = {A2},\n}\n");
    assert_eq!(
        replaced.replaced.as_deref(),
        Some("@article{a,\n  title = {A},\n}")
    );
    assert!(
        plan(
            text,
            &BibChange::Replace {
                key: "z".into(),
                bibtex: "@misc{z,}".into()
            }
        )
        .is_err()
    );
    let diff = diff_lines("a\nb\n", "a\nc\n");
    assert_eq!(diff, "  a\n− b\n+ c");
}
