// Tests for the port of DanFessler/trellis 0.2.0 (Trellis Public License v1.0 Non-Commercial): the engine
// driven as the GPUI view drives it, on a clock the test advances, in Lattice's layout.

use std::{cell::Cell, rc::Rc};

use crate::model::*;
use crate::runtime::keymap::{Command, KeyPress, keymap_with};

use super::*;

const W: f64 = 1416.;
const H: f64 = 845.;

fn panel(id: &str, views: &[&str]) -> LayoutNode {
    LayoutNode::Panel(PanelNode {
        id: id.into(),
        views: views.iter().map(|v| v.to_string()).collect(),
        selected: views[0].to_string(),
    })
}

/// Lattice's default row with a documents panel: Project and the Agent over
/// Papers, the documents, the PDF.
fn lattice_doc() -> LayoutDocument {
    let mut views = crate::model::Views::new();
    for (id, kind) in [
        ("project", "project"),
        ("agent", "agent"),
        ("papers", "papers"),
        ("pdf", "pdf"),
        ("a", "file"),
        ("b", "file"),
    ] {
        views.insert(
            id.to_string(),
            ViewRecord {
                kind: kind.into(),
                ..Default::default()
            },
        );
    }
    LayoutDocument {
        root: Some(LayoutNode::Split(SplitNode {
            id: "row".into(),
            axis: Axis::X,
            weights: vec![0.36 * 0.54, 0.46, 0.64 * 0.54],
            children: vec![
                LayoutNode::Split(SplitNode {
                    id: "column".into(),
                    axis: Axis::Y,
                    weights: vec![0.62, 0.38],
                    children: vec![
                        panel("panel-project", &["project", "agent"]),
                        panel("panel-papers", &["papers"]),
                    ],
                }),
                panel("docs", &["a", "b"]),
                panel("panel-pdf", &["pdf"]),
            ],
        })),
        views,
        ..Default::default()
    }
}

fn options() -> Options {
    let mut types = std::collections::HashMap::new();
    let rules = |w: f64, h: f64, singleton: bool| ViewRules {
        singleton,
        min_size: Some(Size {
            width: w,
            height: h,
        }),
        scaling: Scaling::Off,
        ..Default::default()
    };
    for (kind, r) in [
        ("project", rules(140., 120., true)),
        ("papers", rules(180., 120., true)),
        ("agent", rules(220., 240., true)),
        ("pdf", rules(220., 160., true)),
        ("file", rules(180., 140., false)),
    ] {
        types.insert(
            kind.to_string(),
            ViewType {
                title: Some(kind.to_string()),
                rules: r,
            },
        );
    }
    Options {
        types,
        floating: Some(FloatingLayer::Overlay),
        navigation: NavigationMode::Free,
        motion: Motion::Full,
        keymap: keymap_with(&[
            (Command::NavigationOverview, None),
            (Command::TabPrevious, Some("Mod+Shift+[")),
            (Command::TabNext, Some("Mod+Shift+]")),
        ]),
        tabbar_height: 40.,
        mac: true,
        ..Default::default()
    }
}

struct Rig {
    engine: Engine,
    clock: Rc<Cell<f64>>,
}

impl Rig {
    fn new() -> Rig {
        Rig::with(lattice_doc())
    }

    fn with(doc: LayoutDocument) -> Rig {
        let clock = Rc::new(Cell::new(1000.));
        let time = clock.clone();
        let engine = Engine::new(options(), doc, W, H).with_clock(move || time.get());
        let mut rig = Rig { engine, clock };
        rig.settle();
        rig
    }

