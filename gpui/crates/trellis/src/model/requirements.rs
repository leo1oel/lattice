// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/test/requirements/: layout.test.ts, navigation.test.ts, trellis-adapter.ts).

//! The requirement tests: layout (LAYOUT-*, DOCK-*) and navigation (NAV-*).

use super::*;

enum Arr {
    View(&'static str),
    Group(&'static str, Axis, Vec<Arr>, Option<Vec<f64>>),
}

use Arr::{Group, View};

fn fixture(spec: &Arr) -> LayoutNode {
    match spec {
        View(id) => LayoutNode::Panel(PanelNode::single(*id, *id)),
        Group(name, axis, views, shares) => LayoutNode::Split(SplitNode {
            id: name.to_string(),
            axis: *axis,
            children: views.iter().map(fixture).collect(),
            weights: shares
                .clone()
                .unwrap_or_else(|| vec![1. / views.len() as f64; views.len()]),
        }),
    }
}

struct Workspace {
    root: LayoutNode,
    serial: usize,
}

impl Workspace {
    fn new(spec: Arr) -> Workspace {
        Workspace {
            root: fixture(&spec),
            serial: 0,
        }
    }
    fn entries(&self) -> Entries {
        focus_layout(Some(&self.root), None)
    }
    fn bounds(&self, id: &str) -> Rect {
        self.entries()[id].rect
    }
    fn views(&self) -> Vec<String> {
        let mut v = leaf_ids(Some(&self.root));
        v.sort();
        v
    }
    fn next_id(&mut self) -> String {
        self.serial += 1;
        format!("edit-{}", self.serial)
    }
    fn split(&mut self, id: &str, incoming: &str, axis: Axis) {
        let split_id = self.next_id();
        self.root = insert_beside(
            Some(&self.root),
            id,
            &LayoutNode::Panel(PanelNode::single(incoming, incoming)),
            if axis == Axis::X {
                Edge::Right
            } else {
                Edge::Bottom
            },
            &split_id,
            None,
        );
    }
    fn close(&mut self, id: &str) {
        if let Some(root) = remove_node(Some(&self.root), id) {
            self.root = root;
        }
    }
    fn resize(&mut self, group: &str, seam: usize, position: f64) {
        let LayoutNode::Split(node) = self.entries()[group].node.clone() else {
            panic!("expected a resizable group")
        };
        let total: f64 = node.weights.iter().sum();
        let pair = (node.weights[seam] + node.weights[seam + 1]) / total;
        let resized = resize_boundary(&node, seam, position, &|_| pair * 0.12);
        self.root = replace_node(Some(&self.root), group, &LayoutNode::Split(resized)).unwrap();
    }
    fn move_to(&mut self, id: &str, target: &str, side: Edge) {
        if id == target
            || find_node(Some(&self.root), id).is_none()
            || find_node(Some(&self.root), target).is_none()
        {
            return;
        }
        let source = find_node(Some(&self.root), id).unwrap().clone();
        let Some(pruned) = remove_node(Some(&self.root), id) else {
            return;
        };
        let split_id = self.next_id();
        self.root = insert_beside(Some(&pruned), target, &source, side, &split_id, None);
    }
    fn insert(&mut self, target: DockTargetSpec, id: &str) {
        let split_id = self.next_id();
        self.root = apply_dock_target(
            Some(&self.root),
            &target,
            &LayoutNode::Panel(PanelNode::single(id, id)),
            &split_id,
        );
    }
    fn add_at_edge(&mut self, id: &str, target: &str, side: Edge) {
        let spec = tile_drop_target(&self.entries(), target, side);
        self.insert(spec, id);
    }
    fn add_at_seam(&mut self, id: &str, group: &str, boundary: usize) {
        let LayoutNode::Split(node) = self.entries()[group].node.clone() else {
            panic!("expected a seam")
        };
        self.insert(seam_target(&node, boundary), id);
    }
    fn add_at_frame(&mut self, id: &str, point: Point) {
        if let Some(target) = frame_drop_target(&self.root, point, 1000., 600., 12.) {
            self.insert(target, id);
        }
    }
    fn snap(&self, r: Rect) -> String {
        best_fit(r, &self.entries())
    }
    fn step(&self, id: &str, direction: StepDirection, point: Point) -> String {
        hierarchy_step(&self.entries(), id, direction, point)
    }
}

fn near(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-9, "{actual} ≈ {expected}");
}

fn same_bounds(a: Rect, b: Rect) {
    near(a.x, b.x);
    near(a.y, b.y);
    near(a.w, b.w);
    near(a.h, b.h);
}

fn partitions(rects: &[Rect]) {
    near(rects.iter().map(|r| r.w * r.h).sum(), 1.);
    for (i, r) in rects.iter().enumerate() {
        assert!(r.w > 0. && r.h > 0.);
        assert!(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1. + 1e-9 && r.y + r.h <= 1. + 1e-9);
        for other in &rects[i + 1..] {
            let ow = (r.x + r.w).min(other.x + other.w) - r.x.max(other.x);
            let oh = (r.y + r.h).min(other.y + other.h) - r.y.max(other.y);
            assert!(ow <= 1e-9 || oh <= 1e-9, "views must not overlap");
        }
    }
}

fn all(w: &Workspace) -> Vec<Rect> {
    w.views().iter().map(|v| w.bounds(v)).collect()
}

#[test]
fn layout_01_splitting_halves_a_view_and_leaves_others_untouched() {
    for axis in [Axis::X, Axis::Y] {
        let mut w = Workspace::new(Group(
            "workspace",
            axis,
            vec![View("notes"), View("mail")],
            Some(vec![0.4, 0.6]),
        ));
        let untouched = w.bounds("mail");
        let original = w.bounds("notes");
        w.split("notes", "finder", axis);
        assert_eq!(w.bounds("mail"), untouched);
        let (a, b) = (w.bounds("notes"), w.bounds("finder"));
        near(a.w * a.h, original.w * original.h / 2.);
        near(b.w * b.h, a.w * a.h);
        if axis == Axis::X {
            near(a.x + a.w, b.x);
            near(a.y, b.y);
        } else {
            near(a.y + a.h, b.y);
            near(a.x, b.x);
        }
        partitions(&all(&w));
    }
}

#[test]
fn layout_02_resizing_a_seam_changes_only_the_adjacent_views() {
    for axis in [Axis::X, Axis::Y] {
        let mut w = Workspace::new(Group(
            "workspace",
            axis,
            vec![View("a"), View("b"), View("c"), View("d")],
            Some(vec![0.2, 0.3, 0.1, 0.4]),
        ));
        let (a, d) = (w.bounds("a"), w.bounds("d"));
        w.resize("workspace", 1, 0.4);
        same_bounds(w.bounds("a"), a);
        same_bounds(w.bounds("d"), d);
        near(
            if axis == Axis::X {
                w.bounds("b").w
            } else {
                w.bounds("b").h
            },
            0.2,
        );
        partitions(&all(&w));
        for position in [-100., 100.] {
            w.resize("workspace", 1, position);
            partitions(&all(&w));
            same_bounds(w.bounds("a"), a);
            same_bounds(w.bounds("d"), d);
        }
    }
}

#[test]
fn layout_03_closing_gives_space_to_the_next_neighbour_or_the_previous_at_the_end() {
    for (closing, survivor) in [("b", "c"), ("c", "b")] {
        let mut w = Workspace::new(Group(
            "workspace",
            Axis::X,
            vec![View("a"), View("b"), View("c")],
            Some(vec![0.2, 0.3, 0.5]),
        ));
        let untouched = w.bounds("a");
        w.close(closing);
        assert_eq!(w.views(), ["a", survivor]);
        assert_eq!(w.bounds("a"), untouched);
        near(w.bounds(survivor).w, 0.8);
        partitions(&all(&w));
    }
}

#[test]
fn layout_04_the_last_remaining_view_stays_open() {
    let mut w = Workspace::new(Group(
        "workspace",
        Axis::X,
        vec![View("a"), View("b")],
        None,
    ));
    w.close("a");
    w.close("b");
    assert_eq!(w.views(), ["b"]);
    assert_eq!(w.bounds("b"), Rect::new(0., 0., 1., 1.));
}

#[test]
fn dock_01_moving_a_view_keeps_every_view_and_places_it_on_the_side() {
    for side in [Edge::Left, Edge::Right, Edge::Top, Edge::Bottom] {
        let mut w = Workspace::new(Group(
            "workspace",
            Axis::X,
            vec![
                View("a"),
                Group("right", Axis::Y, vec![View("b"), View("c")], None),
            ],
            None,
        ));
        w.move_to("a", "c", side);
        assert_eq!(w.views(), ["a", "b", "c"]);
        let (a, c) = (w.bounds("a"), w.bounds("c"));
        match side {
            Edge::Left => near(a.x + a.w, c.x),
            Edge::Right => near(c.x + c.w, a.x),
            Edge::Top => near(a.y + a.h, c.y),
            Edge::Bottom => near(c.y + c.h, a.y),
        }
        near(a.w, c.w);
        near(a.h, c.h);
        partitions(&all(&w));
    }
}

#[test]
fn dock_02_the_preview_reserves_equal_space() {
    for side in [Edge::Left, Edge::Right, Edge::Top, Edge::Bottom] {
        let r = Rect::new(0., 0., 1., 1.);
        let DropRects {
            slot, remaining, ..
        } = drop_rects(r, side);
        partitions(&[slot, remaining]);
        near(slot.w * slot.h, 0.5);
        assert_eq!(
            drop_edge(Point::new(slot.x + slot.w * 0.5, slot.y + slot.h * 0.5), r),
            Some(side)
        );
    }
}

#[test]
fn dock_03_either_side_of_a_shared_edge_and_the_seam_agree() {
    let make = || {
        Workspace::new(Group(
            "workspace",
            Axis::X,
            vec![View("a"), View("b"), View("c")],
            Some(vec![0.2, 0.3, 0.5]),
        ))
    };
    let (mut left, mut right, mut seam) = (make(), make(), make());
    left.add_at_edge("incoming", "a", Edge::Right);
    right.add_at_edge("incoming", "b", Edge::Left);
    seam.add_at_seam("incoming", "workspace", 1);
    for id in left.views() {
        assert_eq!(left.bounds(&id), right.bounds(&id));
        assert_eq!(left.bounds(&id), seam.bounds(&id));
    }
    near(
        left.bounds("a").x + left.bounds("a").w,
        left.bounds("incoming").x,
    );
    near(
        left.bounds("incoming").x + left.bounds("incoming").w,
        left.bounds("b").x,
    );
}

#[test]
fn dock_04_a_seam_between_nested_groups_spans_the_whole_group() {
    let mut w = Workspace::new(Group(
        "workspace",
        Axis::X,
        vec![
            Group("left", Axis::Y, vec![View("a"), View("b")], None),
            Group("right", Axis::Y, vec![View("c"), View("d")], None),
        ],
        None,
    ));
    w.add_at_seam("incoming", "workspace", 1);
    near(w.bounds("incoming").h, 1.);
    assert!(w.bounds("incoming").x > w.bounds("a").x);
    assert!(w.bounds("incoming").x < w.bounds("c").x);
    partitions(&all(&w));
}

#[test]
fn dock_05_the_outer_frame_inserts_around_the_group_and_ignores_outside_drops() {
    let mut w = Workspace::new(Group(
        "workspace",
        Axis::X,
        vec![View("a"), View("b")],
        None,
    ));
    w.add_at_frame("outside", Point::new(-1., 300.));
    assert_eq!(w.views(), ["a", "b"]);
    w.add_at_frame("incoming", Point::new(500., 4.));
    near(w.bounds("incoming").w, 1.);
    near(
        w.bounds("incoming").y + w.bounds("incoming").h,
        w.bounds("a").y,
    );
    partitions(&all(&w));
}

#[test]
fn dock_06_dropping_a_view_onto_itself_changes_nothing() {
    let mut w = Workspace::new(Group(
        "workspace",
        Axis::X,
        vec![View("a"), View("b")],
        None,
    ));
    let before = all(&w);
    w.move_to("a", "a", Edge::Left);
    assert_eq!(all(&w), before);
}

fn nested() -> Workspace {
    Workspace::new(Group(
        "workspace",
        Axis::X,
        vec![
            Group("writing", Axis::Y, vec![View("notes"), View("mail")], None),
            View("finder"),
        ],
        None,
    ))
}

const CENTRE: Point = Point { x: 0.5, y: 0.5 };

#[test]
fn nav_01_hierarchy_steps_one_level_toward_the_view_under_the_pointer() {
    let w = nested();
    let p = Point::new(0.2, 0.8);
    assert_eq!(w.step("workspace", StepDirection::In, p), "writing");
    assert_eq!(w.step("writing", StepDirection::In, p), "mail");
    assert_eq!(w.step("mail", StepDirection::Out, CENTRE), "writing");
    assert_eq!(w.step("writing", StepDirection::Out, CENTRE), "workspace");
    assert_eq!(w.step("workspace", StepDirection::Out, CENTRE), "workspace");
    assert_eq!(w.step("mail", StepDirection::In, CENTRE), "mail");
}

#[test]
fn nav_02_aligned_splits_add_no_level_a_perpendicular_split_does() {
    let mut w = Workspace::new(View("notes"));
    w.split("notes", "mail", Axis::X);
    let row = w.step("notes", StepDirection::Out, CENTRE);
    w.split("mail", "finder", Axis::X);
    assert_eq!(w.step("finder", StepDirection::Out, CENTRE), row);
    w.split("mail", "calendar", Axis::Y);
    let column = w.step("calendar", StepDirection::Out, CENTRE);
    assert_ne!(column, row);
    assert_eq!(w.step(&column, StepDirection::Out, CENTRE), row);
}

#[test]
fn nav_03_views_and_groups_remain_snap_targets_despite_noise() {
    let w = nested();
    for id in ["workspace", "writing", "notes", "mail", "finder"] {
        let r = w.bounds(id);
        assert_eq!(w.snap(r), id);
        assert_eq!(
            w.snap(Rect::new(r.x + r.w * 0.01, r.y, r.w * 1.02, r.h * 1.02)),
            id
        );
    }
    assert_eq!(w.snap(Rect::new(-0.1, -0.1, 1.2, 1.2)), "workspace");
}

#[test]
fn nav_04_contiguous_views_can_be_framed_together() {
    let w = Workspace::new(Group(
        "workspace",
        Axis::X,
        vec![View("a"), View("b"), View("c"), View("d")],
        Some(vec![0.1, 0.2, 0.3, 0.4]),
    ));
    let before = all(&w);
    let frame = frame_leaves(Some(&w.root), &["b".into(), "c".into()]).unwrap();
    assert_eq!(leaf_ids(Some(&w.entries()[&frame].node)), ["b", "c"]);
    assert_eq!(w.snap(w.bounds(&frame)), frame);
    assert_eq!(all(&w), before);
}

#[test]
fn nav_05_marquee_works_in_either_direction_through_a_zoomed_viewport() {
    let w = nested();
    let viewport = Rect::new(20., 100., 1000., 500.);
    let camera = w.bounds("writing");
    let (a, b) = (Point::new(20., 350.), Point::new(1020., 600.));
    let selection = rectangle_camera(a, b, viewport, camera);
    assert_eq!(selection, w.bounds("mail"));
    assert_eq!(rectangle_camera(b, a, viewport, camera), selection);
    assert_eq!(w.snap(selection), "mail");
}

#[test]
fn nav_06_marquee_clips_at_the_boundary_without_forcing_its_aspect() {
    let rect = rectangle_camera(
        Point::new(-100., 0.),
        Point::new(500., 300.),
        Rect::new(0., 0., 1000., 500.),
        Rect::new(0., 0., 1., 1.),
    );
    assert_eq!(rect, Rect::new(0., 0., 0.5, 0.6));
}

#[test]
fn nav_07_maximize_restores_the_exact_prior_framing() {
    let w = nested();
    for origin in ["workspace", "writing"] {
        let (destination, session) =
            maximize_transition(&w.entries(), "workspace", origin, "notes", None);
        assert_eq!(destination, "notes");
        let (back, _) = maximize_transition(
            &w.entries(),
            "workspace",
            "notes",
            "notes",
            session.as_ref(),
        );
        assert_eq!(back, origin);
    }
}

#[test]
fn nav_08_maximize_restores_the_nearest_surviving_ancestor() {
    let mut w = nested();
    let (_, session) = maximize_transition(&w.entries(), "workspace", "writing", "notes", None);
    w.close("mail");
    let (restored, _) = maximize_transition(
        &w.entries(),
        "workspace",
        "notes",
        "notes",
        session.as_ref(),
    );
    assert_eq!(restored, "workspace");
}

#[test]
fn nav_09_a_saved_framing_follows_remaining_views() {
    let mut w = nested();
    let leaves = ["notes".to_string(), "mail".to_string()];
    assert_eq!(
        saved_frame_destination(Some(&w.root), &leaves).as_deref(),
        Some("writing")
    );
    w.close("mail");
    assert_eq!(
        saved_frame_destination(Some(&w.root), &leaves).as_deref(),
        Some("notes")
    );
    w.close("notes");
    assert_eq!(saved_frame_destination(Some(&w.root), &leaves), None);
}

fn visit(id: &str) -> Visit {
    Visit {
        id: id.into(),
        leaves: vec![id.into()],
    }
}

#[test]
fn nav_10_repeated_visits_do_not_duplicate_history() {
    let (mut visits, mut index) = (vec![visit("workspace")], 0);
    for id in ["notes", "notes", "mail"] {
        (visits, index) = record_visit(&visits, index, visit(id));
    }
    let ids = |v: &[Visit]| v.iter().map(|v| v.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&visits), ["workspace", "notes", "mail"]);
    (visits, index) = record_visit(&visits, 1, visit("finder"));
    assert_eq!(ids(&visits), ["workspace", "notes", "finder"]);
    assert_eq!(index, 2);
}

#[test]
fn nav_11_revisiting_a_framing_with_different_contents_records_it() {
    let (mut visits, mut index) = (vec![visit("workspace")], 0);
    for leaves in [vec!["notes", "mail"], vec!["notes"]] {
        let v = Visit {
            id: "writing".into(),
            leaves: leaves.iter().map(|s| s.to_string()).collect(),
        };
        (visits, index) = record_visit(&visits, index, v);
    }
    assert_eq!(visits.len(), 3);
}

#[test]
fn nav_12_floating_windows_are_not_snap_targets() {
    let root = LayoutNode::Stage(StageNode {
        id: "stage".into(),
        child: None,
    });
    let entries = focus_layout(Some(&root), None);
    assert_eq!(entries["stage"].rect, Rect::new(0., 0., 1., 1.));
    assert_eq!(best_fit(Rect::new(0.2, 0.3, 0.5, 0.4), &entries), "stage");
}
