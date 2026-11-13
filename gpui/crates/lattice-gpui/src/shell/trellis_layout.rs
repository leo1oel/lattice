//! The workspace's layouts as Trellis documents, ported from the Tauri app's
//! `src/trellis/trellis-layout.ts` and the arrangement half of
//! `src/trellis/trellis-workspaces.ts`: the default layout, the panel a
//! document gets when none is left to join, a workspace's arrangement (its
//! documents taken out, each document panel keeping one empty slot), its
//! shape (what counts as a change of arrangement), the Writing, Reading and
//! focus layouts laid over the writer's own and the way back from them, and
//! putting the open documents back where they sat in a workspace.
//!
//! Every function here is pure: it takes documents and returns one, so the
//! tests run without a window. The shell hands the result to the
//! workspace's engine (`TrellisWorkspace::update_engine`).
//!
//! View ids: the singletons have fixed ids (`project`, `papers`, `agent`,
//! `pdf`, `build`), so code can address them; a document is a `file` view
//! whose `params.key` is its path relative to the project; a compiled
//! document's own PDF tab is a `root-pdf` view (`root-pdf:<document>`).

mod arrange;
mod presets;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use trellis::model::{
    Axis, LayoutDocument, LayoutNode, PanelNode, SplitNode, ViewRecord, Views, sanitize,
};

pub use arrange::{arrange_documents, filled_slots, keep_document_slot, places_of};
pub use presets::{
    ActiveFocus, ActivePreset, Documents, Preset, enter_focus, enter_preset, return_layout,
    undo_reset,
};

/// The saved layout's version: Trellis documents (the Arrangement of GPUI
/// Kit's dock before it was 1).
pub const LAYOUT_VERSION: u32 = 2;

/// A compiled document's own PDF tab (`compiled-pdf-tabs.ts`).
pub const ROOT_PDF: &str = "root-pdf";

/// The view types a layout may hold; a saved one naming any other loses it.
pub const VIEW_TYPES: &[&str] = &[
    "project",
    "papers",
    "agent",
    "pdf",
    ROOT_PDF,
    "file",
    "slot",
    "build",
    "terminal",
    "history",
    "git",
    "comments",
    "overleaf",
    "literature",
    "todos",
    "checklist",
    "start",
];

/// The navigators' views, which documents get a panel beside.
pub const NAVIGATORS: &[&str] = &["project", "papers", "agent"];

/// A document's share of the width when it gets a panel of its own.
const DOCUMENT_SHARE: f64 = 0.46;

pub fn known_type(kind: &str) -> bool {
    VIEW_TYPES.contains(&kind)
}

/// `doc` with views of unknown types dropped and its tree made whole.
pub fn tidy(doc: &LayoutDocument) -> LayoutDocument {
    sanitize(doc, &known_type)
}

pub fn record(kind: &str) -> ViewRecord {
    ViewRecord {
        kind: kind.into(),
        ..ViewRecord::default()
    }
}

/// A document's view record.
pub fn file_record(key: &str) -> ViewRecord {
    let mut params = trellis::model::Params::new();
    params.insert("key".into(), key.into());
    ViewRecord {
        kind: "file".into(),
        params: Some(params),
        title: None,
    }
}

/// The document a view shows, or "" for any other view.
pub fn file_key(record: Option<&ViewRecord>) -> String {
    match record {
        Some(record) if record.kind == "file" => param(record, "key"),
        _ => String::new(),
    }
}

