// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The rough.js port (`board::rough`) against the real roughjs 4.6.4:
//! `fixtures/board/rough.json` holds the drawables roughjs generates for
//! fixed seeds and options (made by `fixtures/board/rough_gen.cjs`, which
//! stubs `Math.random` with the same mulberry32 stream the port uses, and
//! rounds to 1e-8). Plus the Excalidraw layer on top: `generateRoughOptions`,
//! shapes per element, and the dark-mode color filter.

mod board {
    use lattice_board_core::board::color::{Rgba, apply_dark_mode_filter, parse_color};
    use lattice_board_core::board::display::{
        DisplayItem, Paint, RenderOpts, element_display, theme_color,
    };
    use lattice_board_core::board::new_element::*;
    use lattice_board_core::board::rough::{self, Drawable, FillStyle, Op, OpSetType, Options};
    use lattice_board_core::board::shape::*;
    use lattice_board_core::board::text_measure::Measure;
    use lattice_board_core::board::types::*;
    use serde_json::Value;

    struct TestMeasure;
    impl Measure for TestMeasure {
        fn line_width(&self, t: &str, f: lattice_board_core::board::text_measure::Font) -> f64 {
            t.chars().count() as f64 * f.size * 0.5
        }
    }

    fn options(v: &Value) -> Options {
        let mut o = Options::default();
        let m = v.as_object().unwrap();
        let f = |k: &str| m.get(k).and_then(Value::as_f64);
        let b = |k: &str| m.get(k).and_then(Value::as_bool);
        if let Some(x) = f("seed") {
            o.seed = x as i64;
        }
        if let Some(x) = f("roughness") {
            o.roughness = x;
        }
        if let Some(x) = f("bowing") {
            o.bowing = x;
        }
        if let Some(x) = f("strokeWidth") {
            o.stroke_width = x;
        }
        if let Some(x) = f("curveFitting") {
            o.curve_fitting = x;
        }
        if let Some(x) = f("fillWeight") {
            o.fill_weight = x;
        }
        if let Some(x) = f("hachureGap") {
            o.hachure_gap = x;
        }
        if let Some(x) = f("hachureAngle") {
            o.hachure_angle = x;
        }
        if let Some(x) = f("zigzagOffset") {
            o.zigzag_offset = x;
        }
        if let Some(x) = f("dashOffset") {
            o.dash_offset = x;
        }
        if let Some(x) = f("dashGap") {
            o.dash_gap = x;
        }
        if let Some(x) = f("simplification") {
            o.simplification = Some(x);
        }
        if let Some(x) = b("disableMultiStroke") {
            o.disable_multi_stroke = x;
        }
        if let Some(x) = b("disableMultiStrokeFill") {
            o.disable_multi_stroke_fill = x;
        }
        if let Some(x) = b("preserveVertices") {
            o.preserve_vertices = x;
        }
        if let Some(x) = m.get("fill").and_then(Value::as_str) {
            o.fill = Some(x.into());
        }
        if let Some(d) = m.get("strokeLineDash").and_then(Value::as_array) {
            o.stroke_line_dash = Some(d.iter().filter_map(Value::as_f64).collect());
        }
        if let Some(s) = m.get("fillStyle").and_then(Value::as_str) {
            o.fill_style = match s {
                "solid" => FillStyle::Solid,
                "zigzag" => FillStyle::Zigzag,
                "cross-hatch" => FillStyle::CrossHatch,
                "dots" => FillStyle::Dots,
                "dashed" => FillStyle::Dashed,
                "zigzag-line" => FillStyle::ZigzagLine,
                _ => FillStyle::Hachure,
            };
        }
        o
    }

