// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/model/builder.ts).

//! Authoring nodes: a readable way to describe an initial layout, compiled
//! into a document.

use std::collections::{BTreeMap, HashMap, HashSet};

use super::document::uid;
use super::tree::normalize;
use super::types::{
    Axis, FloatingLayer, FloatingPanel, LayoutDocument, LayoutNode, PanelNode, Params, Rect,
    SplitNode, StageNode, ViewRecord,
};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ViewSpec {
    pub kind: String,
    pub id: Option<String>,
    pub params: Option<Params>,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PanelSpec {
    pub id: Option<String>,
    pub views: Vec<ViewSpec>,
    /// Index of the initially selected view.
    pub selected: Option<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SplitSpec {
    pub id: Option<String>,
    pub axis: Axis,
    pub children: Vec<LayoutSpec>,
    pub weights: Option<Vec<f64>>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StageSpec {
    pub id: Option<String>,
    pub child: Option<Box<LayoutSpec>>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LayoutSpec {
    View(ViewSpec),
    Panel(PanelSpec),
    Split(SplitSpec),
    Stage(StageSpec),
}

#[derive(Clone, Debug, PartialEq)]
pub struct FloatSpec {
    pub panel: LayoutSpec,
    pub rect: Rect,
    pub layer: Option<FloatingLayer>,
}

/// `layout.*` from Trellis: shorthands for the specs.
pub mod layout {
    use super::*;

    pub fn view(kind: &str) -> ViewSpec {
        ViewSpec {
            kind: kind.into(),
            ..Default::default()
        }
    }

    pub fn view_with_id(kind: &str, id: &str) -> LayoutSpec {
        LayoutSpec::View(ViewSpec {
            kind: kind.into(),
            id: Some(id.into()),
            ..Default::default()
        })
    }

    pub fn panel(views: Vec<ViewSpec>) -> LayoutSpec {
        LayoutSpec::Panel(PanelSpec {
            views,
            ..Default::default()
        })
    }

    pub fn split(axis: Axis, children: Vec<LayoutSpec>, weights: Option<Vec<f64>>) -> LayoutSpec {
        LayoutSpec::Split(SplitSpec {
            id: None,
            axis,
            children,
            weights,
        })
    }

    pub fn row(children: Vec<LayoutSpec>, weights: Option<Vec<f64>>) -> LayoutSpec {
        split(Axis::X, children, weights)
    }

    pub fn column(children: Vec<LayoutSpec>, weights: Option<Vec<f64>>) -> LayoutSpec {
        split(Axis::Y, children, weights)
    }

    pub fn stage(child: Option<LayoutSpec>) -> LayoutSpec {
        LayoutSpec::Stage(StageSpec {
            id: None,
            child: child.map(Box::new),
        })
    }
}

/// Compile a layout description into a document.
pub fn create_document(
    root: Option<&LayoutSpec>,
    floating: &[FloatSpec],
    version: Option<serde_json::Value>,
) -> Result<LayoutDocument, String> {
    let mut views: BTreeMap<String, ViewRecord> = BTreeMap::new();
    // Views without an explicit id get deterministic ones ("editor-1",
    // "editor-2"), so the same layout yields the same ids every time and
    // reset() can keep their content mounted.
    let mut explicit: HashSet<String> = HashSet::new();
    fn collect(spec: &LayoutSpec, explicit: &mut HashSet<String>) {
        match spec {
            LayoutSpec::View(view) => {
                if let Some(id) = &view.id {
                    explicit.insert(id.clone());
                }
            }
            LayoutSpec::Panel(panel) => {
                for view in &panel.views {
                    if let Some(id) = &view.id {
                        explicit.insert(id.clone());
                    }
                }
            }
            LayoutSpec::Split(split) => split.children.iter().for_each(|c| collect(c, explicit)),
            LayoutSpec::Stage(stage) => {
                if let Some(child) = &stage.child {
                    collect(child, explicit);
                }
            }
        }
    }
    if let Some(root) = root {
        collect(root, &mut explicit);
    }
    for f in floating {
        collect(&f.panel, &mut explicit);
    }
    let mut counters: HashMap<String, usize> = HashMap::new();
    let mut add_view = |spec: &ViewSpec, views: &mut BTreeMap<String, ViewRecord>| {
        let id = match &spec.id {
            Some(id) => id.clone(),
            None => loop {
                let n = counters.get(&spec.kind).copied().unwrap_or(0) + 1;
                counters.insert(spec.kind.clone(), n);
                let id = format!("{}-{n}", spec.kind);
                if !explicit.contains(&id) && !views.contains_key(&id) {
                    break id;
                }
            },
        };
        if views.contains_key(&id) {
            return Err(format!("Trellis: duplicate view id \"{id}\""));
        }
        views.insert(
            id.clone(),
            ViewRecord {
                kind: spec.kind.clone(),
                params: spec.params.clone(),
                title: spec.title.clone(),
            },
        );
        Ok(id)
    };
    let mut panel = |spec: &LayoutSpec,
                     views: &mut BTreeMap<String, ViewRecord>|
     -> Result<PanelNode, String> {
        let (specs, index, id): (Vec<&ViewSpec>, usize, Option<String>) = match spec {
            LayoutSpec::View(view) => (vec![view], 0, None),
            LayoutSpec::Panel(panel) => (
                panel.views.iter().collect(),
                panel.selected.unwrap_or(0),
                panel.id.clone(),
            ),
            _ => return Err("Trellis: a panel holds views".into()),
        };
        let ids = specs
            .into_iter()
            .map(|spec| add_view(spec, views))
            .collect::<Result<Vec<_>, _>>()?;
        let selected = ids
            .get(index.min(ids.len().saturating_sub(1)))
            .cloned()
            .unwrap_or_default();
        Ok(PanelNode {
            id: id.unwrap_or_else(|| uid("panel")),
            views: ids,
            selected,
        })
    };
    let mut stages = 0;
    fn build(
        spec: &LayoutSpec,
        stages: &mut usize,
        views: &mut BTreeMap<String, ViewRecord>,
        panel: &mut dyn FnMut(
            &LayoutSpec,
            &mut BTreeMap<String, ViewRecord>,
        ) -> Result<PanelNode, String>,
    ) -> Result<LayoutNode, String> {
        match spec {
            LayoutSpec::View(_) | LayoutSpec::Panel(_) => Ok(LayoutNode::Panel(panel(spec, views)?)),
            LayoutSpec::Stage(stage) => {
                if *stages > 0 {
                    return Err("Trellis: a layout may contain one stage".into());
                }
                *stages += 1;
                let child = match &stage.child {
                    Some(child) => Some(build(child, stages, views, panel)?),
                    None => None,
                };
                if child.as_ref().is_some_and(LayoutNode::is_stage) {
                    return Err("Trellis: a stage cannot contain a stage".into());
                }
                Ok(LayoutNode::Stage(StageNode {
                    id: stage.id.clone().unwrap_or_else(|| "stage".into()),
                    child: child.map(Box::new),
                }))
            }
            LayoutSpec::Split(split) => {
                let children = split
                    .children
                    .iter()
                    .map(|c| build(c, stages, views, panel))
                    .collect::<Result<Vec<_>, _>>()?;
                let weights = match &split.weights {
                    Some(weights) if weights.len() == children.len() => weights.clone(),
                    _ => vec![1.; children.len()],
                };
                Ok(LayoutNode::Split(SplitNode {
                    id: split.id.clone().unwrap_or_else(|| uid("split")),
                    axis: split.axis,
                    weights,
                    children,
                }))
            }
        }
    }
    let tree = match root {
        Some(root) => normalize(build(root, &mut stages, &mut views, &mut panel)?),
        None => None,
    };
    let mut floats = Vec::new();
    for (i, f) in floating.iter().enumerate() {
        floats.push(FloatingPanel {
            panel: panel(&f.panel, &mut views)?,
            rect: f.rect,
            z: (i + 1) as f64,
            layer: f.layer.unwrap_or(FloatingLayer::Overlay),
        });
    }
    Ok(LayoutDocument {
        schema: 1,
        version,
        root: tree,
        floating: floats,
        hidden: Vec::new(),
        views,
        navigation: None,
    })
}