    fn frame(&mut self) -> Frame {
        let frame = self.engine.frame(&mut |_| None);
        // As the view does: report each strip's tabs, 100px apparts from the
        // panel's left edge.
        for p in &frame.panels {
            let bar = Rect::new(p.rect.x, p.rect.y, p.rect.w, 40.);
            let tabs = p
                .tabs
                .iter()
                .enumerate()
                .map(|(i, t)| {
                    (
                        t.view_id.clone(),
                        Rect::new(p.rect.x + 6. + 102. * i as f64, p.rect.y + 6., 100., 28.),
                    )
                })
                .collect();
            self.engine.set_tab_boxes(&p.id, bar, bar, tabs);
        }
        frame
    }

    /// Run frames for `ms`, 16ms apart.
    fn advance(&mut self, ms: f64) {
        let end = self.clock.get() + ms;
        while self.clock.get() < end {
            self.clock.set(self.clock.get() + 16.);
            self.frame();
        }
    }

    fn settle(&mut self) {
        self.frame();
        self.advance(1500.);
    }

    fn rect(&self, panel: &str) -> Rect {
        self.engine.panel_rect(panel).expect("drawn")
    }

    fn tab(&self, panel: &str, index: usize) -> Point {
        let r = self.rect(panel);
        Point::new(r.x + 6. + 102. * index as f64 + 50., r.y + 20.)
    }

    /// Press at `from`, move in steps to `to`, rest there past the settle
    /// delay, release.
    fn drag(&mut self, panel: &str, view: Option<&str>, from: Point, to: Point) {
        self.engine.drag_begin(panel, view, from);
        for i in 1..=10 {
            let t = i as f64 / 10.;
            self.engine.drag_move(Point::new(
                from.x + (to.x - from.x) * t,
                from.y + (to.y - from.y) * t,
            ));
            self.advance(16.);
        }
        self.advance(200.);
        self.engine.drag_end(true);
        self.settle();
    }

    fn root(&self) -> &SplitNode {
        self.engine.doc().root.as_ref().unwrap().as_split().unwrap()
    }
}

fn ids(split: &SplitNode) -> Vec<&str> {
    split.children.iter().map(|c| c.id()).collect()
}

#[test]
fn the_layout_keeps_six_pixel_gutters_and_edges() {
    let rig = Rig::new();
    let project = rig.rect("panel-project");
    let docs = rig.rect("docs");
    // Half a gutter of padding plus half a gutter of inset: 6px from the edge.
    assert_eq!((project.x, project.y), (6., 6.));
    assert_eq!(docs.x - (project.x + project.w), 6.);
    let pdf = rig.rect("panel-pdf");
    assert_eq!((W - (pdf.x + pdf.w)).round(), 6.);
}

#[test]
fn a_tab_dragged_to_a_panels_right_edge_splits_beside_it() {
    let mut rig = Rig::new();
    let pdf = rig.rect("panel-pdf");
    let from = rig.tab("docs", 1);
    rig.drag(
        "docs",
        Some("b"),
        from,
        Point::new(pdf.x + pdf.w - 30., pdf.y + pdf.h / 2.),
    );
    let root = rig.root();
    assert_eq!(root.children.len(), 4, "{:?}", ids(root));
    assert_eq!(
        locate_panel(rig.engine.doc(), "docs")
            .unwrap()
            .panel()
            .views,
        ["a"]
    );
    let last = root.children[3].as_panel().unwrap();
    assert_eq!(last.views, ["b"]);
}

#[test]
fn a_tab_dropped_on_a_strip_joins_it_at_the_index_under_the_pointer() {
    let mut rig = Rig::new();
    let from = rig.tab("docs", 1);
    let to = rig.tab("panel-project", 0);
    rig.drag("docs", Some("b"), from, Point::new(to.x - 30., to.y));
    let group = locate_panel(rig.engine.doc(), "panel-project").unwrap();
    assert_eq!(group.panel().views, ["b", "project", "agent"]);
    assert_eq!(group.panel().selected, "b");
}

