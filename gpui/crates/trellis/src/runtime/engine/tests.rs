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
    let mut views = std::collections::BTreeMap::new();
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
        let clock = Rc::new(Cell::new(1000.));
        let time = clock.clone();
        let engine = Engine::new(options(), lattice_doc(), W, H).with_clock(move || time.get());
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
    rig.drag("docs", Some("b"), from, Point::new(pdf.x + pdf.w - 30., pdf.y + pdf.h / 2.));
    let root = rig.root();
    assert_eq!(root.children.len(), 4, "{:?}", ids(root));
    assert_eq!(locate_panel(rig.engine.doc(), "docs").unwrap().panel().views, ["a"]);
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
    rig.drag("panel-pdf", None, from, Point::new(docs.x - 3., docs.y + docs.h / 2.));
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
    assert_eq!(locate_panel(rig.engine.doc(), "docs").unwrap().panel().views, ["b", "a"]);
}

#[test]
fn a_hidden_tab_comes_back_at_its_index() {
    let mut rig = Rig::new();
    rig.engine.hide("project", None);
    rig.settle();
    assert_eq!(
        locate_panel(rig.engine.doc(), "panel-project").unwrap().panel().views,
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
    let pdf = frame.panels.iter().find(|p| p.id == "panel-pdf").expect("still flying");
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
    assert_eq!(labels, ["dock", "move", "hide", "close"], "a float has no Maximize");
    rig.engine.run_menu_action(&MenuAction::Dock("panel-pdf".into()));
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
    assert_eq!(ids, ["maximize", "float", "move", "hide", "-", "close", "close-others"]);
    let MenuEntry::Item(maximize) = &menu[0] else { panic!() };
    assert_eq!(maximize.shortcut.as_deref(), Some("⌘⇧↩"));
    let MenuEntry::Item(moves) = &menu[2] else { panic!() };
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
        ["project +1", "papers", "pdf", "New split right", "New split below"]
    );
}

#[test]
fn maximize_zooms_the_camera_and_restores_the_layout() {
    let mut rig = Rig::new();
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
    assert_eq!(rig.rect("docs").w, docs.w.min(rig.rect("docs").w));
    assert!(rig.rect("docs").w < W / 2.);
}

#[test]
fn a_divider_stops_at_the_minimums_then_springs_back_from_its_stretch() {
    let mut rig = Rig::new();
    rig.engine.divider_down("row", 0);
    let docs = rig.rect("docs");
    rig.engine.divider_move(Point::new(20., 300.));
    rig.frame();
    // Stretched past the limit while held.
    let column = rig.rect("panel-project");
    rig.engine.divider_up(false);
    rig.advance(800.);
    let settled = rig.rect("panel-project");
    assert!(settled.w >= column.w, "springs back out to the limit");
    // Project and the Agent keep the Agent's 220px minimum.
    assert!(settled.w >= 220. - 0.5, "{}", settled.w);
    assert!(rig.rect("docs").w > docs.w);
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
    // Three columns of their widest minimums and the gaps between them.
    assert!(rig.engine.min_width() > 220. + 180. + 220.);
}