/// A string parameter, as JavaScript's `String()` would read it.
pub fn param(record: &ViewRecord, name: &str) -> String {
    match record.params.as_ref().and_then(|params| params.get(name)) {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// A panel's place for documents: in an arrangement, and on screen while no
/// document fills it.
pub fn is_document_slot(record: Option<&ViewRecord>) -> bool {
    record.is_some_and(|record| record.kind == "slot")
}

/// A document, or the slot standing in for one.
pub fn is_document_view(record: Option<&ViewRecord>) -> bool {
    record.is_some_and(|record| record.kind == "file") || is_document_slot(record)
}

/// The slot of the document panel `panel_id`.
pub fn document_slot(panel_id: &str) -> (String, ViewRecord) {
    let record = ViewRecord {
        kind: "slot".into(),
        params: Some(trellis::model::Params::new()),
        title: None,
    };
    (format!("slot-{panel_id}"), record)
}

/// Every panel of `doc`: docked, then floating, then (with `hidden`) hidden.
pub fn panels_of(doc: &LayoutDocument, hidden: bool) -> Vec<&PanelNode> {
    let mut panels = trellis::model::panels_of(doc.root.as_ref());
    panels.extend(doc.floating.iter().map(|entry| &entry.panel));
    if hidden {
        panels.extend(doc.hidden.iter().map(|entry| &entry.panel));
    }
    panels
}

/// `doc` with every panel (docked, floating and hidden, in that order)
/// replaced by `f`'s.
pub fn map_panels(
    doc: &LayoutDocument,
    mut f: impl FnMut(&PanelNode) -> PanelNode,
) -> LayoutDocument {
    fn node(target: &LayoutNode, f: &mut dyn FnMut(&PanelNode) -> PanelNode) -> LayoutNode {
        match target {
            LayoutNode::Panel(panel) => LayoutNode::Panel(f(panel)),
            LayoutNode::Stage(stage) => {
                let mut stage = stage.clone();
                stage.child = stage.child.map(|child| Box::new(node(&child, f)));
                LayoutNode::Stage(stage)
            }
            LayoutNode::Split(split) => LayoutNode::Split(SplitNode {
                children: split.children.iter().map(|child| node(child, f)).collect(),
                ..split.clone()
            }),
        }
    }
    let mut out = doc.clone();
    out.root = doc.root.as_ref().map(|root| node(root, &mut f));
    for entry in &mut out.floating {
        entry.panel = f(&entry.panel);
    }
    for entry in &mut out.hidden {
        entry.panel = f(&entry.panel);
    }
    out
}

fn panel(id: &str, views: &[&str], selected: &str) -> LayoutNode {
    LayoutNode::Panel(PanelNode {
        id: id.into(),
        views: views.iter().map(|view| view.to_string()).collect(),
        selected: selected.into(),
    })
}

/// Project and the Agent share a panel above Papers on the left, and the PDF
/// takes the right. There is deliberately no stage: documents get panels of
/// their own between the two (`with_document_panel`), so hiding or closing
/// any panel lets its neighbours take the space instead of leaving an empty
/// region. Singletons get fixed ids so code can address them.
pub fn default_layout() -> LayoutDocument {
    let mut views = Views::new();
    for kind in ["project", "agent", "papers", "pdf"] {
        views.insert(kind.into(), record(kind));
    }
    LayoutDocument {
        version: Some(LAYOUT_VERSION.into()),
        root: Some(LayoutNode::Split(SplitNode {
            id: "split-root".into(),
            axis: Axis::X,
            weights: vec![0.36, 0.64],
            children: vec![
                LayoutNode::Split(SplitNode {
                    id: "split-navigators".into(),
                    axis: Axis::Y,
                    weights: vec![0.62, 0.38],
                    children: vec![
                        panel("panel-project", &["project", "agent"], "project"),
                        panel("panel-papers", &["papers"], "papers"),
                    ],
                }),
                panel("panel-pdf", &["pdf"], "pdf"),
            ],
        })),
        views,
        ..LayoutDocument::default()
    }
}

fn contains_panel(node: &LayoutNode, panel_id: &str) -> bool {
    match node {
        LayoutNode::Panel(panel) => panel.id == panel_id,
        LayoutNode::Stage(stage) => stage
            .child
            .as_deref()
            .is_some_and(|child| contains_panel(child, panel_id)),
        LayoutNode::Split(split) => split
            .children
            .iter()
            .any(|child| contains_panel(child, panel_id)),
    }
}

/// `doc` with a new panel for a document (view `id` showing `key`), used
/// when no document panel is left to join: it goes right after the
/// top-level column holding one of the `after` panels (the navigators), else
/// first, and takes `share` of the width while the others keep their
/// proportions.
pub fn with_document_panel(
    doc: &LayoutDocument,
    id: &str,
    key: &str,
    after: &[String],
    share: Option<f64>,
) -> LayoutDocument {
    let share = share.unwrap_or(DOCUMENT_SHARE);
    let new_panel = PanelNode::single(format!("panel-{id}"), id);
    let mut out = doc.clone();
    out.views.insert(id.into(), file_record(key));
    out.root = Some(match &doc.root {
        None => LayoutNode::Panel(new_panel),
        Some(LayoutNode::Split(root)) if root.axis == Axis::X => {
            let at = root
                .children
                .iter()
                .position(|child| after.iter().any(|id| contains_panel(child, id)))
                .map_or(0, |at| at + 1);
            let total = root.weights.iter().sum::<f64>();
            let total = if total == 0. { 1. } else { total };
            let mut root = root.clone();
            root.weights = root
                .weights
                .iter()
                .map(|weight| weight / total * (1. - share))
                .collect();
            root.weights.insert(at, share);
            root.children.insert(at, LayoutNode::Panel(new_panel));
            LayoutNode::Split(root)
        }
        Some(root) => LayoutNode::Split(SplitNode {
            id: format!("split-{id}"),
            axis: Axis::X,
            weights: vec![1. - share, share],
            children: vec![root.clone(), LayoutNode::Panel(new_panel)],
        }),
    });
    out
}

/// The docked panels holding Project, Papers or the Agent.
fn navigator_panels(doc: &LayoutDocument) -> Vec<String> {
    trellis::model::panels_of(doc.root.as_ref())
        .into_iter()
        .filter(|panel| {
            NAVIGATORS
                .iter()
                .any(|id| panel.views.iter().any(|view| view == id))
        })
        .map(|panel| panel.id.clone())
        .collect()
}

/// `layout` as an arrangement: its documents taken out, and each panel that
/// held any given one slot where they stood (selected if one of them was),
/// so the panel survives with its place in the layout. An arrangement
/// always has a slot: without any, one goes where a first document would
/// (`with_document_panel` beside the navigators).
pub fn arrangement_of(layout: &LayoutDocument) -> LayoutDocument {
    let doc = if layout
        .views
        .values()
        .any(|record| is_document_view(Some(record)))
    {
        layout.clone()
    } else {
        let id = trellis::model::uid("document");
        with_document_panel(layout, &id, "", &navigator_panels(layout), None)
    };
    let mut views = Views::new();
    // A compiled document's own PDF tab is the project's, like its
    // documents, and never the workspace's; nor is the document the live
    // PDF shows.
    for (id, view) in &doc.views {
        if is_document_view(Some(view)) || view.kind == ROOT_PDF {
            continue;
        }
        let kept = if view.kind == "pdf" {
            record("pdf")
        } else {
            view.clone()
        };
        views.insert(id.clone(), kept);
    }
    let mut out = map_panels(&doc, |target| {
        let (slot, slot_record) = document_slot(&target.id);
        let mut members: Vec<String> = Vec::new();
        for id in &target.views {
            let view = doc.views.get(id);
            if view.is_some_and(|view| view.kind == ROOT_PDF) {
                continue;
            }
            if !is_document_view(view) {
                members.push(id.clone());
            } else if !members.contains(&slot) {
                members.push(slot.clone());
            }
        }
        if members.contains(&slot) {
            views.insert(slot.clone(), slot_record);
        }
        let selected = if is_document_view(doc.views.get(&target.selected)) {
            slot
        } else {
            target.selected.clone()
        };
        let selected = if members.contains(&selected) {
            selected
        } else {
            members.first().cloned().unwrap_or(selected)
        };
        PanelNode {
            id: target.id.clone(),
            views: members,
            selected,
        }
    });
    out.views = views;
    out
}

/// A layout's arrangement as a string that changes only when the
/// arrangement does: its splits and their weights, panels with their views
/// (documents by file, since re-placing a document gives its view a new id,
/// and slots alike, since a slot's id names its panel), floating windows and
/// hidden panels. Panel ids and selected tabs are left out.
pub fn layout_shape(doc: &LayoutDocument) -> String {
    use serde_json::{Value, json};
    let view = |id: &String| -> Value {
        let record = doc.views.get(id);
        if record.is_some_and(|record| record.kind == "file") {
            Value::String(format!("file:{}", file_key(record)))
        } else if is_document_slot(record) {
            Value::String("slot".into())
        } else {
            Value::String(id.clone())
        }
    };
    let panel = |target: &PanelNode| Value::Array(target.views.iter().map(view).collect());
    fn node(target: &LayoutNode, panel: &dyn Fn(&PanelNode) -> Value) -> Value {
        match target {
            LayoutNode::Panel(target) => panel(target),
            LayoutNode::Stage(stage) => {
                json!({ "stage": stage.child.as_deref().map(|child| node(child, panel)) })
            }
            LayoutNode::Split(split) => json!({
                if split.axis == Axis::X { "x" } else { "y" }:
                    split.children.iter().map(|child| node(child, panel)).collect::<Vec<_>>(),
                "weights": split.weights.iter().map(|weight| (weight * 1000.).round() as i64).collect::<Vec<_>>(),
            }),
        }
    }
    json!({
        "root": doc.root.as_ref().map(|root| node(root, &panel)),
        "floating": doc.floating.iter().map(|entry| json!({
            "rect": entry.rect, "z": entry.z, "layer": entry.layer, "views": panel(&entry.panel),
        })).collect::<Vec<_>>(),
        "hidden": doc.hidden.iter().map(|entry| json!({
            "restore": entry.restore, "views": panel(&entry.panel),
        })).collect::<Vec<_>>(),
    })
    .to_string()
}

/// Where each open document sat in a workspace (its panel, and whether it
/// was that panel's tab in front), so entering the workspace again puts it
/// back.
pub type DocumentPlaces = indexmap::IndexMap<String, Place>;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Place {
    pub panel: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub selected: bool,
}
