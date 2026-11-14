//! The Writing, Reading and Bibliography presets and focus mode (`presetLayout`,
//! `enterPreset`, `enterFocus`, `returnLayout` and `undoReset` in
//! `src/trellis/trellis-layout.ts`): arrangements laid over the writer's own
//! layout, and the way back to it brought up to date.

use std::collections::HashSet;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use trellis::model::{
    Axis, Edge, HiddenPanel, LayoutDocument, LayoutNode, PanelNode, RestoreTarget, SplitNode, Views,
};

use super::{
    ROOT_PDF, document_slot, file_key, is_document_view, map_panels, panels_of, record, tidy,
};

/// Writing puts the source beside the compiled PDF; Reading puts a paper
/// beside the notes; Bibliography puts the Papers library beside the
/// bibliography. Each is a temporary arrangement over the writer's own
/// layout, which is kept until they return to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    Writing,
    Reading,
    Bibliography,
}

impl Preset {
    pub const ALL: [Preset; 3] = [Preset::Writing, Preset::Reading, Preset::Bibliography];

    /// The titlebar's name for it.
    pub fn label(self) -> &'static str {
        match self {
            Preset::Writing => lattice_i18n::t!("Writing"),
            Preset::Reading => lattice_i18n::t!("Reading"),
            Preset::Bibliography => lattice_i18n::t!("Bibliography"),
        }
    }
}

/// What `preset_layout` lays out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Laid {
    Preset(Preset),
    /// Focus mode, with the PDF beside the documents or not.
    Focus {
        pdf: bool,
    },
}

/// A preset on screen: the writer's own layout under it (`previous`), and
/// the views it brought in that `previous` lacked and the writer has not
/// asked for since (`supplied`), which leave again on the return.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActivePreset {
    pub preset: Preset,
    pub previous: LayoutDocument,
    #[serde(default)]
    pub supplied: Vec<String>,
}

/// Focus mode on screen: the open documents in one panel, the compiled PDF
/// beside them only when `pdf`, over whatever was on screen (the writer's
/// own layout or a preset's), kept as `previous` to return to as it was.
/// Like a preset's, the panels it put away wait hidden and mounted.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActiveFocus {
    pub previous: LayoutDocument,
    #[serde(default)]
    pub supplied: Vec<String>,
    #[serde(default)]
    pub pdf: bool,
}

/// The open documents: the one in front, and all of them in tab order.
#[derive(Clone, Copy, Debug)]
pub struct Documents<'a> {
    pub active_key: &'a str,
    pub open_tabs: &'a [String],
}

impl Documents<'_> {
    /// The open documents in tab order, then the active one, each once.
    pub(super) fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = Vec::new();
        for key in self
            .open_tabs
            .iter()
            .map(String::as_str)
            .chain([self.active_key])
        {
            if !key.is_empty() && !keys.iter().any(|seen| seen == key) {
                keys.push(key.to_string());
            }
        }
        keys
    }

    fn open(&self) -> HashSet<&str> {
        self.open_tabs
            .iter()
            .map(String::as_str)
            .chain([self.active_key])
            .filter(|key| !key.is_empty())
            .collect()
    }
}

/// Each document's first view in `views`, by its key.
fn views_by_key(views: &Views) -> IndexMap<String, String> {
    let mut by_key = IndexMap::new();
    for (id, view) in views {
        let key = file_key(Some(view));
        if !key.is_empty() && !by_key.contains_key(&key) {
            by_key.insert(key, id.clone());
        }
    }
    by_key
}

