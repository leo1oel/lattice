//! The Tauri app's `src/trellis/trellis-layout.test.ts`, case for case
//! (its storage cases are in `shell/workspaces.rs`).

use trellis::model::{
    FloatingLayer, FloatingPanel, LayoutDocument, LayoutNode, PanelNode, Rect, ViewRecord,
};

use super::presets::{Laid, preset_layout};
use super::*;

const PAPER: &str = "paper:1706.03762:";

fn is_reading(key: &str) -> bool {
    key.starts_with("paper:") || key.ends_with(".pdf")
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

/// The default layout with these documents in one panel, as the shell's tab
/// sync leaves them.
fn workspace_with(keys: &[&str]) -> LayoutDocument {
    let mut doc = with_document_panel(
        &default_layout(),
        "doc-0",
        keys[0],
        &strings(&["panel-project"]),
        None,
    );
    for (index, key) in keys.iter().enumerate().skip(1) {
        let id = format!("doc-{index}");
        doc.views.insert(id.clone(), file_record(key));
        find_panel(&mut doc, "panel-doc-0").views.push(id);
    }
    doc
}

fn find_in<'a>(node: &'a mut LayoutNode, id: &str) -> Option<&'a mut PanelNode> {
    match node {
        LayoutNode::Panel(panel) => (panel.id == id).then_some(panel),
        LayoutNode::Stage(stage) => stage
            .child
            .as_deref_mut()
            .and_then(|child| find_in(child, id)),
        LayoutNode::Split(split) => split
            .children
            .iter_mut()
            .find_map(|child| find_in(child, id)),
    }
}

fn find_panel<'a>(doc: &'a mut LayoutDocument, id: &str) -> &'a mut PanelNode {
    doc.root
        .as_mut()
        .and_then(|root| find_in(root, id))
        .unwrap_or_else(|| panic!("no docked panel {id}"))
}

fn docked(doc: &LayoutDocument, id: &str) -> Option<PanelNode> {
    trellis::model::panels_of(doc.root.as_ref())
        .into_iter()
        .find(|panel| panel.id == id)
        .cloned()
}

type Row = (String, Vec<String>, String);

fn row(id: &str, views: &[&str], selected: &str) -> Row {
    (id.into(), strings(views), selected.into())
}

fn panels(doc: &LayoutDocument) -> Vec<Row> {
    trellis::model::panels_of(doc.root.as_ref())
        .into_iter()
        .map(|panel| {
            (
                panel.id.clone(),
                panel.views.clone(),
                panel.selected.clone(),
            )
        })
        .collect()
}

fn parked(doc: &LayoutDocument) -> Vec<Row> {
    doc.hidden
        .iter()
        .map(|entry| {
            (
                entry.panel.id.clone(),
                entry.panel.views.clone(),
                entry.panel.selected.clone(),
            )
        })
        .collect()
}

fn root_split(doc: &mut LayoutDocument) -> &mut trellis::model::SplitNode {
    match doc.root.as_mut() {
        Some(LayoutNode::Split(split)) => split,
        _ => panic!("the root is no split"),
    }
}

/// `doc` without the PDF (its panel was last in the root row).
fn without_pdf(mut doc: LayoutDocument) -> LayoutDocument {
    doc.views.shift_remove("pdf");
    let root = root_split(&mut doc);
    root.children.pop();
    root.weights.pop();
    doc
}

/// `doc` with Papers closed and its column closed up.
fn without_papers(mut doc: LayoutDocument) -> LayoutDocument {
    doc.views.shift_remove("papers");
    let LayoutNode::Split(column) = &mut root_split(&mut doc).children[0] else {
        panic!("no navigators' column");
    };
    column.children.truncate(1);
    column.weights = vec![1.];
    doc
}

const KEYS: &[&str] = &["main.tex", "notes.md", PAPER];

fn open_tabs() -> Vec<String> {
    strings(KEYS)
}

fn documents<'a>(active: &'a str, open: &'a [String]) -> Documents<'a> {
    Documents {
        active_key: active,
        open_tabs: open,
    }
}

