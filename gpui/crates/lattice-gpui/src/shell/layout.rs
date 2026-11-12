//! The window's arrangement of panels as plain data: what the named
//! workspaces save, what the Writing and Reading presets lay over a project,
//! and what each project remembers (`src/trellis/trellis-layout.ts`).
//!
//! GPUI Kit's dock holds the live layout; an [`Arrangement`] is read from it
//! (`read`) and installed into it (`install`) through the panels the window
//! owns. Kit's dock has a center and three docks where Trellis has one tree,
//! so the Tauri app's default row (Project and the Agent over Papers, the
//! documents, the PDF) becomes a left dock, the center and a right dock, at
//! the same proportions of the window.
//!
//! A workspace holds the arrangement only, never documents: each group that
//! held documents keeps a [`View::Documents`] slot where the open documents
//! go when the workspace is loaded. A project's own layout names its
//! documents, and differs from its workspace (the dirty dot) while its
//! arrangement does.

use std::{collections::BTreeMap, path::Path};

use gpui::Pixels;
use gpui_kit::component::dock::DockPlacement;
use serde::{Deserialize, Serialize};

mod kit;
mod presets;

pub use kit::{describe, read};
pub use presets::{Preset, return_layout};

/// The Tauri app's default row (`defaultLayout` in trellis-layout.ts): the
/// navigators' column takes 0.36 and the PDF 0.64 of the width, and the
/// first document takes 0.46 of it beside the navigators, the others keeping
/// their proportions (`withDocumentPanel`).
const NAVIGATOR_SHARE: f32 = 0.36 * (1. - DOCUMENT_SHARE);
const PDF_SHARE: f32 = 0.64 * (1. - DOCUMENT_SHARE);
const DOCUMENT_SHARE: f32 = 0.46;
/// Project and the Agent over Papers.
const PROJECT_SHARE: f32 = 0.62;
/// The chrome around the cards and between them: 12px at the window's sides
/// and 6px between cards (each group pads itself by half of that).
const WINDOW_SIDES: f32 = 24.;
const GUTTER: f32 = 6.;
/// A preset's two halves.
const PRESET_SHARE: f32 = 0.5;

/// One tab in an arrangement.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum View {
    Project,
    Papers,
    Agent,
    Pdf,
    Build,
    /// A document, by its path relative to the project.
    File(String),
    /// Where the open documents go, in a workspace's saved arrangement.
    Documents,
}

impl View {
    pub fn is_document(&self) -> bool {
        matches!(self, View::File(_) | View::Documents)
    }