#[test]
fn a_whole_panel_dragged_to_a_seam_lands_between_its_neighbours() {
    let mut rig = Rig::new();
    let docs = rig.rect("docs");
    let pdf = rig.rect("panel-pdf");
    // The strip's empty end drags the whole panel.
    let from = Point::new(pdf.x + pdf.w - 60., pdf.y + 20.);
    rig.drag(
        "panel-pdf",
        None,
        from,
        Point::new(docs.x - 3., docs.y + docs.h / 2.),
    );
    assert_eq!(ids(rig.root()), ["column", "panel-pdf", "docs"]);
}

#[test]
fn escape_cancels_a_drag_and_everything_returns() {
    let mut rig = Rig::new();
    let before = rig.engine.doc().clone();
    let from = rig.tab("docs", 1);
    let pdf = rig.rect("panel-pdf");
    rig.engine.drag_begin("docs", Some("b"), from);
    rig.engine.drag_move(Point::new(pdf.x + 40., pdf.y + 200.));
    rig.advance(300.);
    assert!(rig.engine.dragging());
    let outcome = rig.engine.key_down(
        &KeyPress {
            key: "Escape".into(),
            ..Default::default()
        },
        false,
        false,
    );
    assert_eq!(outcome, Some(KeyOutcome::Handled));
    rig.settle();
    assert_eq!(rig.engine.doc(), &before);
}

/// The documents panel with a third tab.
fn three_documents() -> LayoutDocument {
    let mut doc = lattice_doc();
    doc.views.insert(
        "c".into(),
        ViewRecord {
            kind: "file".into(),
            ..Default::default()
        },
    );
    let LayoutNode::Split(row) = doc.root.as_mut().unwrap() else {
        unreachable!()
    };
    row.children[1] = panel("docs", &["a", "b", "c"]);
    doc
}

#[test]
fn a_sorted_tab_moves_only_the_tabs_it_passes() {
    // The rig's tabs are 100px wide and 2px apart, as the strip draws them.
    let mut rig = Rig::with(three_documents());
    let from = rig.tab("docs", 0);
    let offsets = |rig: &Rig| {
        let (offsets, dragged) = rig.engine.tab_sort_offsets("docs").expect("sorting");
        assert_eq!(dragged, "a");
        let at = |id: &str| offsets.get(id).copied().unwrap_or(0.);
        (at("a"), at("b"), at("c"))
    };
    rig.engine.drag_begin("docs", Some("a"), from);
    // Short of b's centre (102px on): a follows the pointer, b and c stay.
    rig.engine.drag_move(Point::new(from.x + 40., from.y));
    assert_eq!(offsets(&rig), (40., 0., 0.));
    // Past it: b takes a's slot, a slides 102px on, c stays.
    rig.engine.drag_move(Point::new(from.x + 110., from.y));
    assert_eq!(offsets(&rig), (110., -102., 0.));
    rig.engine.drag_end(true);
    rig.settle();
    assert_eq!(
        locate_panel(rig.engine.doc(), "docs")
            .unwrap()
            .panel()
            .views,
        ["b", "a", "c"]
    );
}

#[test]
fn sorting_a_tab_inside_its_strip_reorders_without_lifting_it() {
    let mut rig = Rig::new();
    let from = rig.tab("docs", 0);
    rig.engine.drag_begin("docs", Some("a"), from);
    // Along the strip, past b's centre.
    for x in [10., 40., 80., 120.] {
        rig.engine.drag_move(Point::new(from.x + x, from.y));
        rig.advance(16.);
        assert!(!rig.engine.dragging(), "a sort never lifts the tab");
    }
    rig.engine.drag_end(true);
    rig.settle();
    assert_eq!(
        locate_panel(rig.engine.doc(), "docs")
            .unwrap()
            .panel()
            .views,
        ["b", "a"]
    );
}

