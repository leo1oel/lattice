// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/model/document.ts), with Lattice's patch
// (patches/@danfessler__trellis@0.2.0.patch: restoreAt, restoreInPlaceOf, repointHidden and the
// hidden tab's index).

//! Document operations: where a panel lives (docked, floating, hidden), and
//! the edits that move panels and views between those places.

use std::collections::HashSet;

use super::tree::{
    find_node, find_stage, insert_beside, normalize, panels_of, remove_node, replace_node,
};
use super::types::{
    Axis, Edge, FloatingLayer, FloatingPanel, HiddenPanel, LayoutDocument, LayoutNode, PanelNode,
    Rect, RestoreTarget, SplitNode, StageNode,
};

/// Short unique ids for panels and splits. Views may use caller-supplied ids.
pub fn uid(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = (COUNTER.fetch_add(1, Ordering::Relaxed) + 1) % 1_000_000;
    let random = random_base36(5);
    format!("{prefix}-{random}{}", to_base36(counter))
}

fn to_base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("ascii")
}

fn random_base36(len: usize) -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    let mut value = hasher.finish();
    let mut out = String::new();
    for _ in 0..len {
        out.push_str(&to_base36(value % 36));
        value /= 36;
    }
    out
}

pub fn empty_document() -> LayoutDocument {
    LayoutDocument::default()
}

#[derive(Clone, Debug, PartialEq)]
pub enum PanelLocation {
    Docked(PanelNode),
    Floating(PanelNode, FloatingPanel),
    Hidden(PanelNode, RestoreTarget),
}

impl PanelLocation {
    pub fn panel(&self) -> &PanelNode {
        match self {
            PanelLocation::Docked(p)
            | PanelLocation::Floating(p, _)
            | PanelLocation::Hidden(p, _) => p,
        }
    }

    pub fn is_hidden(&self) -> bool {
        matches!(self, PanelLocation::Hidden(..))
    }

    pub fn is_floating(&self) -> bool {
        matches!(self, PanelLocation::Floating(..))
    }
}

pub fn all_panels(doc: &LayoutDocument) -> Vec<&PanelNode> {
    let mut out = panels_of(doc.root.as_ref());
    out.extend(doc.floating.iter().map(|f| &f.panel));
    out.extend(doc.hidden.iter().map(|h| &h.panel));
    out
}

pub fn locate_panel(doc: &LayoutDocument, panel_id: &str) -> Option<PanelLocation> {
    if let Some(LayoutNode::Panel(panel)) = find_node(doc.root.as_ref(), panel_id) {
        return Some(PanelLocation::Docked(panel.clone()));
    }
    if let Some(float) = doc.floating.iter().find(|f| f.panel.id == panel_id) {
        return Some(PanelLocation::Floating(float.panel.clone(), float.clone()));
    }
    doc.hidden
        .iter()
        .find(|h| h.panel.id == panel_id)
        .map(|h| PanelLocation::Hidden(h.panel.clone(), h.restore.clone()))
}

pub fn panel_of_view<'a>(doc: &'a LayoutDocument, view_id: &str) -> Option<&'a PanelNode> {
    all_panels(doc)
        .into_iter()
        .find(|p| p.views.iter().any(|v| v == view_id))
}

/// Replace a panel wherever it lives. An empty panel is removed.
pub fn update_panel(doc: &LayoutDocument, mut panel: PanelNode) -> LayoutDocument {
    if panel.views.is_empty() {
        return remove_panel(doc, &panel.id);
    }
    if !panel.views.contains(&panel.selected) {
        panel.selected = panel.views[0].clone();
    }
    let Some(location) = locate_panel(doc, &panel.id) else {
        return doc.clone();
    };
    let mut out = doc.clone();
    match location {
        PanelLocation::Docked(_) => {
            let id = panel.id.clone();
            out.root = replace_node(doc.root.as_ref(), &id, &LayoutNode::Panel(panel));
        }
        PanelLocation::Floating(..) => {
            for f in &mut out.floating {
                if f.panel.id == panel.id {
                    f.panel = panel.clone();
                }
            }
        }
        PanelLocation::Hidden(..) => {
            for h in &mut out.hidden {
                if h.panel.id == panel.id {
                    h.panel = panel.clone();
                }
            }
        }
    }
    out
}

