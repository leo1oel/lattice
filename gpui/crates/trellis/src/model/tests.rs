// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/test/model.test.ts), with tests for Lattice's patch.

use super::*;

fn panel(id: &str, views: &[&str]) -> PanelNode {
    PanelNode {
        id: id.into(),
        views: views.iter().map(|v| v.to_string()).collect(),
        selected: views[0].to_string(),
    }
}

fn view(kind: &str, id: &str) -> ViewSpec {
    ViewSpec {
        kind: kind.into(),
        id: Some(id.into()),
        ..Default::default()
    }
}

fn panel_spec(id: &str, views: Vec<ViewSpec>) -> LayoutSpec {
    LayoutSpec::Panel(PanelSpec {
        id: Some(id.into()),
        views,
        selected: None,
    })
}

pub(crate) fn ide() -> LayoutDocument {
    create_document(
        Some(&layout::row(
            vec![
                panel_spec(
                    "left",
                    vec![view("files", "files"), view("search", "search")],
                ),
                LayoutSpec::Stage(StageSpec {
                    id: Some("stage".into()),
                    child: Some(Box::new(panel_spec(
                        "docs",
                        vec![view("editor", "a"), view("editor", "b")],
                    ))),
                }),
                panel_spec("outline", vec![view("outline", "outline")]),
            ],
            Some(vec![1., 3., 1.]),
        )),
        &[],
        None,
    )
    .unwrap()
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

// ---------------------------------------------------------------- builder

#[test]
fn compiles_specs_into_a_document_with_a_view_table() {
    let doc = ide();
    let mut ids = view_ids(&doc);
    ids.sort();
    assert_eq!(ids, ["a", "b", "files", "outline", "search"]);
    assert_eq!(
        doc.views["a"],
        ViewRecord {
            kind: "editor".into(),
            ..Default::default()
        }
    );
    assert_eq!(find_stage(doc.root.as_ref()).unwrap().id, "stage");
    let LayoutNode::Split(root) = doc.root.as_ref().unwrap() else {
        panic!()
    };
    assert!(close(root.weights.iter().sum(), 1.));
    assert!(close(root.weights[1], 0.6));
}

#[test]
fn wraps_bare_views_in_panels_and_honours_selected() {
    let doc = create_document(
        Some(&LayoutSpec::Panel(PanelSpec {
            id: None,
            views: vec![view("x", "1"), view("x", "2")],
            selected: Some(1),
        })),
        &[],
        None,
    )
    .unwrap();
    let LayoutNode::Panel(p) = doc.root.unwrap() else {
        panic!()
    };
    assert_eq!(p.views, ["1", "2"]);
    assert_eq!(p.selected, "2");
}

#[test]
fn rejects_duplicate_ids_and_multiple_stages() {
    let dup = layout::row(
        vec![
            LayoutSpec::View(view("x", "a")),
            LayoutSpec::View(view("x", "a")),
        ],
        None,
    );
    assert!(
        create_document(Some(&dup), &[], None)
            .unwrap_err()
            .contains("duplicate")
    );
    let stages = layout::row(vec![layout::stage(None), layout::stage(None)], None);
    assert!(
        create_document(Some(&stages), &[], None)
            .unwrap_err()
            .contains("one stage")
    );
}

#[test]
fn generates_deterministic_ids_that_avoid_explicit_ones() {
    let spec = layout::row(
        vec![
            LayoutSpec::View(layout::view("x")),
            LayoutSpec::View(view("x", "x-2")),
            LayoutSpec::View(layout::view("x")),
            LayoutSpec::View(layout::view("y")),
        ],
        None,
    );
    let a = view_ids(&create_document(Some(&spec), &[], None).unwrap());
    assert_eq!(a, ["x-1", "x-2", "x-3", "y-1"]);
    assert_eq!(
        view_ids(&create_document(Some(&spec), &[], None).unwrap()),
        a
    );
}

// ---------------------------------------------------------------- tree

#[test]
fn lays_out_weighted_splits_in_unit_space() {
    let doc = ide();
    let rects = layout_rects(doc.root.as_ref(), None);
    assert_eq!(rects["left"].rect.x, 0.);
    assert!(close(rects["left"].rect.w, 0.2));
    assert!(close(rects["docs"].rect.x, 0.2));
    assert!(close(rects["docs"].rect.w, 0.6));
    assert_eq!(rects["stage"].rect, rects["docs"].rect);
}

#[test]
fn flattens_aligned_splits_and_collapses_single_children() {
    let nested = LayoutNode::Split(SplitNode {
        id: "outer".into(),
        axis: Axis::X,
        weights: vec![0.5, 0.5],
        children: vec![
            LayoutNode::Panel(panel("a", &["1"])),
            LayoutNode::Split(SplitNode {
                id: "inner".into(),
                axis: Axis::X,
                weights: vec![0.5, 0.5],
                children: vec![
                    LayoutNode::Panel(panel("b", &["2"])),
                    LayoutNode::Panel(panel("c", &["3"])),
                ],
            }),
        ],
    });
    let LayoutNode::Split(n) = normalize(nested).unwrap() else {
        panic!()
    };
    assert_eq!(
        n.children.iter().map(|c| c.id()).collect::<Vec<_>>(),
        ["a", "b", "c"]
    );
    assert_eq!(n.weights, [0.5, 0.25, 0.25]);
    let single = normalize(LayoutNode::Split(SplitNode {
        id: "s".into(),
        axis: Axis::Y,
        weights: vec![1.],
        children: vec![LayoutNode::Panel(panel("a", &["1"]))],
    }))
    .unwrap();
    assert_eq!(single.id(), "a");
}

#[test]
fn never_removes_the_stage_and_gives_removed_space_to_a_neighbour() {
    let doc = ide();
    let LayoutNode::Split(without) = remove_node(doc.root.as_ref(), "left").unwrap() else {
        panic!()
    };
    assert_eq!(
        without.children.iter().map(|c| c.id()).collect::<Vec<_>>(),
        ["stage", "outline"]
    );
    assert!(close(without.weights[0], 0.8));
    assert_eq!(remove_node(doc.root.as_ref(), "stage"), doc.root);
    let emptied = remove_node(doc.root.as_ref(), "docs");
    assert!(find_stage(emptied.as_ref()).unwrap().child.is_none());
}

#[test]
fn inserts_beside_a_node_with_a_share() {
    let a = LayoutNode::Panel(panel("a", &["1"]));
    let root = insert_beside(
        Some(&a),
        "a",
        &LayoutNode::Panel(panel("b", &["2"])),
        Edge::Left,
        "s",
        Some(0.25),
    );
    let LayoutNode::Split(split) = &root else {
        panic!()
    };
    assert_eq!(
        split.children.iter().map(|c| c.id()).collect::<Vec<_>>(),
        ["b", "a"]
    );
    assert_eq!(split.weights, [0.25, 0.75]);
    let below = insert_beside(
        Some(&root),
        "a",
        &LayoutNode::Panel(panel("c", &["3"])),
        Edge::Bottom,
        "t",
        None,
    );
    assert_eq!(
        find_node(Some(&below), "t")
            .unwrap()
            .as_split()
            .unwrap()
            .axis,
        Axis::Y
    );
}

#[test]
fn clamps_boundary_resizes_to_minimum_sizes() {
    let split = SplitNode {
        id: "s".into(),
        axis: Axis::X,
        weights: vec![0.5, 0.5],
        children: vec![
            LayoutNode::Panel(panel("a", &["1"])),
            LayoutNode::Panel(panel("b", &["2"])),
        ],
    };
    assert!(close(
        resize_boundary(&split, 0, 0.3, &|_| DEFAULT_MIN_FRACTION).weights[0],
        0.3
    ));
    assert!(close(
        resize_boundary(&split, 0, 0.01, &|_| 0.2).weights[0],
        0.2
    ));
    assert!(close(
        resize_boundary(&split, 0, 0.99, &|_| 0.2).weights[1],
        0.2
    ));
}

// ---------------------------------------------------------------- document

#[test]
fn closes_views_removing_empty_panels_but_keeping_the_stage() {
    let mut doc = ide();
    doc = close_view(&doc, "a");
    assert_eq!(locate_panel(&doc, "docs").unwrap().panel().selected, "b");
    doc = close_view(&doc, "b");
    assert!(locate_panel(&doc, "docs").is_none());
    let stage = find_stage(doc.root.as_ref()).unwrap();
    assert_eq!(stage.id, "stage");
    assert!(stage.child.is_none());
    assert!(!doc.views.contains_key("a"));
}

#[test]
fn detaches_a_view_and_readds_it_as_a_tab_at_an_index() {
    let mut doc = detach_view(&ide(), "b");
    assert!(doc.views.contains_key("b"));
    doc = add_tab(&doc, "left", "b", Some(1), true);
    let p = locate_panel(&doc, "left").unwrap().panel().clone();
    assert_eq!(p.views, ["files", "b", "search"]);
    assert_eq!(p.selected, "b");
}

#[test]
fn selects_and_reorders_tabs() {
    let mut doc = select_view(&ide(), "b");
    assert_eq!(panel_of_view(&doc, "b").unwrap().selected, "b");
    doc = reorder_tabs(&doc, "docs", &["b".into(), "a".into()]);
    assert_eq!(panel_of_view(&doc, "a").unwrap().views, ["b", "a"]);
    assert_eq!(reorder_tabs(&doc, "docs", &["a".into()]), doc);
}

#[test]
fn docks_into_an_empty_stage_and_as_tabs_into_an_occupied_one() {
    let mut doc = close_view(&close_view(&ide(), "a"), "b");
    doc.views.insert(
        "n".into(),
        ViewRecord {
            kind: "editor".into(),
            ..Default::default()
        },
    );
    doc = insert_panel(
        &doc,
        &panel("p1", &["n"]),
        &DockTarget::Into {
            into: "stage".into(),
            index: None,
        },
    );
    assert_eq!(
        find_stage(doc.root.as_ref())
            .unwrap()
            .child
            .as_ref()
            .unwrap()
            .id(),
        "p1"
    );
    doc.views.insert(
        "m".into(),
        ViewRecord {
            kind: "editor".into(),
            ..Default::default()
        },
    );
    doc = insert_panel(
        &doc,
        &panel("p2", &["m"]),
        &DockTarget::Into {
            into: "stage".into(),
            index: None,
        },
    );
    assert_eq!(locate_panel(&doc, "p1").unwrap().panel().views, ["n", "m"]);
}

#[test]
fn floats_hides_and_restores_panels_to_their_previous_place() {
    let mut doc = ide();
    doc = hide_panel(&doc, "outline");
    assert_eq!(
        doc.hidden[0].restore,
        RestoreTarget::Docked {
            beside: "stage".into(),
            edge: Edge::Right,
            share: 0.25,
        }
    );
    assert!(
        !panels_of(doc.root.as_ref())
            .iter()
            .any(|p| p.id == "outline")
    );
    doc = restore_panel(&doc, "outline", FloatingLayer::Overlay);
    let LayoutNode::Split(root) = doc.root.as_ref().unwrap() else {
        panic!()
    };
    assert_eq!(
        root.children.iter().map(|c| c.id()).collect::<Vec<_>>(),
        ["left", "stage", "outline"]
    );
    assert!(close(root.weights[2], 0.2));
    let outline = locate_panel(&doc, "outline").unwrap().panel().clone();
    let floating = float_panel(
        &doc,
        &outline,
        Rect::new(0.1, 0.1, 0.3, 0.3),
        FloatingLayer::Overlay,
    );
    assert_eq!(floating.floating.len(), 1);
    let hidden = hide_panel(&floating, "outline");
    assert!(matches!(
        hidden.hidden[0].restore,
        RestoreTarget::Floating {
            layer: FloatingLayer::Overlay,
            ..
        }
    ));
    assert_eq!(
        restore_panel(&hidden, "outline", FloatingLayer::Overlay)
            .floating
            .len(),
        1
    );
}

#[test]
fn sanitizes_broken_documents() {
    let mut views = crate::model::Views::new();
    for id in ["a", "c", "orphan"] {
        views.insert(
            id.to_string(),
            ViewRecord {
                kind: "x".into(),
                ..Default::default()
            },
        );
    }
    let broken = LayoutDocument {
        root: Some(LayoutNode::Split(SplitNode {
            id: "s".into(),
            axis: Axis::X,
            weights: vec![f64::NAN, 2.],
            children: vec![
                LayoutNode::Panel(panel("p", &["a", "ghost"])),
                LayoutNode::Panel(panel("q", &["a"])),
                LayoutNode::Stage(StageNode {
                    id: "st1".into(),
                    child: None,
                }),
                LayoutNode::Stage(StageNode {
                    id: "st2".into(),
                    child: None,
                }),
            ],
        })),
        floating: vec![FloatingPanel {
            panel: panel("f", &["c"]),
            rect: Rect::new(5., -1., 3., 0.),
            z: 1.,
            layer: FloatingLayer::Overlay,
        }],
        views,
        ..Default::default()
    };
    let doc = sanitize(&broken, &|_| true);
    let mut ids = view_ids(&doc);
    ids.sort();
    assert_eq!(ids, ["a", "c"]);
    assert!(!doc.views.contains_key("orphan"));
    assert_eq!(
        panels_of(doc.root.as_ref())
            .iter()
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>(),
        ["p"]
    );
    assert!(doc.floating[0].rect.w <= 1.);
    let json = serde_json::to_string(&doc.root).unwrap();
    assert_eq!(json.matches("\"kind\":\"stage\"").count(), 1);
}

/// A layout document in the JSON the Tauri app's Trellis persists (the
/// `document` of a saved project layout: `JSON.stringify` of Trellis's
/// `LayoutDocument`, nodes tagged by `kind`, views by `type`).
const TAURI_SAVED_DOCUMENT: &str = include_str!("fixtures/tauri-saved-document.json");

#[test]
fn a_document_the_tauri_app_saved_reads_as_the_same_layout() {
    let doc: LayoutDocument = serde_json::from_str(TAURI_SAVED_DOCUMENT).unwrap();
    assert_eq!(doc.schema, 1);
    assert_eq!(doc.version, Some(serde_json::json!(3)));
    let Some(LayoutNode::Split(row)) = &doc.root else {
        panic!("a row at the root: {:?}", doc.root)
    };
    assert_eq!((row.id.as_str(), row.axis), ("split-row", Axis::X));
    assert_eq!(row.weights, [0.2, 0.46, 0.34]);
    let LayoutNode::Split(column) = &row.children[0] else {
        panic!("a column first")
    };
    assert_eq!(
        (column.axis, column.weights.as_slice()),
        (Axis::Y, &[0.62, 0.38][..])
    );
    assert_eq!(
        column.children[0],
        LayoutNode::Panel(PanelNode {
            id: "panel-project".into(),
            views: vec!["project".into(), "agent".into()],
            selected: "agent".into(),
        })
    );
    assert_eq!(row.children[1].id(), "panel-documents");
    assert_eq!(
        row.children[2],
        LayoutNode::Stage(StageNode {
            id: "stage".into(),
            child: None,
        })
    );
    assert_eq!(
        doc.floating,
        [FloatingPanel {
            panel: PanelNode::single("panel-pdf", "pdf"),
            rect: Rect::new(0.55, 0.1, 0.4, 0.7),
            z: 3.,
            layer: FloatingLayer::Overlay,
        }]
    );
    assert_eq!(
        doc.hidden[0].restore,
        RestoreTarget::Docked {
            beside: "split-row".into(),
            edge: Edge::Bottom,
            share: 0.3,
        }
    );
    assert_eq!(
        doc.hidden[1].restore,
        RestoreTarget::Tab {
            panel: "panel-project".into(),
            index: Some(1),
        }
    );
    let order: Vec<&str> = doc.views.keys().map(String::as_str).collect();
    assert_eq!(
        order,
        [
            "project",
            "agent",
            "papers",
            "file-main",
            "file-notes",
            "pdf",
            "terminal",
            "git"
        ]
    );
    let main = &doc.views["file-main"];
    assert_eq!(main.kind, "file");
    assert_eq!(main.title.as_deref(), Some("main.tex"));
    assert_eq!(
        main.params.as_ref().and_then(|p| p.get("key")),
        Some(&serde_json::json!("main.tex"))
    );
    assert_eq!(doc.views["file-notes"].title, None);
    let navigation = doc.navigation.as_ref().unwrap();
    assert_eq!(
        navigation.frame.as_deref(),
        Some(&["panel-documents".to_string()][..])
    );
    let framings = navigation.framings.as_ref().unwrap();
    assert_eq!(framings[0].name, "Writing");
    assert_eq!(framings[0].frame, ["panel-documents", "panel-pdf"]);
}

#[test]
fn a_saved_float_or_hidden_panel_with_fields_sanitize_repairs_still_reads() {
    // `JSON.stringify` writes a non-finite `z` as `null`; Trellis's sanitize
    // repairs it, a missing rect, an unknown layer and a missing restore.
    let json = r#"{"schema":1,"root":{"kind":"panel","id":"p","views":["a"],"selected":"a"},
        "floating":[
            {"panel":{"id":"f1","views":["b"],"selected":"b"},"rect":{"x":0.1,"y":0.1,"w":0.3,"h":0.3},"z":null,"layer":"overlay"},
            {"panel":{"id":"f2","views":["c"],"selected":"c"},"z":2,"layer":"sideways"}
        ],
        "hidden":[{"panel":{"id":"h","views":["d"],"selected":"d"}}],
        "views":{"a":{"type":"x"},"b":{"type":"x"},"c":{"type":"x"},"d":{"type":"x"}}}"#;
    let doc = sanitize(&serde_json::from_str(json).unwrap(), &|_| true);
    assert_eq!(doc.floating[0].z, 1.);
    assert_eq!(doc.floating[1].layer, FloatingLayer::Overlay);
    let rect = doc.floating[1].rect;
    assert!(
        rect.w > 0.02 && rect.w <= 1. && rect.h > 0.02 && rect.h <= 1.,
        "{rect:?}"
    );
    // A hidden panel with nowhere to go comes back as a float.
    let back = restore_panel(&doc, "h", FloatingLayer::Overlay);
    assert!(back.floating.iter().any(|f| f.panel.id == "h"));
    assert_eq!(view_ids(&back).len(), 4);
}