    /// A paper or PDF the Reading preset puts with the Papers library; every
    /// other document is written (`isReading` in trellis-layout.ts).
    fn is_reading(&self) -> bool {
        matches!(self, View::File(path) if path.to_ascii_lowercase().ends_with(".pdf"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SplitAxis {
    /// Children side by side.
    Row,
    /// Children stacked.
    Column,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Node {
    Split {
        axis: SplitAxis,
        children: Vec<Node>,
        /// Each child's size in pixels, `None` where it takes what is left.
        sizes: Vec<Option<f32>>,
    },
    Tabs {
        views: Vec<View>,
        active: usize,
    },
}

impl Node {
    pub fn tabs(views: impl IntoIterator<Item = View>) -> Node {
        Node::Tabs {
            views: views.into_iter().collect(),
            active: 0,
        }
    }

    fn empty() -> Node {
        Node::Split {
            axis: SplitAxis::Column,
            children: Vec::new(),
            sizes: Vec::new(),
        }
    }

    pub fn views(&self) -> Vec<&View> {
        let mut out = Vec::new();
        self.walk_views(&mut |view| out.push(view));
        out
    }

    fn walk_views<'a>(&'a self, f: &mut impl FnMut(&'a View)) {
        match self {
            Node::Split { children, .. } => children.iter().for_each(|child| child.walk_views(f)),
            Node::Tabs { views, .. } => views.iter().for_each(f),
        }
    }

    /// The node with every view `keep` refuses taken out, and groups and
    /// splits left empty dropped.
    fn retain(self, keep: &mut impl FnMut(&View) -> bool) -> Option<Node> {
        match self {
            Node::Tabs { views, active } => {
                let active_view = views.get(active).cloned();
                let views: Vec<View> = views.into_iter().filter(|view| keep(view)).collect();
                if views.is_empty() {
                    return None;
                }
                let active = active_view
                    .and_then(|view| views.iter().position(|v| *v == view))
                    .unwrap_or(0);
                Some(Node::Tabs { views, active })
            }
            Node::Split {
                axis,
                children,
                sizes,
            } => {
                let (children, sizes): (Vec<Node>, Vec<Option<f32>>) = children
                    .into_iter()
                    .zip(sizes.into_iter().chain(std::iter::repeat(None)))
                    .filter_map(|(child, size)| child.retain(keep).map(|child| (child, size)))
                    .unzip();
                match children.len() {
                    0 => None,
                    1 => children.into_iter().next(),
                    _ => Some(Node::Split {
                        axis,
                        children,
                        sizes,
                    }),
                }
            }
        }
    }

    /// Each group's documents folded into one [`View::Documents`] slot,
    /// where its first document stood.
    fn as_arrangement(&self) -> Node {
        match self {
            Node::Tabs { views, active } => {
                let selected_document = views.get(*active).is_some_and(View::is_document);
                let mut out = Vec::new();
                for view in views {
                    let view = if view.is_document() {
                        View::Documents
                    } else {
                        view.clone()
                    };
                    if !out.contains(&view) {
                        out.push(view);
                    }
                }
                let active = if selected_document {
                    out.iter().position(|v| *v == View::Documents)
                } else {
                    views
                        .get(*active)
                        .and_then(|v| out.iter().position(|o| o == v))
                }
                .unwrap_or(0);
                Node::Tabs { views: out, active }
            }
            Node::Split {
                axis,
                children,
                sizes,
            } => Node::Split {
                axis: *axis,
                children: children.iter().map(Node::as_arrangement).collect(),
                sizes: sizes.clone(),
            },
        }
    }

    /// The node as a string that changes only when the arrangement does:
    /// splits and their sizes to the pixel, groups and their views.
    fn shape(&self, out: &mut String) {
        match self {
            Node::Tabs { views, .. } => {
                out.push('[');
                for view in views {
                    out.push_str(&format!("{view:?},"));
                }
                out.push(']');
            }
            Node::Split {
                axis,
                children,
                sizes,
            } => {
                out.push_str(match axis {
                    SplitAxis::Row => "row(",
                    SplitAxis::Column => "col(",
                });
                for (ix, child) in children.iter().enumerate() {
                    if let Some(Some(size)) = sizes.get(ix) {
                        out.push_str(&format!("{}:", size.round()));
                    }
                    child.shape(out);
                    out.push(',');
                }
                out.push(')');
            }
        }
    }

    /// The first group holding a view `matches` takes `view` too.
    fn add_beside(&mut self, view: View, matches: &impl Fn(&View) -> bool) -> bool {
        match self {
            Node::Tabs { views, active } => {
                if views.iter().any(matches) {
                    if let Some(ix) = views.iter().position(matches) {
                        views.insert(ix + 1, view);
                        *active = ix + 1;
                    } else {
                        views.push(view);
                    }
                    true
                } else {
                    false
                }
            }
            Node::Split { children, .. } => children
                .iter_mut()
                .any(|child| child.add_beside(view.clone(), matches)),
        }
    }

    fn first_group_mut(&mut self) -> Option<&mut Node> {
        match self {
            Node::Tabs { .. } => Some(self),
            Node::Split { children, .. } => children.iter_mut().find_map(Node::first_group_mut),
        }
    }

    fn select(&mut self, view: &View) {
        match self {
            Node::Tabs { views, active } => {
                if let Some(ix) = views.iter().position(|v| v == view) {
                    *active = ix;
                }
            }
            Node::Split { children, .. } => children.iter_mut().for_each(|c| c.select(view)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Dock {
    pub node: Node,
    pub size: f32,
    pub open: bool,
}

/// The window's panels as data: the center, the three docks and the
/// floating layer.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Arrangement {
    pub center: Node,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<Dock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<Dock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottom: Option<Dock>,
    /// Panels floating over the workspace, frontmost last.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub floating: Vec<FloatingView>,
}

/// A panel floating over the workspace, and where it stands within the
/// workspace area.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FloatingView {
    pub view: View,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Default for Node {
    fn default() -> Self {
        Node::empty()
    }
}

/// The workspace area's size: the window less the titlebar and the chrome
/// around the cards.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Room {
    pub width: f32,
    pub height: f32,
}

impl Room {
    pub fn for_window(width: Pixels, height: Pixels) -> Room {
        Room {
            width: f32::from(width),
            height: f32::from(height),
        }
    }

    /// The cards' total width, with the gutters between three of them taken
    /// out, as Trellis shares a row.
    fn row(&self) -> f32 {
        (self.width - WINDOW_SIDES - 2. * GUTTER).max(0.)
    }

    /// The docks' height: the window less the 40px titlebar and the chrome
    /// above and below the cards (less the groups' own half-gutters).
    pub fn column(&self) -> f32 {
        (self.height - 40. - 3. - 9.).max(0.)
    }

    /// The dock area's width: the window less the chrome at its sides (less
    /// the groups' own half-gutters).
    pub fn area(&self) -> f32 {
        (self.width - 18.).max(0.)
    }
}

impl Arrangement {
    /// The Tauri app's default layout at `room`'s size.
    pub fn default_for(room: Room) -> Arrangement {
        let column = room.column();
        Arrangement {
            center: Node::tabs([View::Documents]),
            left: Some(Dock {
                node: Node::Split {
                    axis: SplitAxis::Column,
                    children: vec![
                        Node::tabs([View::Project, View::Agent]),
                        Node::tabs([View::Papers]),
                    ],
                    sizes: vec![Some((column * PROJECT_SHARE).round()), None],
                },
                size: (room.row() * NAVIGATOR_SHARE).round() + GUTTER,
                open: true,
            }),
            right: Some(Dock {
                node: Node::tabs([View::Pdf]),
                size: (room.row() * PDF_SHARE).round() + GUTTER,
                open: true,
            }),
            bottom: None,
            floating: Vec::new(),
        }
    }

    pub fn docks(&self) -> [(DockPlacement, Option<&Dock>); 3] {
        [
            (DockPlacement::Left, self.left.as_ref()),
            (DockPlacement::Right, self.right.as_ref()),
            (DockPlacement::Bottom, self.bottom.as_ref()),
        ]
    }

    fn nodes_mut(&mut self) -> impl Iterator<Item = &mut Node> {
        std::iter::once(&mut self.center).chain(
            [&mut self.left, &mut self.right, &mut self.bottom]
                .into_iter()
                .flatten()
                .map(|dock| &mut dock.node),
        )
    }

    pub fn views(&self) -> Vec<&View> {
        let mut out = self.center.views();
        for (_, dock) in self.docks() {
            if let Some(dock) = dock {
                out.extend(dock.node.views());
            }
        }
        out.extend(self.floating.iter().map(|floating| &floating.view));
        out
    }

    pub fn contains(&self, view: &View) -> bool {
        self.views().contains(&view)
    }

    /// The arrangement a workspace saves: documents folded into slots.
    pub fn as_workspace(&self) -> Arrangement {
        let mut out = self.clone();
        for node in out.nodes_mut() {
            *node = node.as_arrangement();
        }
        out.floating.retain(|floating| !floating.view.is_document());
        // Somewhere for documents to go: the center.
        out.add_view(View::Documents, |_| false);
        out
    }

    /// A string that changes only when the arrangement does: the dirty dot
    /// compares the project's against its workspace's.
    pub fn shape(&self) -> String {
        let arrangement = self.as_workspace();
        let mut out = String::from("center:");
        arrangement.center.shape(&mut out);
        for (placement, dock) in arrangement.docks() {
            if let Some(dock) = dock {
                out.push_str(&format!(
                    ";{placement:?}:{}:{}:",
                    dock.size.round(),
                    dock.open
                ));
                dock.node.shape(&mut out);
            }
        }
        if !arrangement.floating.is_empty() {
            let mut floating: Vec<String> = arrangement
                .floating
                .iter()
                .map(|floating| format!("{:?}", floating.view))
                .collect();
            floating.sort();
            out.push_str(&format!(";floating:{}", floating.join(",")));
        }
        out
    }

    /// This workspace arrangement filled with `documents` (in tab order),
    /// `active` selected. A document goes where `places` says it stood in
    /// this workspace, else into the first documents slot; slots no
    /// document fills are taken out, and a group left empty with them.
    pub fn with_documents(
        &self,
        documents: &[String],
        active: Option<&str>,
        places: &BTreeMap<String, usize>,
    ) -> Arrangement {
        let mut out = self.clone();
        // A place this workspace has no slot for counts as no place.
        let slots = self
            .views()
            .into_iter()
            .filter(|view| **view == View::Documents)
            .count();
        let places: BTreeMap<String, usize> = places
            .iter()
            .filter(|(_, place)| **place < slots)
            .map(|(doc, place)| (doc.clone(), *place))
            .collect();
        // Number the slots in reading order, center first.
        let mut slot = 0;
        let mut first_slot = None;
        for node in out.nodes_mut() {
            fill_slots(node, &mut slot, &mut first_slot, documents, &places);
        }
        let mut keep = |view: &View| *view != View::Documents;
        out.center = std::mem::take(&mut out.center)
            .retain(&mut keep)
            .unwrap_or_default();
        for dock in [&mut out.left, &mut out.right, &mut out.bottom] {
            if let Some(d) = dock.take() {
                *dock = d.node.retain(&mut keep).map(|node| Dock { node, ..d });
            }
        }
        if let Some(active) = active {
            let view = View::File(active.to_string());
            for node in out.nodes_mut() {
                node.select(&view);
            }
        }
        out
    }

    /// Where each document stands, as the slot index `with_documents` reads.
    pub fn places(&self) -> BTreeMap<String, usize> {
        let mut places = BTreeMap::new();
        let mut slot = 0;
        let mut out = self.clone();
        for node in out.nodes_mut() {
            record_places(node, &mut slot, &mut places);
        }
        places
    }

    /// `view` added beside the first view `beside` matches, else into the
    /// center's first group, else as the center.
    pub fn add_view(&mut self, view: View, beside: impl Fn(&View) -> bool) {
        if self.contains(&view) {
            return;
        }
        for node in self.nodes_mut() {
            if node.add_beside(view.clone(), &beside) {
                return;
            }
        }
        match self.center.first_group_mut() {
            Some(Node::Tabs { views, active }) => {
                views.push(view);
                *active = views.len() - 1;
            }
            _ => self.center = Node::tabs([view]),
        }
    }

    /// The arrangement without `view`.
    pub fn without(&self, view: &View) -> Arrangement {
        let mut out = self.clone();
        out.floating.retain(|floating| floating.view != *view);
        let mut keep = |v: &View| v != view;
        out.center = std::mem::take(&mut out.center)
            .retain(&mut keep)
            .unwrap_or_default();
        for dock in [&mut out.left, &mut out.right, &mut out.bottom] {
            if let Some(d) = dock.take() {
                *dock = d.node.retain(&mut keep).map(|node| Dock { node, ..d });
            }
        }
        out
    }

    /// The project's documents, in the order the arrangement holds them.
    pub fn documents(&self) -> Vec<String> {
        self.views()
            .into_iter()
            .filter_map(|view| match view {
                View::File(path) => Some(path.clone()),
                _ => None,
            })
            .collect()
    }
}

fn fill_slots(
    node: &mut Node,
    slot: &mut usize,
    first_slot: &mut Option<usize>,
    documents: &[String],
    places: &BTreeMap<String, usize>,
) {
    match node {
        Node::Split { children, .. } => children
            .iter_mut()
            .for_each(|child| fill_slots(child, slot, first_slot, documents, places)),
        Node::Tabs { views, active } => {
            let Some(at) = views.iter().position(|v| *v == View::Documents) else {
                return;
            };
            let this = *slot;
            *slot += 1;
            let first = *first_slot.get_or_insert(this);
            let here: Vec<View> = documents
                .iter()
                .filter(|doc| match places.get(*doc) {
                    Some(place) => *place == this,
                    None => this == first,
                })
                .map(|doc| View::File(doc.clone()))
                .collect();
            let selected_slot = *active == at;
            let count = here.len();
            views.splice(at..at, here);
            if selected_slot || *active > at {
                *active += if selected_slot { 0 } else { count };
            }
        }
    }
}

fn record_places(node: &mut Node, slot: &mut usize, places: &mut BTreeMap<String, usize>) {
    match node {
        Node::Split { children, .. } => children
            .iter_mut()
            .for_each(|child| record_places(child, slot, places)),
        Node::Tabs { views, .. } => {
            if views.iter().any(View::is_document) {
                for view in views.iter() {
                    if let View::File(path) = view {
                        places.insert(path.clone(), *slot);
                    }
                }
                *slot += 1;
            }
        }
    }
}

/// `path` relative to the project, as an arrangement names a document.
pub fn document_key(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room() -> Room {
        Room {
            width: 1440.,
            height: 900.,
        }
    }

    fn file(path: &str) -> View {
        View::File(path.into())
    }

    #[test]
    fn the_default_layout_matches_the_tauri_apps_proportions() {
        let layout = Arrangement::default_for(room());
        // A 485px PDF card and its 6px of gutter, as the Main window draws it.
        assert_eq!(layout.right.as_ref().unwrap().size, 491.);
        // The navigators' column: 0.36 of the 54% the first document leaves.
        assert_eq!(layout.left.as_ref().unwrap().size, 279.);
        // Project and the Agent take 62% of the column, over Papers.
        let Node::Split {
            sizes, children, ..
        } = &layout.left.as_ref().unwrap().node
        else {
            panic!("the left dock is a column");
        };
        assert_eq!(sizes[0], Some(526.));
        assert_eq!(
            children[0],
            Node::tabs([View::Project, View::Agent]),
            "Project shares its group with the Agent"
        );
    }

    #[test]
    fn a_workspace_keeps_the_arrangement_not_the_documents() {
        let mut layout = Arrangement::default_for(room());
        layout.center = Node::Tabs {
            views: vec![file("main.tex"), file("intro.tex")],
            active: 1,
        };
        let workspace = layout.as_workspace();
        assert_eq!(
            workspace.center,
            Node::Tabs {
                views: vec![View::Documents],
                active: 0
            }
        );
        assert_eq!(workspace.shape(), layout.shape());
    }

    #[test]
    fn a_panel_alone_in_the_center_stays_in_the_workspace_it_is_saved_to() {
        // Build dragged beside a document, then the document closed.
        let mut layout = Arrangement::default_for(room());
        layout.center = Node::tabs([View::Build]);
        let workspace = layout.as_workspace();
        assert!(workspace.contains(&View::Build));
        assert!(workspace.contains(&View::Documents));
        // Loaded with a document, the workspace brings Build back too.
        let filled = workspace.with_documents(&["main.tex".into()], None, &BTreeMap::new());
        assert!(filled.contains(&View::Build) && filled.contains(&file("main.tex")));
        let mut without_build = layout.clone();
        without_build.center = Node::empty();
        assert_ne!(layout.shape(), without_build.shape());
    }

    #[test]
    fn resizing_a_dock_makes_the_layout_differ_from_its_workspace() {
        let layout = Arrangement::default_for(room());
        let mut wider = layout.clone();
        wider.left.as_mut().unwrap().size = 335.;
        assert_ne!(layout.shape(), wider.shape());
        // Under a pixel is not a change.
        let mut nudged = layout.clone();
        nudged.left.as_mut().unwrap().size += 0.3;
        assert_eq!(layout.shape(), nudged.shape());
    }

    #[test]
    fn documents_return_to_where_they_stood_in_the_workspace() {
        let mut workspace = Arrangement::default_for(room()).as_workspace();
        workspace.center = Node::Split {
            axis: SplitAxis::Row,
            children: vec![Node::tabs([View::Documents]), Node::tabs([View::Documents])],
            sizes: vec![Some(400.), None],
        };
        let places = BTreeMap::from([("b.tex".to_string(), 1)]);
        let filled = workspace.with_documents(
            &["a.tex".into(), "b.tex".into(), "c.tex".into()],
            Some("c.tex"),
            &places,
        );
        let Node::Split { children, .. } = &filled.center else {
            panic!("the center stays split");
        };
        assert_eq!(
            children[0],
            Node::Tabs {
                views: vec![file("a.tex"), file("c.tex")],
                active: 1
            }
        );
        assert_eq!(children[1], Node::tabs([file("b.tex")]));
        assert_eq!(
            filled.places(),
            BTreeMap::from([
                ("a.tex".to_string(), 0),
                ("b.tex".to_string(), 1),
                ("c.tex".to_string(), 0),
            ])
        );
    }

    #[test]
    fn a_slot_no_document_fills_leaves_with_its_group() {
        let workspace = Arrangement::default_for(room());
        let filled = workspace.with_documents(&[], None, &BTreeMap::new());
        assert_eq!(filled.center, Node::default());
        assert!(!filled.contains(&View::Documents));
    }

    #[test]
    fn an_arrangement_round_trips_through_json() {
        let layout = Arrangement::default_for(room());
        let json = serde_json::to_string(&layout).unwrap();
        assert_eq!(serde_json::from_str::<Arrangement>(&json).unwrap(), layout);
    }

    fn floating(view: View) -> FloatingView {
        FloatingView {
            view,
            x: 600.,
            y: 72.,
            width: 420.,
            height: 480.,
        }
    }

    #[test]
    fn a_floating_panel_differs_from_its_workspace_until_reverted() {
        let workspace = Arrangement::default_for(room()).as_workspace();
        let documents = vec!["main.tex".to_string()];
        let project = workspace.with_documents(&documents, Some("main.tex"), &BTreeMap::new());
        assert_eq!(project.shape(), workspace.shape());

        let mut floated = project.without(&View::Pdf);
        floated.floating.push(floating(View::Pdf));
        assert_ne!(floated.shape(), workspace.shape());

        // Revert: the workspace as saved, the project's documents in it.
        let reverted =
            workspace.with_documents(&floated.documents(), Some("main.tex"), &floated.places());
        assert!(reverted.floating.is_empty());
        assert!(
            reverted
                .right
                .as_ref()
                .is_some_and(|dock| dock.node.views() == [&View::Pdf])
        );
        assert_eq!(reverted.shape(), workspace.shape());
    }

    #[test]
    fn a_workspace_keeps_floating_panels_but_not_floating_documents() {
        let mut project = Arrangement::default_for(room()).without(&View::Pdf);
        project.floating = vec![floating(View::Pdf), floating(file("notes.md"))];
        let workspace = project.as_workspace();
        assert_eq!(workspace.floating, vec![floating(View::Pdf)]);
        assert_eq!(project.documents(), vec!["notes.md".to_string()]);
    }

    #[test]
    fn a_layout_with_floating_panels_is_saved_and_read_back() {
        let mut layout = Arrangement::default_for(room()).without(&View::Agent);
        layout.floating.push(floating(View::Agent));
        let json = serde_json::to_string(&layout).unwrap();
        assert_eq!(serde_json::from_str::<Arrangement>(&json).unwrap(), layout);
    }

    #[test]
    fn a_place_beyond_the_workspaces_slots_lands_in_the_first() {
        // The default workspace has one documents slot; b.tex last stood in a
        // second group the workspace no longer has.
        let workspace = Arrangement::default_for(room()).as_workspace();
        let documents = vec!["a.tex".to_string(), "b.tex".to_string()];
        let places = BTreeMap::from([("a.tex".to_string(), 0), ("b.tex".to_string(), 1)]);
        let filled = workspace.with_documents(&documents, Some("b.tex"), &places);
        assert_eq!(filled.documents(), documents);
        assert_eq!(filled.center.views(), [&file("a.tex"), &file("b.tex")]);
    }
}