pub fn remove_panel(doc: &LayoutDocument, panel_id: &str) -> LayoutDocument {
    let Some(location) = locate_panel(doc, panel_id) else {
        return doc.clone();
    };
    let mut out = doc.clone();
    match location {
        PanelLocation::Docked(_) => out.root = remove_node(doc.root.as_ref(), panel_id),
        PanelLocation::Floating(..) => out.floating.retain(|f| f.panel.id != panel_id),
        PanelLocation::Hidden(..) => out.hidden.retain(|h| h.panel.id != panel_id),
    }
    out
}

/// Detach a view from its panel, keeping its record.
pub fn detach_view(doc: &LayoutDocument, view_id: &str) -> LayoutDocument {
    let Some(panel) = panel_of_view(doc, view_id).cloned() else {
        return doc.clone();
    };
    let views: Vec<String> = panel
        .views
        .iter()
        .filter(|id| *id != view_id)
        .cloned()
        .collect();
    let mut selected = panel.selected.clone();
    if selected == view_id {
        let index = panel.views.iter().position(|v| v == view_id).unwrap_or(0);
        selected = views
            .get(index.min(views.len().saturating_sub(1)))
            .cloned()
            .unwrap_or_default();
    }
    update_panel(
        doc,
        PanelNode {
            views,
            selected,
            ..panel
        },
    )
}

pub fn close_view(doc: &LayoutDocument, view_id: &str) -> LayoutDocument {
    let mut next = detach_view(doc, view_id);
    next.views.shift_remove(view_id);
    next
}

pub fn select_view(doc: &LayoutDocument, view_id: &str) -> LayoutDocument {
    let Some(panel) = panel_of_view(doc, view_id) else {
        return doc.clone();
    };
    if panel.selected == view_id {
        return doc.clone();
    }
    update_panel(
        doc,
        PanelNode {
            selected: view_id.to_string(),
            ..panel.clone()
        },
    )
}

pub fn add_tab(
    doc: &LayoutDocument,
    panel_id: &str,
    view_id: &str,
    index: Option<usize>,
    select: bool,
) -> LayoutDocument {
    let Some(location) = locate_panel(doc, panel_id) else {
        return doc.clone();
    };
    let panel = location.panel();
    let mut views: Vec<String> = panel
        .views
        .iter()
        .filter(|id| *id != view_id)
        .cloned()
        .collect();
    let at = index.map_or(views.len(), |i| i.min(views.len()));
    views.insert(at, view_id.to_string());
    let selected = if select || panel.selected.is_empty() {
        view_id.to_string()
    } else {
        panel.selected.clone()
    };
    update_panel(
        doc,
        PanelNode {
            views,
            selected,
            ..panel.clone()
        },
    )
}

pub fn reorder_tabs(doc: &LayoutDocument, panel_id: &str, order: &[String]) -> LayoutDocument {
    let Some(location) = locate_panel(doc, panel_id) else {
        return doc.clone();
    };
    let views = &location.panel().views;
    if order.len() != views.len() || order.iter().any(|id| !views.contains(id)) {
        return doc.clone();
    }
    update_panel(
        doc,
        PanelNode {
            views: order.to_vec(),
            ..location.panel().clone()
        },
    )
}

#[derive(Clone, Debug, PartialEq)]
pub enum DockTarget {
    Beside {
        beside: String,
        edge: Edge,
        share: Option<f64>,
    },
    Into {
        into: String,
        index: Option<usize>,
    },
}