fn preset(laid: Laid, doc: &LayoutDocument, active: &str, open: &[String]) -> LayoutDocument {
    preset_layout(laid, doc, documents(active, open), &is_reading)
}

const WRITING: Laid = Laid::Preset(Preset::Writing);
const READING: Laid = Laid::Preset(Preset::Reading);

#[test]
fn bibliography_keeps_the_library_beside_the_bibliography_and_preserves_all_documents() {
    let open = strings(&["main.tex", "references.bib", PAPER]);
    let doc = preset(
        Laid::Preset(Preset::Bibliography),
        &workspace_with(&["main.tex", "references.bib", PAPER]),
        "main.tex",
        &open,
    );
    assert_eq!(
        panels(&doc),
        vec![
            row("panel-library", &["papers", "project", "doc-2"], "papers"),
            row("panel-bibliography", &["doc-0", "doc-1"], "doc-1"),
        ]
    );
    let Some(LayoutNode::Split(split)) = &doc.root else {
        panic!("Bibliography lays out a row");
    };
    assert_eq!(split.weights, vec![0.35, 0.65]);
    // With nothing written, Project stands in for the bibliography.
    let empty = preset(
        Laid::Preset(Preset::Bibliography),
        &default_layout(),
        "",
        &[],
    );
    assert_eq!(
        panels(&empty),
        vec![
            row("panel-library", &["papers"], "papers"),
            row("panel-bibliography", &["project"], "project"),
        ]
    );
}

#[test]
fn writing_keeps_every_open_document_beside_the_pdf_with_the_latex_source_in_front() {
    let open = open_tabs();
    let doc = preset(WRITING, &workspace_with(KEYS), "notes.md", &open);
    assert_eq!(
        panels(&doc),
        vec![
            row("panel-writing", &["doc-0", "doc-1", "doc-2"], "doc-0"),
            row("panel-pdf", &["pdf"], "pdf"),
        ]
    );
    let mut ids: Vec<&String> = doc.views.keys().collect();
    ids.sort();
    assert_eq!(
        ids,
        [
            "agent", "doc-0", "doc-1", "doc-2", "papers", "pdf", "project"
        ]
    );
}

#[test]
fn reading_puts_the_paper_with_the_library_beside_the_notes() {
    let open = open_tabs();
    let doc = preset(READING, &workspace_with(KEYS), "notes.md", &open);
    assert_eq!(
        panels(&doc),
        vec![
            row("panel-reading", &["papers", "doc-2"], "doc-2"),
            row("panel-notes", &["doc-0", "doc-1"], "doc-1"),
        ]
    );
}

#[test]
fn parks_the_navigators_the_agent_and_tools_hidden_so_their_content_stays_mounted() {
    let open = open_tabs();
    let mut previous = workspace_with(KEYS);
    previous.views.insert("history".into(), record("history"));
    previous.floating.push(FloatingPanel {
        panel: PanelNode::single("panel-history", "history"),
        rect: Rect::new(0.1, 0.1, 0.3, 0.3),
        z: 1.,
        layer: FloatingLayer::Overlay,
    });
    let writing = preset(WRITING, &previous, "notes.md", &open);
    assert_eq!(
        parked(&writing),
        vec![
            row("panel-project", &["project", "agent"], "project"),
            row("panel-papers", &["papers"], "papers"),
            row("panel-history", &["history"], "history"),
        ]
    );
    assert!(writing.floating.is_empty());
    // From one preset to the other, a view the next one shows leaves the
    // parked panels.
    let reading = preset(READING, &writing, "notes.md", &open);
    assert_eq!(
        parked(&reading),
        vec![
            row("panel-pdf", &["pdf"], "pdf"),
            row("panel-project", &["project", "agent"], "project"),
            row("panel-history", &["history"], "history"),
        ]
    );
    // A parked panel whose id the preset uses takes another.
    let empty = preset(WRITING, &default_layout(), "", &[]);
    assert_eq!(
        parked(&empty),
        vec![
            row("panel-project-parked", &["agent"], "agent"),
            row("panel-papers", &["papers"], "papers"),
        ]
    );
}