/// `doc` rearranged as `laid`. Every open document keeps its view (and so
/// its tab), only regrouped: Writing gathers them into one panel before the
/// PDF, selecting the source being written; Reading gathers papers with the
/// Papers library before a panel of everything else, selecting the paper
/// and the notes; Bibliography puts the Papers library (with the Project
/// navigator and any open papers) beside a panel of the written documents,
/// selecting the first open `.bib` (else the first written document), and
/// shows the Project navigator there when nothing is written; focus mode gathers them in one panel, the one in front
/// kept in front. Every other view (navigators, the Agent, tools) is parked
/// hidden in its own panel rather than dropped, so its content stays
/// mounted: the Agent must not lose a running turn.
pub fn preset_layout(
    laid: Laid,
    doc: &LayoutDocument,
    documents: Documents,
    is_reading: &dyn Fn(&str) -> bool,
) -> LayoutDocument {
    let active_key = documents.active_key;
    let by_key = views_by_key(&doc.views);
    let keys: Vec<String> = documents
        .keys()
        .into_iter()
        .filter(|key| by_key.contains_key(key))
        .collect();
    let id_of = |key: &str| by_key[key].clone();
    let mut views = Views::new();
    for key in &keys {
        views.insert(id_of(key), doc.views[&by_key[key]].clone());
    }
    // The live PDF keeps its record: it names the document it shows.
    let live_pdf = doc
        .views
        .get("pdf")
        .cloned()
        .unwrap_or_else(|| record("pdf"));
    let panel = |id: &str, members: Vec<String>, selected_key: Option<&str>| -> PanelNode {
        let selected = selected_key
            .filter(|key| !key.is_empty())
            .and_then(|key| by_key.get(key).cloned())
            .unwrap_or_else(|| members[0].clone());
        PanelNode {
            id: id.into(),
            views: members,
            selected,
        }
    };
    // The active document when it belongs on this side, else the first that
    // `prefer`s, else the first.
    let pick = |candidates: &[String], prefer: &dyn Fn(&str) -> bool| -> Option<String> {
        if candidates.iter().any(|key| key == active_key) {
            return Some(active_key.to_string());
        }
        candidates
            .iter()
            .find(|key| prefer(key))
            .or(candidates.first())
            .cloned()
    };
    let row = |id: &str, mut children: Vec<LayoutNode>| -> LayoutNode {
        if children.len() == 1 {
            return children.remove(0);
        }
        LayoutNode::Split(SplitNode {
            id: id.into(),
            axis: Axis::X,
            weights: vec![0.5; children.len()],
            children,
        })
    };
    let ids: Vec<String> = keys.iter().map(|key| id_of(key)).collect();
    let project = || PanelNode::single("panel-project", "project");
    let root = match laid {
        Laid::Focus { pdf } => {
            if ids.is_empty() {
                views.insert("project".into(), record("project"));
            }
            if pdf {
                views.insert("pdf".into(), live_pdf);
            }
            let front = if active_key.is_empty() {
                keys.first().map(String::as_str)
            } else {
                Some(active_key)
            };
            let documents_panel = if ids.is_empty() {
                project()
            } else {
                panel("panel-focus", ids, front)
            };
            let mut children = vec![LayoutNode::Panel(documents_panel)];
            if pdf {
                children.push(LayoutNode::Panel(PanelNode::single("panel-pdf", "pdf")));
            }
            row("split-focus", children)
        }
        Laid::Preset(Preset::Writing) => {
            views.insert("pdf".into(), live_pdf);
            let written: Vec<String> = keys
                .iter()
                .filter(|key| !is_reading(key))
                .cloned()
                .collect();
            // LaTeX is what the PDF is compiled from, so a .tex source wins
            // over the active note.
            let tex = |key: &str| key.to_lowercase().ends_with(".tex");
            let source = if tex(active_key) && written.iter().any(|key| key == active_key) {
                Some(active_key.to_string())
            } else {
                written.iter().find(|key| tex(key)).cloned()
            }
            .or_else(|| pick(&written, &tex))
            .or_else(|| keys.first().cloned());
            // With nothing open to write, the Project panel stands in for the
            // source.
            if ids.is_empty() {
                views.insert("project".into(), record("project"));
            }
            let writing = if ids.is_empty() {
                project()
            } else {
                panel("panel-writing", ids, source.as_deref())
            };
            row(
                "split-writing",
                vec![
                    LayoutNode::Panel(writing),
                    LayoutNode::Panel(PanelNode::single("panel-pdf", "pdf")),
                ],
            )
        }
        Laid::Preset(Preset::Bibliography) => {
            views.insert("papers".into(), record("papers"));
            views.insert("project".into(), record("project"));
            let (read, written): (Vec<String>, Vec<String>) =
                keys.iter().cloned().partition(|key| is_reading(key));
            let bibliography = written
                .iter()
                .find(|key| key.to_lowercase().ends_with(".bib"))
                .or(written.first())
                .cloned();
            let mut library = vec!["papers".to_string()];
            if !written.is_empty() {
                library.push("project".into());
            }
            library.extend(read.iter().map(|key| id_of(key)));
            let written_panel = if written.is_empty() {
                PanelNode::single("panel-bibliography", "project")
            } else {
                let members = written.iter().map(|key| id_of(key)).collect();
                panel("panel-bibliography", members, bibliography.as_deref())
            };
            LayoutNode::Split(SplitNode {
                id: "split-bibliography".into(),
                axis: Axis::X,
                weights: vec![0.35, 0.65],
                children: vec![
                    LayoutNode::Panel(PanelNode {
                        id: "panel-library".into(),
                        selected: "papers".into(),
                        views: library,
                    }),
                    LayoutNode::Panel(written_panel),
                ],
            })
        }
        Laid::Preset(Preset::Reading) => {
            views.insert("papers".into(), record("papers"));
            let read: Vec<String> = keys.iter().filter(|key| is_reading(key)).cloned().collect();
            let notes: Vec<String> = keys
                .iter()
                .filter(|key| !is_reading(key))
                .cloned()
                .collect();
            let paper = if read.iter().any(|key| key == active_key) {
                Some(active_key.to_string())
            } else {
                read.first().cloned()
            };
            let members = std::iter::once("papers".to_string())
                .chain(read.iter().map(|key| id_of(key)))
                .collect();
            let mut reading = panel("panel-reading", members, paper.as_deref());
            if paper.is_none() {
                reading.selected = "papers".into();
            }
            let mut children = vec![LayoutNode::Panel(reading)];
            if !notes.is_empty() {
                let note = pick(&notes, &|key| key.to_lowercase().ends_with(".md"));
                let members = notes.iter().map(|key| id_of(key)).collect();
                children.push(LayoutNode::Panel(panel(
                    "panel-notes",
                    members,
                    note.as_deref(),
                )));
            }
            row("split-reading", children)
        }
    };
    let placed: HashSet<String> = trellis::model::panels_of(Some(&root))
        .into_iter()
        .map(|target| target.id.clone())
        .collect();
    let restore = RestoreTarget::Docked {
        beside: root.id().to_string(),
        edge: Edge::Left,
        share: 0.3,
    };
    let mut hidden = Vec::new();
    for source in panels_of(doc, true) {
        let members: Vec<String> = source
            .views
            .iter()
            .filter(|id| {
                doc.views.get(*id).is_some_and(|view| view.kind != "file")
                    && !views.contains_key(*id)
            })
            .cloned()
            .collect();
        if members.is_empty() {
            continue;
        }
        for id in &members {
            views.insert(id.clone(), doc.views[id].clone());
        }
        let id = if placed.contains(&source.id) {
            format!("{}-parked", source.id)
        } else {
            source.id.clone()
        };
        let selected = if members.contains(&source.selected) {
            source.selected.clone()
        } else {
            members[0].clone()
        };
        hidden.push(HiddenPanel {
            panel: PanelNode {
                id,
                views: members,
                selected,
            },
            restore: restore.clone(),
        });
    }
    LayoutDocument {
        schema: 1,
        version: doc.version.clone(),
        root: Some(root),
        floating: Vec::new(),
        hidden,
        views,
        navigation: None,
    }
}