/// Insert a panel that is not currently in the document.
pub fn insert_panel(
    doc: &LayoutDocument,
    panel: &PanelNode,
    target: &DockTarget,
) -> LayoutDocument {
    match target {
        DockTarget::Into { into, index } => {
            if let Some(LayoutNode::Stage(stage)) = find_node(doc.root.as_ref(), into) {
                match &stage.child {
                    None => {
                        let mut out = doc.clone();
                        out.root = replace_node(
                            doc.root.as_ref(),
                            &stage.id,
                            &LayoutNode::Stage(StageNode {
                                id: stage.id.clone(),
                                child: Some(Box::new(LayoutNode::Panel(panel.clone()))),
                            }),
                        );
                        return out;
                    }
                    Some(child) => {
                        let first = panels_of(Some(child))[0].id.clone();
                        return merge_into(doc, panel, &first, *index);
                    }
                }
            }
            merge_into(doc, panel, into, *index)
        }
        DockTarget::Beside {
            beside,
            edge,
            share,
        } => {
            let Some(root) = &doc.root else {
                let mut out = doc.clone();
                out.root = Some(LayoutNode::Panel(panel.clone()));
                return out;
            };
            if find_node(Some(root), beside).is_none() {
                return insert_panel(
                    doc,
                    panel,
                    &DockTarget::Beside {
                        beside: root.id().to_string(),
                        edge: *edge,
                        share: None,
                    },
                );
            }
            let mut out = doc.clone();
            out.root = Some(insert_beside(
                Some(root),
                beside,
                &LayoutNode::Panel(panel.clone()),
                *edge,
                &uid("split"),
                *share,
            ));
            out
        }
    }
}

fn merge_into(
    doc: &LayoutDocument,
    panel: &PanelNode,
    into_id: &str,
    index: Option<usize>,
) -> LayoutDocument {
    let Some(location) = locate_panel(doc, into_id) else {
        return doc.clone();
    };
    let mut views = location.panel().views.clone();
    let at = index.map_or(views.len(), |i| i.min(views.len()));
    for (offset, view) in panel.views.iter().enumerate() {
        views.insert(at + offset, view.clone());
    }
    update_panel(
        doc,
        PanelNode {
            views,
            selected: panel.selected.clone(),
            ..location.panel().clone()
        },
    )
}

pub fn float_panel(
    doc: &LayoutDocument,
    panel: &PanelNode,
    rect: Rect,
    layer: FloatingLayer,
) -> LayoutDocument {
    let z = doc.floating.iter().map(|f| f.z).fold(0f64, f64::max) + 1.;
    let mut out = remove_panel(doc, &panel.id);
    out.floating.push(FloatingPanel {
        panel: panel.clone(),
        rect: clamp_float(rect),
        z,
        layer,
    });
    out
}

pub fn clamp_float(rect: Rect) -> Rect {
    let w = rect.w.clamp(0.02, 1.);
    let h = rect.h.clamp(0.02, 1.);
    Rect {
        w,
        h,
        x: (1. - w.min(0.05)).min((-w + 0.05).max(rect.x)),
        y: (1. - h.min(0.05)).min(0f64.max(rect.y)),
    }
}

pub fn raise_float(doc: &LayoutDocument, panel_id: &str) -> LayoutDocument {
    let top = doc.floating.iter().map(|f| f.z).fold(0f64, f64::max);
    match doc.floating.iter().find(|f| f.panel.id == panel_id) {
        Some(float) if float.z != top => {
            let mut out = doc.clone();
            for f in &mut out.floating {
                if f.panel.id == panel_id {
                    f.z = top + 1.;
                }
            }
            out
        }
        _ => doc.clone(),
    }
}