    fn points(v: &Value) -> Vec<[f64; 2]> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|p| [p[0].as_f64().unwrap(), p[1].as_f64().unwrap()])
            .collect()
    }

    fn generate(c: &Value) -> Drawable {
        let a = c["args"].as_array().unwrap();
        let n = |i: usize| a[i].as_f64().unwrap();
        let o = options(&c["options"]);
        match c["call"].as_str().unwrap() {
            "rectangle" => rough::rectangle(n(0), n(1), n(2), n(3), &o),
            "ellipse" => rough::ellipse(n(0), n(1), n(2), n(3), &o),
            "circle" => rough::circle(n(0), n(1), n(2), &o),
            "line" => rough::line(n(0), n(1), n(2), n(3), &o),
            "linearPath" => rough::linear_path(&points(&a[0]), &o),
            "polygon" => rough::polygon(&points(&a[0]), &o),
            "curve" => rough::curve(&points(&a[0]), &o),
            "path" => rough::path(a[0].as_str().unwrap(), &o),
            "arc" => rough::arc(
                n(0),
                n(1),
                n(2),
                n(3),
                n(4),
                n(5),
                a[6].as_bool().unwrap(),
                &o,
            ),
            other => panic!("unknown call {other}"),
        }
    }

    fn op_data(o: &Op) -> (&'static str, Vec<f64>) {
        match *o {
            Op::Move(p) => ("move", p.to_vec()),
            Op::LineTo(p) => ("lineTo", p.to_vec()),
            Op::BCurveTo(a, b, c) => ("bcurveTo", vec![a[0], a[1], b[0], b[1], c[0], c[1]]),
        }
    }

    #[test]
    fn matches_roughjs() {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/board/rough.json")).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() > 80);
        let mut ops_checked = 0;
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let d = generate(c);
            let sets = c["sets"].as_array().unwrap();
            assert_eq!(d.sets.len(), sets.len(), "{name}: set count");
            for (si, (ours, theirs)) in d.sets.iter().zip(sets).enumerate() {
                let ty = match ours.ty {
                    OpSetType::Path => "path",
                    OpSetType::FillPath => "fillPath",
                    OpSetType::FillSketch => "fillSketch",
                };
                assert_eq!(
                    ty,
                    theirs["type"].as_str().unwrap(),
                    "{name}: set {si} type"
                );
                let ops = theirs["ops"].as_array().unwrap();
                assert_eq!(ours.ops.len(), ops.len(), "{name}: set {si} op count");
                for (oi, (o, t)) in ours.ops.iter().zip(ops).enumerate() {
                    let t = t.as_array().unwrap();
                    let (kind, data) = op_data(o);
                    assert_eq!(kind, t[0].as_str().unwrap(), "{name}: set {si} op {oi}");
                    for (k, v) in data.iter().enumerate() {
                        let e = t[k + 1].as_f64().unwrap();
                        assert!(
                            (v - e).abs() < 1e-6,
                            "{name}: set {si} op {oi}[{k}]: {v} vs roughjs {e}"
                        );
                    }
                    ops_checked += 1;
                }
            }
        }
        assert!(ops_checked > 7000, "{ops_checked}");
    }

    #[test]
    fn path_data_parsing() {
        use rough::path_data::*;
        let s = normalize(&absolutize(&parse_path("m10 10 h5 v5 l-5 0 z")));
        let keys: String = s.iter().map(|g| g.key).collect();
        assert_eq!(keys, "MLLLZ");
        assert_eq!(s[1].data, vec![15., 10.]);
        assert_eq!(s[3].data, vec![10., 15.]);
        // numbers glued to commands and signs, exponents
        let p = parse_path("M1e1-2.5L.5.5");
        assert_eq!(p[0].data, vec![10., -2.5]);
        assert_eq!(p[1].data, vec![0.5, 0.5]);
        // a quadratic becomes the equivalent cubic
        let q = normalize(&parse_path("M0 0 Q 30 0, 30 30"));
        assert_eq!(q[1].data, vec![20., 0., 30., 10., 30., 30.]);
        assert!(parse_path("M0 0 L 5").is_empty());
    }

    fn el(ty: ElementType, w: f64, h: f64, f: impl FnOnce(&mut ElementOpts)) -> Element {
        let mut o = ElementOpts {
            width: w,
            height: h,
            seed: Some(5),
            stroke_color: "#1e1e1e".into(),
            ..Default::default()
        };
        f(&mut o);
        new_element(ty, o)
    }

    #[test]
    fn rough_options_follow_the_element() {
        let e = el(ElementType::Rectangle, 100., 80., |o| {
            o.stroke_style = StrokeStyle::Dashed;
            o.stroke_width = 2.;
            o.background_color = "#ffc9c9".into();
            o.roughness = 2.;
        });
        let o = generate_rough_options(&e, false);
        assert_eq!(o.seed, 5);
        assert_eq!(o.stroke_line_dash, Some(vec![8., 10.]));
        assert!(o.disable_multi_stroke);
        assert_eq!(
            (o.stroke_width, o.fill_weight, o.hachure_gap),
            (2.5, 1., 8.)
        );
        assert_eq!(o.roughness, 2.);
        assert!(!o.preserve_vertices);
        assert_eq!(o.fill.as_deref(), Some("#ffc9c9"));
        assert!(generate_rough_options(&e, true).preserve_vertices);
        // small shapes are drawn less rough
        let s = el(ElementType::Rectangle, 8., 8., |o| o.roughness = 2.);
        assert!((adjust_roughness(&s) - 2. / 3.).abs() < 1e-12);
        let s = el(ElementType::Rectangle, 30., 12., |o| o.roughness = 1.);
        assert_eq!(adjust_roughness(&s), 0.5);
        // ellipses fit their curve exactly, transparent backgrounds don't fill
        let e = el(ElementType::Ellipse, 100., 80., |_| {});
        let o = generate_rough_options(&e, false);
        assert_eq!(o.curve_fitting, 1.);
        assert_eq!(o.fill, None);
        assert!(o.preserve_vertices);
    }

    #[test]
    fn element_shapes() {
        // a hachured rectangle: fill sketch, then the outline, two strokes per side
        let e = el(ElementType::Rectangle, 100., 80., |o| {
            o.background_color = "#a5d8ff".into();
            o.fill_style = FillStyleE::Hachure;
            o.roughness = 1.;
        });
        let ElementShape::Single(d) = generate_element_shape(&e) else {
            panic!()
        };
        assert_eq!(d.shape, rough::ShapeKind::Rectangle);
        assert_eq!(
            d.sets.iter().map(|s| s.ty).collect::<Vec<_>>(),
            [OpSetType::FillSketch, OpSetType::Path]
        );
        assert_eq!(d.sets[1].ops.len(), 16);
        assert_eq!(
            d,
            rough::rectangle(0., 0., 100., 80., &generate_rough_options(&e, false))
        );
        // same seed, same drawing
        assert_eq!(generate_element_shape(&e), generate_element_shape(&e));
        // rounded rectangles are rough paths
        let r = el(ElementType::Rectangle, 100., 80., |o| {
            o.roundness = Some(Roundness {
                kind: 3,
                value: None,
            })
        });
        let ElementShape::Single(d) = generate_element_shape(&r) else {
            panic!()
        };
        assert_eq!(d.shape, rough::ShapeKind::Path);
        // an arrow: the line, then its arrowhead lines; the head follows the jittered end
        let a = new_arrow_element(
            ElementOpts {
                width: 100.,
                height: 0.,
                seed: Some(9),
                roughness: 1.,
                ..Default::default()
            },
            vec![[0., 0.], [100., 0.]],
            None,
            Some(Arrowhead::Arrow),
            false,
            None,
        );
        let ElementShape::Linear(parts) = generate_element_shape(&a) else {
            panic!()
        };
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].drawable.shape, rough::ShapeKind::LinearPath);
        assert_eq!(
            get_curve_path_ops(&parts[0].drawable),
            &linear_shape_ops(&a)[..]
        );
        // a filled triangle head: a fill along its single outline stroke
        let t = new_arrow_element(
            ElementOpts {
                width: 100.,
                height: 0.,
                seed: Some(9),
                roughness: 2.,
                ..Default::default()
            },
            vec![[0., 0.], [100., 0.]],
            None,
            Some(Arrowhead::TriangleOutline),
            false,
            None,
        );
        let ElementShape::Linear(parts) = generate_element_shape(&t) else {
            panic!()
        };
        let head = &parts[1];
        assert_eq!(head.head_fill, Some(HeadFill::Background));
        assert_eq!(head.drawable.sets[0].ty, OpSetType::FillPath);
        let outline: Vec<[f64; 2]> = head.drawable.sets[1].ops.iter().map(|o| o.end()).collect();
        let fill: Vec<[f64; 2]> = head.drawable.sets[0].ops.iter().map(|o| o.end()).collect();
        assert_eq!(outline, fill);
        assert!(
            head.drawable.sets[0].ops[1..]
                .iter()
                .all(|o| !matches!(o, Op::Move(_)))
        );
    }

    #[test]
    fn display_items_paint_like_rough_canvas() {
        let e = el(ElementType::Rectangle, 100., 80., |o| {
            o.background_color = "#a5d8ff".into();
            o.fill_style = FillStyleE::Hachure;
            o.stroke_width = 2.;
            o.stroke_style = StrokeStyle::Dotted;
        });
        let d =
            element_display(&e, &vec![e.clone()], &TestMeasure, &RenderOpts::default()).unwrap();
        assert_eq!(d.items.len(), 2);
        let DisplayItem::Path {
            fill: None,
            stroke: Some(s),
            ..
        } = &d.items[0]
        else {
            panic!("fill sketch")
        };
        assert_eq!(
            (s.width, s.dash.clone(), s.paint),
            (1., None, Paint::Color(parse_color("#a5d8ff").unwrap()))
        );
        let DisplayItem::Path {
            fill: None,
            stroke: Some(s),
            ..
        } = &d.items[1]
        else {
            panic!("outline")
        };
        assert_eq!((s.width, s.dash.clone()), (2.5, Some(vec![1.5, 8.])));
        // solid fills fill; transparent strokes paint nothing
        let e = el(ElementType::Ellipse, 100., 80., |o| {
            o.background_color = "#a5d8ff".into();
            o.fill_style = FillStyleE::Solid;
            o.stroke_color = "transparent".into();
        });
        let d =
            element_display(&e, &vec![e.clone()], &TestMeasure, &RenderOpts::default()).unwrap();
        assert_eq!(d.items.len(), 1);
        assert!(matches!(
            &d.items[0],
            DisplayItem::Path {
                fill: Some(_),
                stroke: None,
                ..
            }
        ));
    }
    use lattice_board_core::board::types::FillStyle as FillStyleE;

    #[test]
    fn dark_mode_filter() {
        // upstream applyDarkModeFilter values
        let f = |s: &str| apply_dark_mode_filter(parse_color(s).unwrap());
        assert_eq!(f("#ffffff"), Rgba::rgb(0x12, 0x12, 0x12));
        assert_eq!(f("#000000"), Rgba::rgb(0xed, 0xed, 0xed));
        assert_eq!(f("#1e1e1e"), Rgba::rgb(0xd3, 0xd3, 0xd3));
        assert_eq!(f("#e03131").a, 255);
        assert_eq!(f("#ff000080").a, 0x80);
        // the sticky note's shadow stays black, its paper is filtered
        let shadow = Rgba::BLACK.with_alpha(0.16);
        assert_eq!(theme_color(shadow, ElementType::StickyNote, true), shadow);
        assert_eq!(
            theme_color(Rgba::rgb(255, 223, 107), ElementType::StickyNote, true),
            apply_dark_mode_filter(Rgba::rgb(255, 223, 107))
        );
        assert_eq!(theme_color(shadow, ElementType::Rectangle, false), shadow);
    }
}