// ---------------------------------------------------------------- Lattice's patch

#[test]
fn a_tab_hidden_out_of_a_group_comes_back_where_it_was() {
    let mut doc = ide();
    // Hide "files" out of [files, search] as the workspace does: a panel of
    // its own, restored into its owner at its index.
    let alone = PanelNode::single("alone", "files");
    let detached = detach_view(&doc, "files");
    doc = LayoutDocument {
        hidden: vec![HiddenPanel {
            panel: alone,
            restore: RestoreTarget::Tab {
                panel: "left".into(),
                index: Some(0),
            },
        }],
        ..detached
    };
    let back = restore_panel(&doc, "alone", FloatingLayer::Overlay);
    assert_eq!(
        locate_panel(&back, "left").unwrap().panel().views,
        ["files", "search"]
    );
}

#[test]
fn a_column_hidden_one_panel_at_a_time_comes_back_in_any_order() {
    // [left | stage | column(outline / extra)]
    let mut doc = ide();
    doc.views.insert(
        "x".into(),
        ViewRecord {
            kind: "x".into(),
            ..Default::default()
        },
    );
    doc = insert_panel(
        &doc,
        &panel("extra", &["x"]),
        &DockTarget::Beside {
            beside: "outline".into(),
            edge: Edge::Bottom,
            share: None,
        },
    );
    let shape =
        |doc: &LayoutDocument| serde_json::to_string(&layout_shape(doc.root.as_ref())).unwrap();
    let before = shape(&doc);
    // Hide outline then extra; show outline first (its anchor, extra, is
    // hidden), then extra.
    let hidden = hide_panel(&hide_panel(&doc, "outline"), "extra");
    let back = restore_panel(
        &restore_panel(&hidden, "outline", FloatingLayer::Overlay),
        "extra",
        FloatingLayer::Overlay,
    );
    assert!(
        back.floating.is_empty(),
        "nothing floats over the documents"
    );
    assert_eq!(shape(&back), before);
    // And the other way round.
    let back = restore_panel(
        &restore_panel(&hidden, "extra", FloatingLayer::Overlay),
        "outline",
        FloatingLayer::Overlay,
    );
    assert!(back.floating.is_empty());
    assert_eq!(shape(&back), before);
}