/// Remember how to restore a docked panel: beside a surviving neighbour.
pub fn restore_target_for(doc: &LayoutDocument, panel_id: &str) -> Option<RestoreTarget> {
    let location = locate_panel(doc, panel_id)?;
    match location {
        PanelLocation::Floating(_, float) => {
            return Some(RestoreTarget::Floating {
                rect: float.rect,
                layer: float.layer,
            });
        }
        PanelLocation::Hidden(_, restore) => return Some(restore),
        PanelLocation::Docked(_) => {}
    }
    let Some(parent) = parent_split(doc.root.as_ref(), panel_id) else {
        if let Some(stage) = find_stage(doc.root.as_ref())
            && stage.child.as_ref().is_some_and(|c| c.id() == panel_id)
        {
            return Some(RestoreTarget::Tab {
                panel: stage.id.clone(),
                index: None,
            });
        }
        return Some(RestoreTarget::Docked {
            beside: doc
                .root
                .as_ref()
                .map(|r| r.id().to_string())
                .unwrap_or_default(),
            edge: Edge::Left,
            share: 0.5,
        });
    };
    let index = parent.children.iter().position(|c| c.id() == panel_id)?;
    let after = index + 1 < parent.children.len();
    let neighbour_index = if after { index + 1 } else { index - 1 };
    let neighbour = &parent.children[neighbour_index];
    // The neighbour absorbs this panel's space, so restore the same fraction
    // of their combined size.
    let own = parent.weights[index];
    let share = own / (own + parent.weights[neighbour_index]);
    let edge = match (parent.axis, after) {
        (Axis::X, true) => Edge::Left,
        (Axis::X, false) => Edge::Right,
        (Axis::Y, true) => Edge::Top,
        (Axis::Y, false) => Edge::Bottom,
    };
    Some(RestoreTarget::Docked {
        beside: neighbour.id().to_string(),
        edge,
        share,
    })
}

pub fn parent_split<'a>(root: Option<&'a LayoutNode>, id: &str) -> Option<&'a SplitNode> {
    match root? {
        LayoutNode::Panel(_) => None,
        LayoutNode::Stage(stage) => parent_split(stage.child.as_deref(), id),
        LayoutNode::Split(split) => {
            if split.children.iter().any(|c| c.id() == id) {
                return Some(split);
            }
            split
                .children
                .iter()
                .find_map(|c| parent_split(Some(c), id))
        }
    }
}

pub fn hide_panel(doc: &LayoutDocument, panel_id: &str) -> LayoutDocument {
    let Some(location) = locate_panel(doc, panel_id) else {
        return doc.clone();
    };
    if location.is_hidden() {
        return doc.clone();
    }
    let restore = restore_target_for(doc, panel_id).expect("a located panel has a restore target");
    let mut removed = remove_panel(doc, panel_id);
    removed.hidden.push(HiddenPanel {
        panel: location.panel().clone(),
        restore,
    });
    removed
}

pub fn restore_panel(
    doc: &LayoutDocument,
    panel_id: &str,
    fallback_layer: FloatingLayer,
) -> LayoutDocument {
    let Some(hidden) = doc.hidden.iter().find(|h| h.panel.id == panel_id).cloned() else {
        return doc.clone();
    };
    let mut without = doc.clone();
    without.hidden.retain(|h| h.panel.id != panel_id);
    restore_at(
        &without,
        &hidden.panel,
        &hidden.restore,
        fallback_layer,
        &mut HashSet::new(),
    )
}

fn restore_at(
    doc: &LayoutDocument,
    panel: &PanelNode,
    restore: &RestoreTarget,
    fallback_layer: FloatingLayer,
    seen: &mut HashSet<String>,
) -> LayoutDocument {
    if let RestoreTarget::Floating { rect, layer } = restore {
        return float_panel(doc, panel, *rect, *layer);
    }
    if let Some(in_place) = restore_in_place_of(doc, panel, restore, fallback_layer, seen) {
        return in_place;
    }
    if let RestoreTarget::Tab {
        panel: target,
        index,
    } = restore
    {
        let located = locate_panel(doc, target);
        let node = find_node(doc.root.as_ref(), target);
        // Lattice patch: a tab hidden out of a group comes back where it was
        // in it, not at the end (insert_panel clamps an index past the last
        // tab).
        if located.is_some_and(|l| !l.is_hidden()) || node.is_some_and(LayoutNode::is_stage) {
            let next = insert_panel(
                doc,
                panel,
                &DockTarget::Into {
                    into: target.clone(),
                    index: *index,
                },
            );
            let to = panel_of_view(&next, &panel.views[0]).map(|p| p.id.clone());
            return repoint_hidden(next, &panel.id, to.as_deref());
        }
    }
    if let RestoreTarget::Docked {
        beside,
        edge,
        share,
    } = restore
        && find_node(doc.root.as_ref(), beside).is_some()
    {
        return insert_panel(
            doc,
            panel,
            &DockTarget::Beside {
                beside: beside.clone(),
                edge: *edge,
                share: Some(*share),
            },
        );
    }
    if doc.root.is_some() {
        return float_panel(doc, panel, Rect::new(0.25, 0.2, 0.5, 0.6), fallback_layer);
    }
    let mut out = doc.clone();
    out.root = Some(LayoutNode::Panel(panel.clone()));
    out
}