/// The views of `document` other than documents that `before` lacked.
fn brought_in(document: &LayoutDocument, before: &LayoutDocument) -> Vec<String> {
    document
        .views
        .iter()
        .filter(|(id, view)| view.kind != "file" && !before.views.contains_key(*id))
        .map(|(id, _)| id.clone())
        .collect()
}

/// `doc` (the writer's own layout, or that of the `active` preset)
/// rearranged as `preset`, with the preset to return from: switching
/// between presets keeps the layout from before the first, and what each
/// preset supplied.
pub fn enter_preset(
    preset: Preset,
    doc: &LayoutDocument,
    active: Option<&ActivePreset>,
    documents: Documents,
    is_reading: &dyn Fn(&str) -> bool,
) -> (LayoutDocument, ActivePreset) {
    let document = preset_layout(Laid::Preset(preset), doc, documents, is_reading);
    let mut supplied = active
        .map(|active| active.supplied.clone())
        .unwrap_or_default();
    supplied.extend(brought_in(&document, doc));
    let previous = active.map_or_else(|| doc.clone(), |active| active.previous.clone());
    (
        document,
        ActivePreset {
            preset,
            previous,
            supplied,
        },
    )
}

/// `doc` in focus mode, with what to return to: entering keeps `doc` itself
/// (a preset's layout included); showing or hiding the PDF while in focus
/// mode (`active`) keeps the layout from before focus mode, and adds the PDF
/// to what focus mode supplied when that layout had none.
pub fn enter_focus(
    doc: &LayoutDocument,
    active: Option<&ActiveFocus>,
    documents: Documents,
    is_reading: &dyn Fn(&str) -> bool,
    pdf: bool,
) -> (LayoutDocument, ActiveFocus) {
    let document = preset_layout(Laid::Focus { pdf }, doc, documents, is_reading);
    let previous = active.map_or_else(|| doc.clone(), |active| active.previous.clone());
    let mut supplied = active
        .map(|active| active.supplied.clone())
        .unwrap_or_default();
    for id in brought_in(&document, &previous) {
        if !supplied.contains(&id) {
            supplied.push(id);
        }
    }
    (
        document,
        ActiveFocus {
            previous,
            supplied,
            pdf,
        },
    )
}