#[test]
fn reading_with_no_paper_open_offers_the_library_to_pick_one() {
    let open = strings(&["main.tex"]);
    let doc = preset(READING, &workspace_with(&["main.tex"]), "main.tex", &open);
    assert_eq!(panels(&doc)[0], row("panel-reading", &["papers"], "papers"));
}

#[test]
fn writing_with_nothing_open_shows_the_project_panel_beside_the_pdf() {
    let doc = preset(WRITING, &default_layout(), "", &[]);
    let views: Vec<Vec<String>> = panels(&doc)
        .into_iter()
        .map(|(_, views, _)| views)
        .collect();
    assert_eq!(views, vec![strings(&["project"]), strings(&["pdf"])]);
}

#[test]
fn returns_to_the_writers_layout_with_surviving_documents_new_ones_joined_and_closed_ones_gone() {
    let open = open_tabs();
    let previous = workspace_with(KEYS);
    let mut current = preset(READING, &previous, "notes.md", &open);
    // While reading: notes.md closed, draft.md opened (the tab sync gave it
    // a view).
    current
        .views
        .insert("doc-9".into(), file_record("draft.md"));
    let now = strings(&["main.tex", PAPER, "draft.md"]);
    let back = return_layout(&previous, &current, documents("draft.md", &now), &[]);
    assert_eq!(
        panels(&back),
        vec![
            row("panel-project", &["project", "agent"], "project"),
            row("panel-papers", &["papers"], "papers"),
            row("panel-doc-0", &["doc-0", "doc-2", "doc-9"], "doc-9"),
            row("panel-pdf", &["pdf"], "pdf"),
        ]
    );
    assert!(!back.views.contains_key("doc-1"));
}

#[test]
fn returns_with_the_panels_opened_while_away_and_without_those_closed() {
    let open = open_tabs();
    let mut previous = workspace_with(KEYS);
    previous.views.insert("history".into(), record("history"));
    previous.views.shift_remove("agent");
    find_panel(&mut previous, "panel-project").views = strings(&["project"]);
    find_panel(&mut previous, "panel-doc-0")
        .views
        .push("history".into());
    let mut current = preset(WRITING, &previous, "notes.md", &open);
    // While writing: the Agent opened (docked beside the PDF), History's
    // drawer closed.
    current.views.insert("agent".into(), record("agent"));
    find_panel(&mut current, "panel-pdf")
        .views
        .push("agent".into());
    current.views.shift_remove("history");
    current
        .hidden
        .retain(|entry| !entry.panel.views.iter().any(|id| id == "history"));
    let back = return_layout(&previous, &current, documents("notes.md", &open), &[]);
    let panel = docked(&back, "panel-doc-0").unwrap();
    assert_eq!(panel.views, strings(&["doc-0", "doc-1", "doc-2", "agent"]));
    assert_eq!(panel.selected, "doc-1");
    assert_eq!(back.views.get("agent"), Some(&record("agent")));
    assert!(!back.views.contains_key("history"));
}

#[test]
fn keeps_a_document_panel_whose_documents_all_closed_while_away_as_an_empty_slot() {
    let previous = workspace_with(&["notes.md"]);
    let open = strings(&["notes.md"]);
    let current = preset(WRITING, &previous, "notes.md", &open);
    let back = return_layout(&previous, &current, documents("", &[]), &[]);
    let ids: Vec<String> = panels(&back).into_iter().map(|(id, _, _)| id).collect();
    assert_eq!(
        ids,
        ["panel-project", "panel-papers", "panel-doc-0", "panel-pdf"]
    );
    let panel = docked(&back, "panel-doc-0").unwrap();
    assert_eq!(panel.views, ["slot-panel-doc-0"]);
    assert_eq!(panel.selected, "slot-panel-doc-0");
    assert_eq!(back.views["slot-panel-doc-0"].kind, "slot");
}