#[test]
fn a_hidden_tab_comes_back_at_its_index() {
    let mut rig = Rig::new();
    rig.engine.hide("project", None);
    rig.settle();
    assert_eq!(
        locate_panel(rig.engine.doc(), "panel-project")
            .unwrap()
            .panel()
            .views,
        ["agent"]
    );
    let hidden = rig.engine.hidden_panels()[0].id.clone();
    rig.engine.restore(&hidden, None);
    rig.settle();
    let group = locate_panel(rig.engine.doc(), "panel-project").unwrap();
    assert_eq!(group.panel().views, ["project", "agent"]);
    assert_eq!(group.panel().selected, "project");
}

#[test]
fn hiding_flies_the_panel_away_over_three_hundred_ms() {
    let mut rig = Rig::new();
    rig.engine.hide("panel-pdf", None);
    rig.advance(150.);
    let frame = rig.frame();
    let pdf = frame
        .panels
        .iter()
        .find(|p| p.id == "panel-pdf")
        .expect("still flying");
    assert!(pdf.flying && pdf.opacity < 1. && pdf.opacity > 0.1);
    rig.advance(200.);
    assert!(rig.frame().panels.iter().all(|p| p.id != "panel-pdf"));
}

#[test]
fn float_then_dock_from_the_menu() {
    let mut rig = Rig::new();
    let menu = rig.engine.built_in_menu("panel-pdf");
    let float = menu
        .iter()
        .find_map(|e| match e {
            MenuEntry::Item(i) if i.id == "float" => i.action.clone(),
            _ => None,
        })
        .expect("Float");
    rig.engine.run_menu_action(&float);
    rig.settle();
    assert_eq!(rig.engine.doc().floating.len(), 1);
    let floating = rig.rect("panel-pdf");
    assert!(floating.w <= 560. && floating.h <= 400.);
    let menu = rig.engine.built_in_menu("panel-pdf");
    let labels: Vec<String> = menu
        .iter()
        .filter_map(|e| match e {
            MenuEntry::Item(i) => Some(i.id.clone()),
            MenuEntry::Separator => None,
        })
        .collect();
    assert_eq!(
        labels,
        ["dock", "move", "hide", "close"],
        "a float has no Maximize"
    );
    rig.engine
        .run_menu_action(&MenuAction::Dock("panel-pdf".into()));
    rig.settle();
    assert!(rig.engine.doc().floating.is_empty());
    let root = rig.root();
    assert_eq!(root.children.last().unwrap().id(), "panel-pdf");
    assert!((root.weights.last().unwrap() - 0.3).abs() < 1e-9);
}

#[test]
fn the_menu_lists_trellis_items_in_order() {
    let rig = Rig::new();
    let menu = rig.engine.panel_menu("docs", Vec::new());
    let ids: Vec<String> = menu
        .iter()
        .map(|e| match e {
            MenuEntry::Item(i) => i.id.clone(),
            MenuEntry::Separator => "-".into(),
        })
        .collect();
    assert_eq!(
        ids,
        [
            "maximize",
            "float",
            "move",
            "hide",
            "-",
            "close",
            "close-others"
        ]
    );
    let MenuEntry::Item(maximize) = &menu[0] else {
        panic!()
    };
    assert_eq!(maximize.shortcut.as_deref(), Some("⌘⇧↩"));
    let MenuEntry::Item(moves) = &menu[2] else {
        panic!()
    };
    let targets: Vec<&str> = moves
        .items
        .iter()
        .map(|e| match e {
            MenuEntry::Item(i) => i.label.as_str(),
            MenuEntry::Separator => "-",
        })
        .collect();
    assert_eq!(
        targets,
        [
            "project +1",
            "papers",
            "pdf",
            "New split right",
            "New split below"
        ]
    );
}