/// The writer's own layout to return to from a preset, brought up to date
/// with what is open now: documents and panels closed meanwhile stay closed
/// (a document panel left without any keeps an empty slot), and those
/// opened meanwhile (not those the preset `supplied`) join the panel holding
/// the active document (else the first document panel), keeping the views
/// they have now. The active document is selected in its panel. With no
/// document panel left to join, the shell's tab sync gives new documents
/// one, while other new views join the first panel.
pub fn return_layout(
    previous: &LayoutDocument,
    current: &LayoutDocument,
    documents: Documents,
    supplied: &[String],
) -> LayoutDocument {
    let open = documents.open();
    let mut views = previous.views.clone();
    let mut kept: HashSet<String> = HashSet::new();
    for (id, view) in &previous.views {
        let key = file_key(Some(view));
        let survives = if view.kind == "file" {
            open.contains(key.as_str()) && !kept.contains(&key)
        } else {
            current.views.contains_key(id)
        };
        if !survives {
            views.shift_remove(id);
        } else if !key.is_empty() {
            kept.insert(key);
        }
    }
    let panels = panels_of(previous, false);
    let holds_document = |target: &PanelNode, key: &str| {
        target.views.iter().any(|id| {
            let found = file_key(views.get(id));
            !found.is_empty() && (key.is_empty() || found == key)
        })
    };
    let group = panels
        .iter()
        .find(|target| holds_document(target, documents.active_key))
        .or_else(|| panels.iter().find(|target| holds_document(target, "")))
        .map(|target| target.id.clone());
    let target = group
        .clone()
        .or_else(|| panels.first().map(|target| target.id.clone()));
    let joining: Vec<(String, trellis::model::ViewRecord)> = current
        .views
        .iter()
        .filter(|(id, view)| {
            if view.kind == "file" {
                let key = file_key(Some(view));
                group.is_some() && open.contains(key.as_str()) && !kept.contains(&key)
            } else {
                !views.contains_key(*id) && !supplied.contains(id)
            }
        })
        .map(|(id, view)| (id.clone(), view.clone()))
        .collect();
    for (id, view) in &joining {
        views.insert(id.clone(), view.clone());
    }
    if views.contains_key("pdf")
        && let Some(pdf) = current.views.get("pdf").filter(|pdf| pdf.params.is_some())
    {
        views.insert("pdf".into(), pdf.clone());
    }
    // A compiled document's PDF tab opened meanwhile joins the live PDF's
    // panel, not the documents'.
    let pdf_home = panels
        .iter()
        .find(|panel| panel.views.iter().any(|id| id == "pdf") && views.contains_key("pdf"))
        .map(|panel| panel.id.clone());
    let joined: Vec<String> = joining.into_iter().map(|(id, _)| id).collect();
    let to_pdf: HashSet<String> = joined
        .iter()
        .filter(|id| pdf_home.is_some() && views.get(*id).is_some_and(|view| view.kind == ROOT_PDF))
        .cloned()
        .collect();
    let active = (!documents.active_key.is_empty())
        .then(|| {
            views
                .iter()
                .find(|(_, view)| file_key(Some(view)) == documents.active_key)
                .map(|(id, _)| id.clone())
        })
        .flatten();
    let mut replace = |panel: &PanelNode| -> PanelNode {
        let mut members = panel.views.clone();
        if Some(&panel.id) == target.as_ref() {
            members.extend(joined.iter().filter(|id| !to_pdf.contains(*id)).cloned());
        }
        if Some(&panel.id) == pdf_home.as_ref() {
            members.extend(joined.iter().filter(|id| to_pdf.contains(*id)).cloned());
        }
        let mut selected = match &active {
            Some(active) if members.contains(active) => active.clone(),
            _ => panel.selected.clone(),
        };
        let at = members
            .iter()
            .position(|id| is_document_view(previous.views.get(id)));
        if let Some(at) = at
            && !members.iter().any(|id| is_document_view(views.get(id)))
        {
            let (slot, slot_record) = document_slot(&panel.id);
            views.insert(slot.clone(), slot_record);
            members.insert(at, slot.clone());
            if !views.contains_key(&selected) {
                selected = slot;
            }
        }
        PanelNode {
            id: panel.id.clone(),
            views: members,
            selected,
        }
    };
    let mut doc = if previous.root.is_some() {
        map_panels(previous, &mut replace)
    } else {
        let mut doc = map_panels(previous, &mut replace);
        doc.root = joined.first().map(|first| {
            LayoutNode::Panel(PanelNode {
                id: format!("panel-{first}"),
                views: joined.clone(),
                selected: first.clone(),
            })
        });
        doc
    };
    doc.views = views;
    // Panels left without a view go, and their splits close up around them.
    tidy(&doc)
}

/// The writer's layout from before a reset (`previous`), to undo it: brought
/// up to date like a return from a preset, so documents closed since stay
/// closed and the panels only the reset brought in leave again. A tool panel
/// the reset put away comes back while its tool is still open
/// (`tool_open`).
pub fn undo_reset(
    previous: &LayoutDocument,
    current: &LayoutDocument,
    documents: Documents,
    tool_open: &dyn Fn(&str) -> bool,
) -> LayoutDocument {
    let mut with_tools = current.clone();
    for (id, view) in &previous.views {
        if view.kind != "file" && !with_tools.views.contains_key(id) && tool_open(&view.kind) {
            with_tools.views.insert(id.clone(), view.clone());
        }
    }
    let supplied = brought_in(current, previous);
    return_layout(previous, &with_tools, documents, &supplied)
}