#[test]
fn returns_without_the_panels_a_preset_brought_in_through_writing_and_then_reading() {
    let open = open_tabs();
    let docs = documents("notes.md", &open);
    // The writer's own layout: Project and the documents, no PDF and no
    // Papers.
    let previous = without_pdf(without_papers(workspace_with(KEYS)));
    let (writing, active) = enter_preset(Preset::Writing, &previous, None, docs, &is_reading);
    assert_eq!(active.supplied, ["pdf"]);
    let (reading, active) =
        enter_preset(Preset::Reading, &writing, Some(&active), docs, &is_reading);
    assert_eq!(
        active,
        ActivePreset {
            preset: Preset::Reading,
            previous: previous.clone(),
            supplied: strings(&["pdf", "papers"]),
        }
    );
    let back = return_layout(&previous, &reading, docs, &active.supplied);
    assert!(!back.views.contains_key("pdf"));
    assert!(!back.views.contains_key("papers"));
    assert_eq!(
        panels(&back),
        panels(&return_layout(&previous, &previous, docs, &[]))
    );
    // One the writer asked for while reading stays.
    let kept = return_layout(&previous, &reading, docs, &strings(&["papers"]));
    assert_eq!(kept.views.get("pdf"), Some(&record("pdf")));
    assert!(!kept.views.contains_key("papers"));
}

#[test]
fn focus_puts_every_open_document_in_one_panel_the_one_in_front_kept_in_front_and_parks_the_rest() {
    let open = open_tabs();
    let doc = preset(
        Laid::Focus { pdf: false },
        &workspace_with(KEYS),
        "notes.md",
        &open,
    );
    assert_eq!(
        panels(&doc),
        vec![row("panel-focus", &["doc-0", "doc-1", "doc-2"], "doc-1")]
    );
    let parked: Vec<Vec<String>> = doc
        .hidden
        .iter()
        .map(|entry| entry.panel.views.clone())
        .collect();
    assert_eq!(
        parked,
        vec![
            strings(&["project", "agent"]),
            strings(&["papers"]),
            strings(&["pdf"])
        ]
    );
}

#[test]
fn focus_shows_the_pdf_beside_the_documents_when_asked() {
    let open = open_tabs();
    let doc = preset(
        Laid::Focus { pdf: true },
        &workspace_with(KEYS),
        "notes.md",
        &open,
    );
    assert_eq!(
        panels(&doc),
        vec![
            row("panel-focus", &["doc-0", "doc-1", "doc-2"], "doc-1"),
            row("panel-pdf", &["pdf"], "pdf"),
        ]
    );
}

#[test]
fn focus_returns_to_exactly_the_layout_it_was_entered_from_a_presets_included() {
    let open = open_tabs();
    let docs = documents("notes.md", &open);
    let own = workspace_with(KEYS);
    let back = |from: &LayoutDocument, docs: Documents| {
        let (document, active) = enter_focus(from, None, docs, &is_reading, false);
        return_layout(&active.previous, &document, docs, &active.supplied)
    };
    assert_eq!(
        panels(&back(&own, docs)),
        panels(&return_layout(&own, &own, docs, &[]))
    );
    // Writing puts the source in front, and makes it the active document.
    let writing = preset(WRITING, &own, "notes.md", &open);
    let source = documents("main.tex", &open);
    assert_eq!(panels(&back(&writing, source)), panels(&writing));
}

#[test]
fn focus_keeps_the_layout_from_before_it_while_the_pdf_comes_and_goes_and_drops_a_pdf_it_brought_in()
 {
    let open = open_tabs();
    let docs = documents("notes.md", &open);
    let previous = without_pdf(workspace_with(KEYS));
    let (document, active) = enter_focus(&previous, None, docs, &is_reading, false);
    assert_eq!(
        active,
        ActiveFocus {
            previous: previous.clone(),
            supplied: vec![],
            pdf: false,
        }
    );
    let (shown, active) = enter_focus(&document, Some(&active), docs, &is_reading, true);
    assert_eq!(
        active,
        ActiveFocus {
            previous: previous.clone(),
            supplied: strings(&["pdf"]),
            pdf: true,
        }
    );
    let ids: Vec<String> = panels(&shown).into_iter().map(|(id, _, _)| id).collect();
    assert_eq!(ids, ["panel-focus", "panel-pdf"]);
    let back = return_layout(&previous, &shown, docs, &active.supplied);
    assert!(!back.views.contains_key("pdf"));
}