/// Lattice patch: a panel whose place was in, or beside, a panel that is
/// hidden too (a column hidden one panel at a time) used to float over the
/// documents. Now, if that hidden panel will rejoin another as tabs, this
/// one comes back in or beside that other one. Otherwise this one takes the
/// hidden panel's place (floating, if it was a tab of a floating window) and
/// the hidden panel is re-anchored to it the way this one sat against it:
/// its tabs will rejoin this group, or it will dock on the opposite edge. Any
/// show order rebuilds the layout the hide order took apart.
fn restore_in_place_of(
    doc: &LayoutDocument,
    panel: &PanelNode,
    restore: &RestoreTarget,
    fallback_layer: FloatingLayer,
    seen: &mut HashSet<String>,
) -> Option<LayoutDocument> {
    let anchor_id = match restore {
        RestoreTarget::Tab { panel, .. } => panel.clone(),
        RestoreTarget::Docked { beside, .. } => beside.clone(),
        RestoreTarget::Floating { .. } => return None,
    };
    let anchor = doc.hidden.iter().find(|h| h.panel.id == anchor_id)?;
    if seen.contains(&anchor_id) {
        return None;
    }
    seen.insert(anchor_id.clone());
    let place = anchor.restore.clone();
    if let RestoreTarget::Tab {
        panel: place_panel,
        index: place_index,
    } = &place
    {
        let through = match restore {
            RestoreTarget::Tab { .. } => RestoreTarget::Tab {
                panel: place_panel.clone(),
                index: *place_index,
            },
            RestoreTarget::Docked { edge, share, .. } => RestoreTarget::Docked {
                beside: place_panel.clone(),
                edge: *edge,
                share: *share,
            },
            RestoreTarget::Floating { .. } => unreachable!(),
        };
        return Some(restore_at(doc, panel, &through, fallback_layer, seen));
    }
    if matches!(restore, RestoreTarget::Docked { .. })
        && matches!(place, RestoreTarget::Floating { .. })
    {
        return None;
    }
    let next = restore_at(doc, panel, &place, fallback_layer, seen);
    let id = panel_of_view(&next, &panel.views[0])
        .map(|p| p.id.clone())
        .unwrap_or_else(|| panel.id.clone());
    let back = match restore {
        RestoreTarget::Tab { index, .. } => RestoreTarget::Tab {
            panel: id,
            index: if index.is_some_and(|i| i != 0) {
                Some(0)
            } else {
                None
            },
        },
        RestoreTarget::Docked { edge, share, .. } => RestoreTarget::Docked {
            beside: id,
            edge: edge.opposite(),
            share: 1. - share,
        },
        RestoreTarget::Floating { .. } => unreachable!(),
    };
    let mut out = next;
    for h in &mut out.hidden {
        if h.panel.id == anchor_id {
            h.restore = back.clone();
        }
    }
    Some(out)
}

/// Lattice patch: a hidden panel that joined another as a tab is gone, so the
/// panels hidden in or beside it come back in or beside the one it joined.
fn repoint_hidden(mut doc: LayoutDocument, from: &str, to: Option<&str>) -> LayoutDocument {
    let Some(to) = to.filter(|to| *to != from) else {
        return doc;
    };
    for h in &mut doc.hidden {
        match &mut h.restore {
            RestoreTarget::Tab { panel, .. } if panel == from => *panel = to.to_string(),
            RestoreTarget::Docked { beside, .. } if beside == from => *beside = to.to_string(),
            _ => {}
        }
    }
    doc
}