#[test]
fn maximize_zooms_the_camera_and_restores_the_layout() {
    let mut rig = Rig::new();
    let ids = ["panel-project", "panel-papers", "docs", "panel-pdf"];
    let before: Vec<Rect> = ids.iter().map(|id| rig.rect(id)).collect();
    rig.engine.focus("docs");
    let press = KeyPress {
        key: "Enter".into(),
        meta: true,
        shift: true,
        ..Default::default()
    };
    rig.engine.key_down(&press, false, true);
    assert_eq!(rig.engine.framed(), Some("docs"));
    rig.advance(1200.);
    let docs = rig.rect("docs");
    assert_eq!((docs.x, docs.y, docs.w, docs.h), (6., 6., W - 12., H - 12.));
    // The rest stays laid out, off screen.
    assert!(rig.engine.panel_rect("panel-pdf").unwrap().x >= W - 1.);
    rig.engine.key_down(&press, false, true);
    rig.advance(1200.);
    assert_eq!(rig.engine.framed(), None);
    let after: Vec<Rect> = ids.iter().map(|id| rig.rect(id)).collect();
    assert_eq!(after, before, "every panel back where it was");
}

#[test]
fn a_divider_stops_at_the_minimums_then_springs_back_from_its_stretch() {
    let mut rig = Rig::new();
    let column = rig.rect("panel-project");
    let docs = rig.rect("docs");
    rig.engine.divider_down("row", 0);
    rig.engine.divider_move(Point::new(20., 300.));
    rig.frame();
    // Stretched past the limit while held: narrower than the minimum.
    assert!(rig.rect("panel-project").w < 220. - 1.);
    rig.engine.divider_up(false);
    rig.advance(800.);
    assert!(!rig.engine.dividers.springing());
    // Project and the Agent settle at the Agent's 220px minimum, and the
    // documents take exactly the room the column gave up.
    let settled = rig.rect("panel-project");
    assert!((settled.w - 220.).abs() < 0.5, "{}", settled.w);
    let grown = rig.rect("docs");
    assert!((grown.x - (6. + 220. + 6.)).abs() < 0.5, "{}", grown.x);
    assert!(
        ((grown.x + grown.w) - (docs.x + docs.w)).abs() < 0.5,
        "the documents' right edge stays"
    );
    assert!(column.w > 220.);
    let weights: f64 = rig.root().weights.iter().sum();
    assert!((weights - 1.).abs() < 1e-9, "{weights}");
}

#[test]
fn closing_a_panel_while_its_divider_springs_back_lays_out_the_rest() {
    let mut rig = Rig::new();
    // The divider between the documents and the PDF, pulled far past the
    // PDF's minimum and let go.
    rig.engine.divider_down("row", 1);
    rig.engine.divider_move(Point::new(W - 10., 300.));
    rig.frame();
    rig.engine.divider_up(false);
    assert!(rig.engine.dividers.springing());
    rig.advance(48.);
    assert!(rig.engine.close("pdf"));
    rig.advance(800.);
    assert_eq!(ids(rig.root()), ["column", "docs"]);
    let docs = rig.rect("docs");
    assert!(((docs.x + docs.w) - (W - 6.)).abs() < 0.5, "{docs:?}");
}

#[test]
fn closing_a_panel_while_a_divider_is_held_lets_go_of_the_divider() {
    let mut rig = Rig::new();
    rig.engine.divider_down("row", 1);
    rig.engine.divider_move(Point::new(W - 10., 300.));
    rig.engine.drain_events();
    assert!(rig.engine.close("pdf"));
    assert_eq!(rig.engine.resizing(), None);
    rig.engine.divider_move(Point::new(W - 300., 300.));
    rig.engine.divider_up(false);
    rig.settle();
    assert_eq!(ids(rig.root()), ["column", "docs"]);
    let closes = rig
        .engine
        .drain_events()
        .into_iter()
        .filter(|e| matches!(e, Event::Close(_) | Event::Open(_)))
        .count();
    assert_eq!(closes, 1, "the PDF closes once and nothing reopens");
}