/// The writer's own layout: Papers closed (its column closes up), History
/// docked with the documents.
fn arranged() -> LayoutDocument {
    let mut doc = without_papers(workspace_with(KEYS));
    doc.views.insert("history".into(), record("history"));
    find_panel(&mut doc, "panel-doc-0")
        .views
        .push("history".into());
    tidy(&doc)
}

/// The default layout as a reset leaves it: the tab sync re-placed the
/// documents under new views.
fn reset(open: &[&str]) -> LayoutDocument {
    let mut doc = with_document_panel(
        &default_layout(),
        "file-new0",
        open[0],
        &strings(&["panel-project"]),
        None,
    );
    for (index, key) in open.iter().enumerate().skip(1) {
        let id = format!("file-new{index}");
        doc.views.insert(id.clone(), file_record(key));
        find_panel(&mut doc, "panel-file-new0").views.push(id);
    }
    doc
}

#[test]
fn undoing_a_reset_brings_back_the_writers_arrangement_without_the_panels_only_the_reset_brought_in()
 {
    let open = open_tabs();
    let previous = arranged();
    let back = undo_reset(
        &previous,
        &reset(KEYS),
        documents("main.tex", &open),
        &|kind| kind == "history",
    );
    assert_eq!(
        panels(&back),
        vec![
            row("panel-project", &["project", "agent"], "project"),
            row(
                "panel-doc-0",
                &["doc-0", "doc-1", "doc-2", "history"],
                "doc-0"
            ),
            row("panel-pdf", &["pdf"], "pdf"),
        ]
    );
    assert!(!back.views.contains_key("papers"));
    assert_eq!(layout_shape(&back), layout_shape(&previous));
}

#[test]
fn undoing_a_reset_never_brings_back_a_document_closed_since_or_a_tool_no_longer_open() {
    let open = strings(&["main.tex", PAPER]);
    let back = undo_reset(
        &arranged(),
        &reset(&["main.tex", PAPER]),
        documents(PAPER, &open),
        &|_| false,
    );
    let panel = docked(&back, "panel-doc-0").unwrap();
    assert_eq!(panel.views, ["doc-0", "doc-2"]);
    assert_eq!(panel.selected, "doc-2");
    assert!(!back.views.contains_key("doc-1"));
    assert!(!back.views.contains_key("history"));
}

#[test]
fn the_shape_tells_a_change_of_arrangement_from_documents_re_placed_or_another_tab_selected() {
    let open = open_tabs();
    let previous = arranged();
    let same = undo_reset(&previous, &reset(KEYS), documents(PAPER, &open), &|_| true);
    assert_eq!(layout_shape(&same), layout_shape(&previous));
    let mut resized = previous.clone();
    root_split(&mut resized).weights = vec![0.3, 0.3, 0.4];
    assert_ne!(layout_shape(&resized), layout_shape(&previous));
    let mut moved = previous.clone();
    find_panel(&mut moved, "panel-doc-0").views.pop();
    find_panel(&mut moved, "panel-pdf")
        .views
        .push("history".into());
    assert_ne!(layout_shape(&moved), layout_shape(&previous));
}

/// Two document panels side by side: the LaTeX source and the notes left
/// of the paper.
fn side_by_side() -> LayoutDocument {
    let mut doc = workspace_with(KEYS);
    let first = find_panel(&mut doc, "panel-doc-0");
    first.views = strings(&["doc-0", "doc-1"]);
    first.selected = "doc-1".into();
    let root = root_split(&mut doc);
    root.children.insert(
        2,
        LayoutNode::Panel(PanelNode::single("panel-doc-2", "doc-2")),
    );
    root.weights = vec![0.25, 0.3, 0.2, 0.25];
    doc
}

fn key_or_id(doc: &LayoutDocument, id: &str) -> String {
    let key = doc
        .views
        .get(id)
        .map(|view| param(view, "key"))
        .unwrap_or_default();
    if key.is_empty() { id.to_string() } else { key }
}