/// The tree's structure by panel ids, without split ids or weights.
fn layout_shape(node: Option<&LayoutNode>) -> serde_json::Value {
    match node {
        None => serde_json::Value::Null,
        Some(LayoutNode::Panel(p)) => serde_json::json!(p.id),
        Some(LayoutNode::Stage(s)) => {
            serde_json::json!({"stage": layout_shape(s.child.as_deref())})
        }
        Some(LayoutNode::Split(s)) => serde_json::json!({
            format!("{:?}", s.axis): s.children.iter().map(|c| layout_shape(Some(c))).collect::<Vec<_>>()
        }),
    }
}

/// A row [a, b, c, d] with the range [b, c] framed, as the camera's targets
/// list it, and X dropped on that frame's band.
fn drop_on_framed_range(edge_point: Point) -> LayoutNode {
    let leaf = |id: &str| LayoutNode::Panel(panel(id, &[id]));
    let row = LayoutNode::Split(SplitNode {
        id: "row".into(),
        axis: Axis::X,
        weights: vec![0.25; 4],
        children: vec![leaf("a"), leaf("b"), leaf("c"), leaf("d")],
    });
    let range = LayoutNode::Split(SplitNode {
        id: range_id("row", &["b".into(), "c".into()]),
        axis: Axis::X,
        weights: vec![0.5, 0.5],
        children: vec![leaf("b"), leaf("c")],
    });
    // The framed range fills a 1000 × 600 viewport; a 12px band.
    let target = frame_drop_target(&range, edge_point, 1000., 600., 12.).expect("on the band");
    apply_dock_target(Some(&row), &target, &leaf("x"), "split-new")
}