#[test]
fn a_view_closed_while_a_tab_is_torn_out_stays_closed_and_the_tab_goes_home() {
    let mut rig = Rig::new();
    let from = rig.tab("docs", 1);
    let pdf = rig.rect("panel-pdf");
    rig.engine.drag_begin("docs", Some("b"), from);
    rig.engine.drag_move(Point::new(pdf.x + 40., pdf.y + 200.));
    rig.advance(300.);
    assert!(rig.engine.dragging());
    rig.engine.drain_events();
    assert!(rig.engine.close("pdf"));
    assert!(!rig.engine.dragging(), "the press is over");
    // The release that follows changes nothing.
    rig.engine.drag_end(true);
    rig.settle();
    let events: Vec<Event> = rig
        .engine
        .drain_events()
        .into_iter()
        .filter(|e| matches!(e, Event::Close(_) | Event::Open(_)))
        .collect();
    assert_eq!(events, [Event::Close("pdf".into())]);
    assert_eq!(
        locate_panel(rig.engine.doc(), "docs")
            .unwrap()
            .panel()
            .views,
        ["a", "b"]
    );
    assert!(panel_of_view(rig.engine.doc(), "pdf").is_none());
}

#[test]
fn the_torn_out_tab_closed_mid_drag_is_reported_closed() {
    let mut rig = Rig::new();
    let from = rig.tab("docs", 1);
    let pdf = rig.rect("panel-pdf");
    rig.engine.drag_begin("docs", Some("b"), from);
    rig.engine.drag_move(Point::new(pdf.x + 40., pdf.y + 200.));
    rig.advance(300.);
    rig.engine.drain_events();
    assert!(rig.engine.close("b"));
    rig.engine.drag_end(true);
    rig.settle();
    let events: Vec<Event> = rig
        .engine
        .drain_events()
        .into_iter()
        .filter(|e| matches!(e, Event::Close(_) | Event::Open(_)))
        .collect();
    assert_eq!(events, [Event::Close("b".into())]);
    assert!(!rig.engine.doc().views.contains_key("b"));
    assert!(panel_of_view(rig.engine.doc(), "b").is_none());
}

#[test]
fn f6_moves_the_keyboard_through_the_panels() {
    let mut rig = Rig::new();
    rig.engine.focus("docs");
    let outcome = rig.engine.run(Command::PanelNext);
    assert_eq!(outcome, KeyOutcome::FocusTab("pdf".into()));
    assert_eq!(rig.engine.focused_panel(), Some("panel-pdf"));
}

#[test]
fn the_window_minimum_follows_the_layouts_minimums() {
    let rig = Rig::new();
    // Three columns at their minimums with 6px gutters and edges: the
    // Agent's 220px, the two-tab documents' unmeasured header (41 + 4 +
    // 80 per tab + 2 between, 207px, over the files' 180px) and the PDF's
    // 220px.
    assert_eq!(
        rig.engine.min_width(),
        6. + 220. + 6. + 207. + 6. + 220. + 6.
    );
}

#[test]
fn an_animated_document_change_draws_every_panel_on_its_first_frame() {
    let mut rig = Rig::new();
    // Writing-like: the navigators parked hidden, then the default again.
    let mut writing = lattice_doc();
    let LayoutNode::Split(root) = writing.root.as_mut().unwrap() else {
        unreachable!()
    };
    root.children.remove(0);
    root.weights = vec![0.5, 0.5];
    writing.hidden.push(HiddenPanel {
        panel: PanelNode {
            id: "panel-project".into(),
            views: vec!["project".into(), "agent".into()],
            selected: "project".into(),
        },
        restore: RestoreTarget::Docked {
            beside: "row".into(),
            edge: Edge::Left,
            share: 0.3,
        },
    });
    rig.engine.set_document(writing, true);
    rig.settle();
    rig.engine.set_document(lattice_doc(), true);
    rig.frame();
    for id in ["panel-project", "panel-papers", "docs", "panel-pdf"] {
        assert!(rig.engine.panel_rect(id).is_some(), "{id} has no rect");
    }
}