#[test]
fn a_workspace_puts_each_open_document_back_where_it_sat() {
    let open = open_tabs();
    let own = side_by_side();
    let arranged = arrange_documents(
        &arrangement_of(&own),
        &workspace_with(KEYS),
        documents("main.tex", &open),
        &places_of(&own),
    );
    assert_eq!(
        panels(&arranged),
        vec![
            row("panel-project", &["project", "agent"], "project"),
            row("panel-papers", &["papers"], "papers"),
            row("panel-doc-0", &["doc-0", "doc-1"], "doc-0"),
            row("panel-doc-2", &["doc-2"], "doc-2"),
            row("panel-pdf", &["pdf"], "pdf"),
        ]
    );
    assert_eq!(layout_shape(&arranged), layout_shape(&own));
}

#[test]
fn a_workspace_brings_new_documents_into_the_active_ones_panel_and_keeps_an_unfilled_slot() {
    let own = side_by_side();
    let open = strings(&["main.tex", "refs.bib"]);
    let current = workspace_with(&["main.tex", "refs.bib"]);
    let arranged = arrange_documents(
        &arrangement_of(&own),
        &current,
        documents("refs.bib", &open),
        &places_of(&own),
    );
    let shown: Vec<(String, Vec<String>)> = panels(&arranged)
        .into_iter()
        .map(|(id, views, _)| {
            (
                id,
                views
                    .iter()
                    .map(|view| key_or_id(&arranged, view))
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        shown,
        vec![
            ("panel-project".into(), strings(&["project", "agent"])),
            ("panel-papers".into(), strings(&["papers"])),
            ("panel-doc-0".into(), strings(&["main.tex", "refs.bib"])),
            ("panel-doc-2".into(), strings(&["slot-panel-doc-2"])),
            ("panel-pdf".into(), strings(&["pdf"])),
        ]
    );
    // The documents keep their views, so their tabs survive the switch.
    let panel = docked(&arranged, "panel-doc-0").unwrap();
    assert_eq!(panel.views, ["doc-0", "doc-1"]);
    assert_eq!(panel.selected, "doc-1");
}

#[test]
fn a_workspace_fills_a_slot_nothing_returns_to_with_a_document_that_has_no_place_there_yet() {
    let stored = arrangement_of(&side_by_side());
    let open = strings(&["intro.tex", "refs.bib", "notes.md"]);
    let arranged = arrange_documents(
        &stored,
        &workspace_with(&["intro.tex", "refs.bib", "notes.md"]),
        documents("notes.md", &open),
        &DocumentPlaces::new(),
    );
    let keys_in = |id: &str| -> Vec<String> {
        docked(&arranged, id)
            .unwrap()
            .views
            .iter()
            .map(|view| param(&arranged.views[view], "key"))
            .collect()
    };
    assert_eq!(keys_in("panel-doc-0"), ["notes.md", "refs.bib"]);
    assert_eq!(keys_in("panel-doc-2"), ["intro.tex"]);
}

#[test]
fn a_workspace_leaves_documents_to_the_tab_sync_when_it_has_no_place_for_them() {
    let open = open_tabs();
    let arranged = arrange_documents(
        &default_layout(),
        &workspace_with(KEYS),
        documents("main.tex", &open),
        &DocumentPlaces::new(),
    );
    assert_eq!(panels(&arranged), panels(&default_layout()));
    assert!(
        !arranged
            .views
            .values()
            .any(|view: &ViewRecord| view.kind == "file")
    );
}

#[test]
fn closing_the_last_document_of_a_panel_keeps_it_as_an_empty_slot() {
    let previous = side_by_side();
    let current = trellis::model::close_view(&previous, "doc-2");
    let kept = tidy(&keep_document_slot(&previous, &current, "doc-2").unwrap());
    let ids = |doc: &LayoutDocument| -> Vec<String> {
        panels(doc).into_iter().map(|(id, _, _)| id).collect()
    };
    assert_eq!(ids(&kept), ids(&previous));
    assert_eq!(
        docked(&kept, "panel-doc-2").unwrap().views,
        ["slot-panel-doc-2"]
    );
    assert!(!kept.views.contains_key("doc-2"));
    // A panel that still holds a document closes as before.
    assert!(keep_document_slot(&previous, &previous, "doc-0").is_none());
    assert!(filled_slots(&kept).is_empty());
}