fn child_ids(node: &LayoutNode) -> Vec<String> {
    node.as_split()
        .unwrap()
        .children
        .iter()
        .map(|c| c.id().to_string())
        .collect()
}

#[test]
fn a_drop_on_a_framed_ranges_side_band_lands_beside_the_range() {
    let right = drop_on_framed_range(Point::new(995., 300.));
    assert_eq!(child_ids(&right), ["a", "b", "c", "x", "d"]);
    let left = drop_on_framed_range(Point::new(5., 300.));
    assert_eq!(child_ids(&left), ["a", "x", "b", "c", "d"]);
    // The newcomer takes an equal fifth; the rest keep their proportions.
    let weights = &right.as_split().unwrap().weights;
    let total: f64 = weights.iter().sum();
    assert!((weights[3] / total - 0.2).abs() < 1e-9);
    assert!((weights[0] / total - 0.2).abs() < 1e-9);
}

#[test]
fn a_drop_on_a_framed_ranges_bottom_band_goes_under_the_range_only() {
    let root = drop_on_framed_range(Point::new(500., 595.));
    // a and d stay where they were; b and c, with x under them, share the
    // half of the row the range had.
    assert_eq!(root.as_split().unwrap().children.len(), 3);
    let row = root.as_split().unwrap();
    assert_eq!(row.children[0].id(), "a");
    assert_eq!(row.children[2].id(), "d");
    assert!((row.weights[1] / row.weights.iter().sum::<f64>() - 0.5).abs() < 1e-9);
    let column = row.children[1].as_split().unwrap();
    assert_eq!(column.axis, Axis::Y);
    assert_eq!(column.children[1].id(), "x");
    let pair = column.children[0].as_split().unwrap();
    assert_eq!(
        (pair.axis, child_ids(&column.children[0])),
        (Axis::X, vec!["b".to_string(), "c".to_string()])
    );
}