/// Repair anything inconsistent in a document from storage or a caller.
pub fn sanitize(input: &LayoutDocument, is_known_type: &dyn Fn(&str) -> bool) -> LayoutDocument {
    let mut doc = LayoutDocument {
        schema: 1,
        version: input.version.clone(),
        root: input.root.clone(),
        floating: input.floating.clone(),
        hidden: input.hidden.clone(),
        views: input.views.clone(),
        navigation: input.navigation.clone(),
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut seen_panels: HashSet<String> = HashSet::new();
    let views = doc.views.clone();
    let keep = |id: &String, seen: &mut HashSet<String>| -> bool {
        let Some(record) = views.get(id) else {
            return false;
        };
        if seen.contains(id) || !is_known_type(&record.kind) {
            return false;
        }
        seen.insert(id.clone());
        true
    };
    let fix_panel = |panel: &PanelNode,
                     seen: &mut HashSet<String>,
                     seen_panels: &mut HashSet<String>|
     -> Option<PanelNode> {
        if seen_panels.contains(&panel.id) {
            return None;
        }
        seen_panels.insert(panel.id.clone());
        let views: Vec<String> = panel
            .views
            .iter()
            .filter(|id| keep(id, seen))
            .cloned()
            .collect();
        if views.is_empty() {
            return None;
        }
        let selected = if views.contains(&panel.selected) {
            panel.selected.clone()
        } else {
            views[0].clone()
        };
        Some(PanelNode {
            id: panel.id.clone(),
            views,
            selected,
        })
    };
    let mut stages = 0;
    fn fix_node(
        node: &LayoutNode,
        stages: &mut usize,
        fix_panel: &mut dyn FnMut(&PanelNode) -> Option<PanelNode>,
    ) -> Option<LayoutNode> {
        match node {
            LayoutNode::Panel(panel) => fix_panel(panel).map(LayoutNode::Panel),
            LayoutNode::Stage(stage) => {
                let first = *stages == 0;
                *stages += 1;
                if !first {
                    return stage
                        .child
                        .as_ref()
                        .and_then(|child| fix_node(child, stages, fix_panel));
                }
                let child = stage
                    .child
                    .as_ref()
                    .and_then(|child| fix_node(child, stages, fix_panel));
                Some(LayoutNode::Stage(StageNode {
                    id: stage.id.clone(),
                    child: child.filter(|c| !c.is_stage()).map(Box::new),
                }))
            }
            LayoutNode::Split(split) => {
                let mut children = Vec::new();
                let mut weights = Vec::new();
                for (i, child) in split.children.iter().enumerate() {
                    if let Some(fixed) = fix_node(child, stages, fix_panel) {
                        children.push(fixed);
                        let w = split.weights.get(i).copied().unwrap_or(f64::NAN);
                        weights.push(if w.is_finite() && w > 0. { w } else { 1. });
                    }
                }
                if children.is_empty() {
                    return None;
                }
                normalize(LayoutNode::Split(SplitNode {
                    id: split.id.clone(),
                    axis: split.axis,
                    weights,
                    children,
                }))
            }
        }
    }
    let root = doc.root.take();
    doc.root = root
        .as_ref()
        .and_then(|root| {
            fix_node(root, &mut stages, &mut |panel| {
                fix_panel(panel, &mut seen, &mut seen_panels)
            })
        })
        .and_then(normalize);
    doc.floating = doc
        .floating
        .iter()
        .filter_map(|f| {
            let panel = fix_panel(&f.panel, &mut seen, &mut seen_panels)?;
            Some(FloatingPanel {
                panel,
                rect: clamp_float(f.rect),
                z: if f.z.is_finite() { f.z } else { 1. },
                layer: f.layer,
            })
        })
        .collect();
    doc.hidden = doc
        .hidden
        .iter()
        .filter_map(|h| {
            let panel = fix_panel(&h.panel, &mut seen, &mut seen_panels)?;
            Some(HiddenPanel {
                panel,
                restore: h.restore.clone(),
            })
        })
        .collect();
    doc.views.retain(|id, _| seen.contains(id));
    doc
}

pub fn view_ids(doc: &LayoutDocument) -> Vec<String> {
    all_panels(doc)
        .into_iter()
        .flat_map(|p| p.views.iter().cloned())
        .collect()
}
