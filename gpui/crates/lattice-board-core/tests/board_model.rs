// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The board's model layer: upstream Excalidraw tests @ 3a317b5 translated
//! with their inputs and expected values, plus a file round trip.
//! - element/tests/newElement.test.ts, typeChecks.test.ts, sortElements.test.ts,
//!   fractionalIndex.test.ts
//! - excalidraw/tests/data/restore.test.ts (restoreElements, bumpElementVersions,
//!   repairing bindings), snapshots from its `__snapshots__`
//!
//! Skipped, with reasons:
//! - restore "should strip element if restore fails": needs a throwing
//!   property getter; JSON input can't throw.
//! - restore "should return empty array when isInvisiblySmallElement is true"
//!   mocks the size helper; here a 0×0 rectangle makes it true instead.
//! - restore "should not call isInvisiblySmallElement when element is a
//!   selection element": spy count; the selection element is still checked
//!   to be dropped.
//! - restore "should refit a sticky note … when refreshing dimensions": in
//!   board_text.rs, with the text tests.
//! - restoreAppState tests: they cover editor state (`cursorButton`, `name`,
//!   `activeTool`, `zoom`, `openSidebar`, top picks, sticky defaults, stroke
//!   width key) that isn't saved with our files; the saved fields have their
//!   own test below.
//! - restoreLibraryItems: no libraries.
//! - sortElements "normalize boundElements array" and the perf test are
//!   `it.skip` upstream.
//! - typeChecks "NonDeleted type": compile-time checks; the runtime parts are kept.

// in a `board` module so `cargo test board` selects these
mod board {
    use lattice_board_core::board::consts::*;
    use lattice_board_core::board::fractional_index::*;
    use lattice_board_core::board::json::*;
    use lattice_board_core::board::math::Point;
    use lattice_board_core::board::mutate::*;
    use lattice_board_core::board::new_element::*;
    use lattice_board_core::board::random::reseed;
    use lattice_board_core::board::restore::*;
    use lattice_board_core::board::scene::*;
    use lattice_board_core::board::text_measure::*;
    use lattice_board_core::board::types::*;
    use lattice_board_core::board::utils::*;
    use rustc_hash::FxHashSet;
    use serde_json::{Value, json};

    fn setup() {
        reseed(1);
        fix_timestamp(Some(1));
    }

    // ---------------------------------------------------------------------------
    // API.createElement (excalidraw/tests/helpers/api.ts), default app state
    // ---------------------------------------------------------------------------

    #[derive(Clone)]
    struct Spec {
        id: Option<String>,
        x: f64,
        y: Option<f64>,
        width: f64,
        height: Option<f64>,
        angle: f64,
        is_deleted: bool,
        group_ids: Vec<String>,
        frame_id: Option<String>,
        index: Option<String>,
        created: Option<Option<i64>>,
        stroke_color: Option<String>,
        background_color: Option<String>,
        fill_style: Option<FillStyle>,
        stroke_width: Option<f64>,
        stroke_style: Option<StrokeStyle>,
        roundness: bool,
        roughness: Option<f64>,
        opacity: Option<f64>,
        text: Option<String>,
        font_size: Option<f64>,
        font_family: Option<u32>,
        text_align: Option<TextAlign>,
        vertical_align: Option<VerticalAlign>,
        bound_elements: Option<Vec<BoundElement>>,
        base_height: Option<f64>,
        container_id: Option<String>,
        points: Option<Vec<Point>>,
        start_binding: Option<FixedPointBinding>,
        end_binding: Option<FixedPointBinding>,
    }

    impl Default for Spec {
        fn default() -> Self {
            Spec {
                id: None,
                x: 0.,
                y: None,
                width: 100.,
                height: None,
                angle: 0.,
                is_deleted: false,
                group_ids: vec![],
                frame_id: None,
                index: None,
                created: None,
                stroke_color: None,
                background_color: None,
                fill_style: None,
                stroke_width: None,
                stroke_style: None,
                roundness: false,
                roughness: None,
                opacity: None,
                text: None,
                font_size: None,
                font_family: None,
                text_align: None,
                vertical_align: None,
                bound_elements: None,
                base_height: None,
                container_id: None,
                points: None,
                start_binding: None,
                end_binding: None,
            }
        }
    }

    fn create(ty: ElementType, f: impl FnOnce(&mut Spec)) -> Element {
        let mut s = Spec::default();
        f(&mut s);
        let (w, h) = (s.width, s.height.unwrap_or(s.width));
        let sticky = ty == ElementType::StickyNote;
        let o = ElementOpts {
            seed: Some(1),
            x: s.x,
            y: s.y.unwrap_or(s.x),
            width: w,
            height: h,
            frame_id: s.frame_id.clone(),
            index: s.index.clone(),
            angle: s.angle,
            stroke_color: s
                .stroke_color
                .clone()
                .unwrap_or_else(|| DEFAULT_STROKE_COLOR.into()),
            background_color: s.background_color.clone().unwrap_or_else(|| {
                (if sticky {
                    DEFAULT_STICKY_NOTE_BG
                } else {
                    DEFAULT_BACKGROUND_COLOR
                })
                .into()
            }),
            fill_style: s.fill_style.unwrap_or(FillStyle::Solid),
            stroke_width: s.stroke_width.unwrap_or(if ty == ElementType::FreeDraw {
                FREEDRAW_STROKE_WIDTH[1]
            } else {
                STROKE_WIDTH[1]
            }),
            stroke_style: s.stroke_style.unwrap_or(StrokeStyle::Solid),
            roundness: s.roundness.then(|| Roundness {
                kind: if ty.uses_adaptive_radius() {
                    roundness::ADAPTIVE_RADIUS
                } else {
                    roundness::PROPORTIONAL_RADIUS
                },
                value: None,
            }),
            roughness: s.roughness.unwrap_or(1.),
            opacity: s.opacity.unwrap_or(100.),
            bound_elements: s.bound_elements.clone(),
            locked: false,
            created: Some(s.created.unwrap_or_else(|| Some(get_updated_timestamp()))),
            ..Default::default()
        };
        let pts = || s.points.clone().unwrap_or(vec![[0., 0.], [100., 100.]]);
        let mut e = match ty {
            ElementType::Rectangle | ElementType::Diamond | ElementType::Ellipse => {
                new_element(ty, o)
            }
            ElementType::Embeddable => new_embeddable_element(o),
            ElementType::Iframe => new_iframe_element(o),
            ElementType::StickyNote => new_sticky_note_element(o, Some(s.base_height.unwrap_or(h))),
            ElementType::Text => {
                let t = TextOpts {
                    text: s
                        .text
                        .clone()
                        .filter(|t| !t.is_empty())
                        .unwrap_or("test".into()),
                    font_size: Some(s.font_size.unwrap_or(DEFAULT_FONT_SIZE)),
                    font_family: Some(s.font_family.unwrap_or(DEFAULT_FONT_FAMILY)),
                    text_align: Some(s.text_align.unwrap_or(TextAlign::Left)),
                    vertical_align: Some(s.vertical_align.unwrap_or(VerticalAlign::Top)),
                    container_id: s.container_id.clone(),
                    ..Default::default()
                };
                let mut e = new_text_element(t, o, &TestMeasure);
                (e.width, e.height) = (w, h);
                e
            }
            ElementType::FreeDraw => {
                new_free_draw_element(o, s.points.clone().unwrap_or_default(), vec![], true, None)
            }
            ElementType::Arrow => new_arrow_element(o, pts(), None, None, false, None),
            ElementType::Line => new_linear_element(o, pts(), None),
            ElementType::Image => {
                new_image_element(o, Some(ImageStatus::Saved), None, Some([1., 1.]), None)
            }
            ElementType::Frame => new_frame_element(o, None),
            ElementType::MagicFrame => new_magic_frame_element(o, None),
            ElementType::Selection => unreachable!(),
        };
        if let Some(l) = e.linear_mut()
            && ty == ElementType::Arrow
        {
            (
                l.start_binding,
                l.end_binding,
                l.start_arrowhead,
                l.end_arrowhead,
            ) = (s.start_binding.clone(), s.end_binding.clone(), None, None);
        }
        if let Some(id) = s.id {
            e.id = id;
        }
        if s.is_deleted {
            e.is_deleted = true;
        }
        e.group_ids = s.group_ids;
        e
    }

    fn rect() -> Element {
        create(ElementType::Rectangle, |_| {})
    }
    fn val(e: &Element) -> Value {
        element_to_value(e)
    }
    fn restore(els: Vec<Value>, opts: RestoreOpts) -> Vec<Element> {
        restore_elements(Some(&Value::Array(els)), None, &opts)
    }
    fn plain() -> RestoreOpts {
        RestoreOpts::default()
    }
    fn repair() -> RestoreOpts {
        RestoreOpts {
            repair_bindings: true,
            ..Default::default()
        }
    }
    fn invisible() -> RestoreOpts {
        RestoreOpts {
            delete_invisible_elements: true,
            ..Default::default()
        }
    }
    fn with(e: &Element, f: impl FnOnce(&mut serde_json::Map<String, Value>)) -> Value {
        let mut v = val(e);
        f(v.as_object_mut().unwrap());
        v
    }
    fn text_bound(id: &str) -> BoundElement {
        BoundElement {
            id: id.into(),
            kind: BoundType::Text,
        }
    }
    fn arrow_bound(id: &str) -> BoundElement {
        BoundElement {
            id: id.into(),
            kind: BoundType::Arrow,
        }
    }

    // ---------------------------------------------------------------------------
    // newElement.test.ts
    // ---------------------------------------------------------------------------

    #[test]
    fn element_creation_time() {
        use ElementType::*;
        for ty in [
            Rectangle, Diamond, Ellipse, Text, Line, Arrow, FreeDraw, Image, Frame, MagicFrame,
            Embeddable, Iframe,
        ] {
            setup();
            fix_timestamp(Some(123));
            let e = create(ty, |_| {});
            assert_eq!(e.created, Some(123), "{ty:?}");
            fix_timestamp(Some(456));
            let mut edited = new_element_with(&e, |e| e.x = 50., false);
            mutate_element(&mut edited, |e| e.y = 50.);
            assert_eq!((edited.created, edited.updated), (Some(123), 456), "{ty:?}");
        }
    }

    #[test]
    fn preserves_explicit_created_when_reconstructing() {
        setup();
        for created in [Some(123), Some(0), None] {
            let original = new_element(
                ElementType::Rectangle,
                ElementOpts {
                    created: Some(created),
                    ..Default::default()
                },
            );
            let converted = new_linear_element(ElementOpts::from_element(&original), vec![], None);
            assert_eq!(converted.id, original.id);
            assert_eq!(converted.created, created);
            assert!(converted.is_line());
        }
    }

    #[test]
    fn new_text_element_is_anchored_by_alignment() {
        setup();
        let t = new_text_element(
            TextOpts {
                text: "text".into(),
                font_size: Some(14.),
                text_align: Some(TextAlign::Center),
                vertical_align: Some(VerticalAlign::Middle),
                ..Default::default()
            },
            ElementOpts::default(),
            &TestMeasure,
        );
        // 4 chars × 10px, 14 × 1.25 line height
        assert_eq!((t.x, t.y, t.width, t.height), (-20., -8.75, 40., 17.5));
        let t = new_text_element(
            TextOpts {
                text: "a\tb\r\nc\n".into(),
                ..Default::default()
            },
            ElementOpts::default(),
            &TestMeasure,
        );
        assert_eq!(t.text().unwrap().text, "a        b\nc\n");
        assert_eq!((t.width, t.height), (100., 3. * 25.));
    }

    #[test]
    fn sticky_notes_are_normalized() {
        setup();
        let s = new_sticky_note_element(
            ElementOpts {
                width: 10.,
                height: 10.,
                ..Default::default()
            },
            None,
        );
        // colors and fill are fixed at construction (a version bump), size only when finalized
        assert_eq!(
            (
                s.background_color.as_str(),
                s.fill_style,
                s.version,
                s.width
            ),
            (DEFAULT_STICKY_NOTE_BG, FillStyle::Solid, 2, 10.)
        );
        let n = normalize_sticky_note(&s);
        assert_eq!(
            (n.width, n.height, n.kind.clone()),
            (75., 75., Kind::StickyNote { base_height: 75. })
        );
    }

    // ---------------------------------------------------------------------------
    // mutateElement
    // ---------------------------------------------------------------------------

    #[test]
    fn mutate_bumps_only_on_change() {
        setup();
        let mut e = rect();
        let (v, n) = (e.version, e.version_nonce);
        assert!(!mutate_element(&mut e, |e| e.x = 0.));
        assert_eq!((e.version, e.version_nonce), (v, n));
        fix_timestamp(Some(5));
        assert!(mutate_element(&mut e, |e| e.x = 10.));
        assert_eq!(e.version, v + 1);
        assert_ne!(e.version_nonce, n);
        assert_eq!(e.updated, 5);
        // explicit version / nonce win
        mutate_element(&mut e, |e| {
            e.x = 11.;
            e.version = 40;
            e.version_nonce = 7;
        });
        assert_eq!((e.version, e.version_nonce), (40, 7));
        // points update the size unless it's given
        let mut l = create(ElementType::Line, |_| {});
        mutate_element(&mut l, |e| {
            *e.points_mut().unwrap() = vec![[0., 0.], [30., -40.]]
        });
        assert_eq!((l.width, l.height), (30., 40.));
        mutate_element(&mut l, |e| {
            *e.points_mut().unwrap() = vec![[0., 0.], [1., 1.]];
            e.width = 7.;
        });
        assert_eq!((l.width, l.height), (7., 40.));
        let same = new_element_with(&e, |_| {}, false);
        assert_eq!(same, e);
        let forced = new_element_with(&e, |_| {}, true);
        assert_eq!(forced.version, e.version + 1);
    }

    // ---------------------------------------------------------------------------
    // typeChecks.test.ts
    // ---------------------------------------------------------------------------

    #[test]
    fn has_bound_text_element() {
        setup();
        for ty in [
            ElementType::Rectangle,
            ElementType::Ellipse,
            ElementType::Arrow,
        ] {
            assert!(
                create(ty, |s| s.bound_elements = Some(vec![text_bound("text-id")]))
                    .has_bound_text(),
                "{ty:?}"
            );
        }
        assert!(
            !create(ElementType::FreeDraw, |s| s.bound_elements =
                Some(vec![arrow_bound("arrow-id")]))
            .has_bound_text()
        );
        assert!(
            !create(ElementType::FreeDraw, |s| s.bound_elements =
                Some(vec![text_bound("text-id")]))
            .has_bound_text()
        );
        assert!(
            !create(ElementType::Image, |s| s.bound_elements =
                Some(vec![text_bound("text-id")]))
            .has_bound_text()
        );
    }

    #[test]
    fn non_deleted_type() {
        setup();
        let deleted = new_element_with(&rect(), |e| e.is_deleted = true, false);
        assert!(deleted.is_deleted);
        let elements = [
            create(ElementType::Text, |s| s.text = Some("text".into())),
            create(ElementType::Arrow, |_| {}),
        ];
        assert_eq!(elements.iter().filter(|e| e.is_text()).count(), 1);
        assert_eq!(elements.iter().filter(|e| e.is_linear()).count(), 1);
    }

    // ---------------------------------------------------------------------------
    // sortElements.test.ts
    // ---------------------------------------------------------------------------

    fn order(els: Vec<Element>) -> Vec<String> {
        normalize_element_order(els)
            .into_iter()
            .map(|e| e.id)
            .collect()
    }
    fn ids(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }
    fn r(id: &str, groups: &[&str]) -> Element {
        create(ElementType::Rectangle, |s| {
            s.id = Some(id.into());
            s.group_ids = ids(groups);
        })
    }

    #[test]
    fn sort_bound_text_elements() {
        setup();
        let mut container = create(ElementType::Rectangle, |s| s.id = Some("container".into()));
        let bound_text = create(ElementType::Text, |s| {
            s.id = Some("boundText".into());
            s.container_id = Some("container".into());
        });
        let other = create(ElementType::Rectangle, |s| {
            s.id = Some("otherElement".into());
            s.bound_elements = Some(vec![]);
        });
        let other2 = create(ElementType::Rectangle, |s| {
            s.id = Some("otherElement2".into());
            s.bound_elements = Some(vec![]);
        });
        mutate_element(&mut container, |e| {
            e.bound_elements = Some(vec![text_bound("boundText")])
        });
        let (c, t, o, o2) = (
            || container.clone(),
            || bound_text.clone(),
            || other.clone(),
            || other2.clone(),
        );

        assert_eq!(order(vec![c(), t()]), ids(&["container", "boundText"]));
        assert_eq!(order(vec![t(), c()]), ids(&["container", "boundText"]));
        assert_eq!(
            order(vec![t(), c(), o(), o2()]),
            ids(&["container", "boundText", "otherElement", "otherElement2"])
        );
        assert_eq!(
            order(vec![c(), o(), t()]),
            ids(&["container", "boundText", "otherElement"])
        );
        assert_eq!(
            order(vec![c(), o(), o2(), t()]),
            ids(&["container", "boundText", "otherElement", "otherElement2"])
        );
        assert_eq!(
            order(vec![t(), o(), c(), o2()]),
            ids(&["otherElement", "container", "boundText", "otherElement2"])
        );
        // noop
        assert_eq!(
            order(vec![o(), c(), t(), o2()]),
            ids(&["otherElement", "container", "boundText", "otherElement2"])
        );
        // text has a containerId, but the container doesn't list it
        let text = |c: &str| {
            create(ElementType::Text, |s| {
                s.id = Some("boundText".into());
                s.container_id = Some(c.into());
            })
        };
        assert_eq!(
            order(vec![
                text("container"),
                create(ElementType::Rectangle, |s| s.id = Some("container".into()))
            ]),
            ids(&["boundText", "container"])
        );
        assert_eq!(order(vec![text("container")]), ids(&["boundText"]));
        assert_eq!(
            order(vec![create(ElementType::Rectangle, |s| {
                s.id = Some("container".into());
                s.bound_elements = Some(vec![]);
            })]),
            ids(&["container"])
        );
        assert_eq!(
            order(vec![create(ElementType::Rectangle, |s| {
                s.id = Some("container".into());
                s.bound_elements = Some(vec![text_bound("x")]);
            })]),
            ids(&["container"])
        );
        assert_eq!(
            order(vec![
                create(ElementType::Arrow, |s| s.id = Some("arrow".into())),
                create(ElementType::Rectangle, |s| {
                    s.id = Some("container".into());
                    s.bound_elements = Some(vec![arrow_bound("arrow")]);
                }),
            ]),
            ids(&["arrow", "container"])
        );
    }

    #[test]
    fn normalize_group_order() {
        setup();
        assert_eq!(
            order(vec![
                r("A_rect1", &["A"]),
                r("rect2", &[]),
                r("rect3", &[]),
                r("A_rect4", &["A"]),
                r("A_rect5", &["A"]),
                r("rect6", &[]),
                r("A_rect7", &["A"])
            ]),
            ids(&[
                "A_rect1", "A_rect4", "A_rect5", "A_rect7", "rect2", "rect3", "rect6"
            ])
        );
        assert_eq!(
            order(vec![
                r("A_rect1", &["A"]),
                r("rect2", &[]),
                r("B_rect3", &["B"]),
                r("A_rect4", &["A"]),
                r("B_rect5", &["B"]),
                r("rect6", &[]),
                r("A_rect7", &["A"])
            ]),
            ids(&[
                "A_rect1", "A_rect4", "A_rect7", "rect2", "B_rect3", "B_rect5", "rect6"
            ])
        );
        // nested groups
        assert_eq!(
            order(vec![r("A_rect1", &["A"]), r("BA_rect2", &["B", "A"])]),
            ids(&["A_rect1", "BA_rect2"])
        );
        assert_eq!(
            order(vec![r("BA_rect1", &["B", "A"]), r("A_rect2", &["A"])]),
            ids(&["BA_rect1", "A_rect2"])
        );
        assert_eq!(
            order(vec![
                r("BA_rect1", &["B", "A"]),
                r("A_rect2", &["A"]),
                r("CBA_rect3", &["C", "B", "A"]),
                r("rect4", &[]),
                r("A_rect5", &["A"]),
                r("BA_rect5", &["B", "A"]),
                r("BA_rect6", &["B", "A"]),
                r("CBA_rect7", &["C", "B", "A"]),
                r("X_rect8", &["X"]),
                r("rect9", &[]),
                r("YX_rect10", &["Y", "X"]),
                r("X_rect11", &["X"]),
            ]),
            ids(&[
                "BA_rect1",
                "CBA_rect3",
                "CBA_rect7",
                "BA_rect5",
                "BA_rect6",
                "A_rect2",
                "A_rect5",
                "rect4",
                "X_rect8",
                "YX_rect10",
                "X_rect11",
                "rect9"
            ])
        );
        assert_eq!(
            order(vec![
                r("A_rect1", &["A"]),
                r("CBA_rect2", &["C", "B", "A"]),
                r("A_rect3", &["A"])
            ]),
            ids(&["A_rect1", "CBA_rect2", "A_rect3"])
        );
        assert_eq!(
            order(vec![
                r("abcT_rect1", &["ab", "c", "T"]),
                r("abcT_rect2", &["a", "bc", "T"]),
                r("abcT_rect3", &["ab", "c", "T"])
            ]),
            ids(&["abcT_rect1", "abcT_rect3", "abcT_rect2"])
        );
    }

    // ---------------------------------------------------------------------------
    // fractionalIndex.test.ts and fractional-indexing vectors
    // ---------------------------------------------------------------------------

    #[test]
    fn order_key_format_validation() {
        for k in ["a!", "a_", "a1!", "a1_", "zd0032"] {
            assert!(validate_order_key(k).is_err(), "{k}");
        }
        for k in ["Zz", "a0", "a1", "a1V", &"z".repeat(28)] {
            assert!(validate_order_key(k).is_ok(), "{k}");
        }
    }

    #[test]
    fn generate_key_between_vectors() {
        // rocicorp/fractional-indexing's tests, checked against the vendored source
        let cases: &[(Option<&str>, Option<&str>, Option<&str>)] = &[
            (None, None, Some("a0")),
            (None, Some("a0"), Some("Zz")),
            (None, Some("Zz"), Some("Zy")),
            (Some("a0"), None, Some("a1")),
            (Some("a1"), None, Some("a2")),
            (Some("a0"), Some("a1"), Some("a0V")),
            (Some("a1"), Some("a2"), Some("a1V")),
            (Some("a0V"), Some("a1"), Some("a0l")),
            (Some("Zz"), Some("a0"), Some("ZzV")),
            (Some("Zz"), Some("a1"), Some("a0")),
            (None, Some("Y00"), Some("Xzzz")),
            (Some("bzz"), None, Some("c000")),
            (Some("a0"), Some("a0V"), Some("a0G")),
            (Some("a0"), Some("a0G"), Some("a08")),
            (Some("b125"), Some("b129"), Some("b127")),
            (Some("a0"), Some("a1V"), Some("a1")),
            (Some("Zz"), Some("a01"), Some("a0")),
            (None, Some("a0V"), Some("a0")),
            (None, Some("b999"), Some("b99")),
            (None, Some("A00000000000000000000000000"), None),
            (
                None,
                Some("A000000000000000000000000001"),
                Some("A000000000000000000000000000V"),
            ),
            (
                Some("zzzzzzzzzzzzzzzzzzzzzzzzzzy"),
                None,
                Some("zzzzzzzzzzzzzzzzzzzzzzzzzzz"),
            ),
            (
                Some("zzzzzzzzzzzzzzzzzzzzzzzzzzz"),
                None,
                Some("zzzzzzzzzzzzzzzzzzzzzzzzzzzV"),
            ),
            (Some("a00"), None, None),
            (Some("a00"), Some("a1"), None),
            (Some("0"), Some("1"), None),
            (Some("a1"), Some("a0"), None),
        ];
        for &(a, b, want) in cases {
            assert_eq!(
                generate_key_between(a, b).ok().as_deref(),
                want,
                "{a:?} {b:?}"
            );
        }
        assert_eq!(
            generate_n_keys_between(None, None, 5).unwrap(),
            ["a0", "a1", "a2", "a3", "a4"]
        );
        assert_eq!(
            generate_n_keys_between(Some("a4"), Some("a5"), 10).unwrap(),
            [
                "a44", "a48", "a4G", "a4K", "a4O", "a4V", "a4Z", "a4d", "a4l", "a4t"
            ]
        );
        assert_eq!(
            generate_n_keys_between(Some("a0"), Some("a1"), 5).unwrap(),
            ["a08", "a0G", "a0V", "a0d", "a0l"]
        );
        assert_eq!(
            generate_n_keys_between(None, Some("a0"), 3).unwrap(),
            ["Zx", "Zy", "Zz"]
        );
        // fractionalIndex.test.ts: without jitter, 20000 keys up from 'a0' end at 'c4BZ', down at 'XvoR'
        let (mut up, mut down) = (None::<String>, None::<String>);
        for _ in 0..20_000 {
            up = Some(generate_key_between(up.as_deref(), None).unwrap());
            down = Some(generate_key_between(None, down.as_deref()).unwrap());
        }
        assert_eq!(
            (up.as_deref(), down.as_deref()),
            (Some("c4BZ"), Some("XvoR"))
        );
    }

    fn mk(xs: &[(&str, Option<&str>)]) -> Vec<Element> {
        xs.iter()
            .map(|(id, index)| {
                create(ElementType::Rectangle, |s| {
                    s.id = Some(id.to_string());
                    s.index = index.map(str::to_owned);
                })
            })
            .collect()
    }

    /// `test()` in fractionalIndex.test.ts.
    fn check_sync(
        elements: Vec<Element>,
        moved: Option<&[&str]>,
        unchanged: &[&str],
        valid_input: bool,
    ) {
        if !valid_input {
            assert!(
                validate_fractional_indices(&elements, true).is_err(),
                "input should be invalid"
            );
        }
        let mut synced = elements.clone();
        match moved {
            Some(m) => sync_moved_indices(
                &mut synced,
                &m.iter().map(|s| s.to_string()).collect::<FxHashSet<_>>(),
            ),
            None => sync_invalid_indices(&mut synced),
        }
        assert_eq!(synced.len(), elements.len());
        assert!(
            validate_fractional_indices(&synced, true).is_ok(),
            "{:?}",
            synced.iter().map(|e| e.index.clone()).collect::<Vec<_>>()
        );
        for (s, e) in synced.iter().zip(&elements) {
            assert_eq!(s.id, e.id);
            if unchanged.contains(&s.id.as_str()) {
                assert_eq!(
                    (&s.index, s.version),
                    (&e.index, e.version),
                    "{} should be unchanged",
                    s.id
                );
            } else {
                assert_ne!(s.index, e.index, "{} should change", s.id);
                // mutated just once, even with the fallback
                assert_eq!(s.version, e.version + 1, "{}", s.id);
            }
        }
    }

    fn moved(xs: &[(&str, Option<&str>)], m: &[&str], unchanged: &[&str], valid: bool) {
        check_sync(mk(xs), Some(m), unchanged, valid)
    }
    fn invalid(xs: &[(&str, Option<&str>)], unchanged: &[&str], valid: bool) {
        check_sync(mk(xs), None, unchanged, valid)
    }

    #[test]
    fn sync_invalid_indices_with_array_order() {
        setup();
        let n = None;
        let s = Some;
        // should NOT sync empty array / well defined indices
        moved(&[], &[], &[], true);
        invalid(&[], &[], true);
        moved(&[("A", s("a1"))], &[], &["A"], true);
        invalid(&[("A", s("a1"))], &["A"], true);
        moved(
            &[("A", s("a1")), ("B", s("a2")), ("C", s("a3"))],
            &[],
            &["A", "B", "C"],
            true,
        );
        invalid(
            &[("A", s("a1")), ("B", s("a2")), ("C", s("a3"))],
            &["A", "B", "C"],
            true,
        );
        // fractional index not defined
        moved(&[("A", n)], &["A"], &[], false);
        invalid(&[("A", n)], &[], false);
        // malformed
        invalid(&[("A", s("zd0032"))], &[], false);
        invalid(
            &[("A", s("a1")), ("B", s("zd0032")), ("C", s("a3"))],
            &["A", "C"],
            false,
        );
        invalid(&[("A", s("a!"))], &[], false);
        invalid(
            &[("A", s("a1")), ("B", s("a!")), ("C", s("a2"))],
            &["A", "C"],
            false,
        );
        // duplicated
        invalid(&[("A", s("a1")), ("B", s("a1"))], &["A"], false);
        // out of order
        moved(&[("A", s("a2")), ("B", s("a1"))], &["B"], &["A"], false);
        moved(&[("A", s("a2")), ("B", s("a1"))], &["A"], &["B"], false);
        invalid(&[("A", s("a2")), ("B", s("a1"))], &["A"], false);
        moved(
            &[("A", s("a3")), ("B", s("a2")), ("C", s("a1"))],
            &["B", "C"],
            &["A"],
            false,
        );
        invalid(
            &[("A", s("a3")), ("B", s("a2")), ("C", s("a1"))],
            &["A"],
            false,
        );
        // incorrect index between correct ones
        moved(
            &[("A", s("a1")), ("B", s("a0")), ("C", s("a2"))],
            &["B"],
            &["A", "C"],
            false,
        );
        invalid(
            &[("A", s("a1")), ("B", s("a0")), ("C", s("a2"))],
            &["A", "C"],
            false,
        );
        // incorrect index on top, duplicated below
        moved(
            &[("A", s("a1")), ("B", s("a2")), ("C", s("a1"))],
            &["C"],
            &["A", "B"],
            false,
        );
        invalid(
            &[("A", s("a1")), ("B", s("a2")), ("C", s("a1"))],
            &["A", "B"],
            false,
        );
        // mix of duplicate / invalid
        let mix = [
            ("A", s("a0")),
            ("B", s("a2")),
            ("C", s("a1")),
            ("D", s("a1")),
            ("E", s("a2")),
        ];
        moved(&mix, &["C", "D", "E"], &["A", "B"], false);
        invalid(&mix, &["A", "B"], false);
        // mix of undefined / invalid
        let mix = [
            ("A", n),
            ("B", n),
            ("C", s("a0")),
            ("D", s("a2")),
            ("E", n),
            ("F", s("a3")),
            ("G", n),
            ("H", s("a1")),
            ("I", s("a2")),
            ("J", n),
        ];
        moved(
            &mix,
            &["A", "B", "E", "G", "H", "I", "J"],
            &["C", "D", "F"],
            false,
        );
        invalid(&mix, &["C", "D", "F"], false);
        // all moved elements regardless of their validity
        moved(&[("A", s("a2")), ("B", s("a4"))], &["A"], &["B"], true);
        moved(&[("A", s("a2")), ("B", s("a4"))], &["B"], &["A"], true);
        moved(
            &[
                ("C", s("a2")),
                ("D", s("a3")),
                ("A", s("a0")),
                ("B", s("a1")),
            ],
            &["C", "D"],
            &["A", "B"],
            false,
        );
        moved(
            &[
                ("A", s("a1")),
                ("B", s("a2")),
                ("D", s("a4")),
                ("C", s("a3")),
                ("F", s("a6")),
                ("E", s("a5")),
                ("H", s("a8")),
                ("G", s("a7")),
                ("I", s("a9")),
            ],
            &["D", "F", "H"],
            &["A", "B", "C", "E", "G", "I"],
            false,
        );
        moved(
            &[("A", s("a1")), ("B", s("a0")), ("C", s("a2"))],
            &["B", "C"],
            &["A"],
            false,
        );
        moved(
            &[("A", s("a1")), ("B", s("a0")), ("C", s("a2"))],
            &["A", "B"],
            &["C"],
            false,
        );
        moved(
            &[
                ("A", s("a0")),
                ("B", s("a2")),
                ("C", s("a1")),
                ("D", s("a1")),
                ("E", s("a2")),
            ],
            &["B", "D", "E"],
            &["A", "C"],
            false,
        );
        let mix = [
            ("A", n),
            ("B", n),
            ("C", s("a0")),
            ("D", s("a2")),
            ("E", n),
            ("F", s("a3")),
            ("G", n),
            ("H", s("a1")),
            ("I", s("a2")),
            ("J", n),
        ];
        moved(
            &mix,
            &["A", "B", "D", "E", "F", "G", "J"],
            &["C", "H", "I"],
            false,
        );
        // fractions for explicitly moved elements
        moved(
            &[("A", s("a1")), ("B", s("a1")), ("C", s("a2"))],
            &["B"],
            &["A", "C"],
            false,
        );
        invalid(
            &[("A", s("a1")), ("B", s("a1")), ("C", s("a2"))],
            &["A", "C"],
            false,
        );
        let dup = [
            ("A", s("a01")),
            ("B", s("a01")),
            ("C", s("a01")),
            ("D", s("a01")),
            ("E", s("a02")),
            ("F", s("a02")),
            ("G", s("a02")),
        ];
        moved(&dup, &["B", "C", "D", "E", "F"], &["A", "G"], false);
        moved(&dup, &["A", "C", "D", "E", "G"], &["B", "F"], false);
        moved(&dup, &["B", "C", "D", "F", "G"], &["A", "E"], false);
        // the fallback takes the first item (E) as a valid one
        invalid(&dup, &["A", "E"], false);
        // automatic fallback to fixing all invalid indices
        moved(
            &[("A", s("a1")), ("B", s("a1")), ("C", s("a1"))],
            &[],
            &["A"],
            false,
        );
        moved(
            &[("A", s("a1")), ("B", n), ("C", s("a0"))],
            &[],
            &["A"],
            false,
        );
        moved(
            &[("A", s("a1")), ("B", s("a2")), ("C", s("a1"))],
            &["A"],
            &["A", "B"],
            false,
        );
        moved(
            &[("A", s("a2")), ("B", n), ("C", s("a1"))],
            &["B"],
            &["A"],
            false,
        );
        moved(
            &[
                ("A", s("a01")),
                ("B", n),
                ("C", n),
                ("D", s("a01")),
                ("E", s("a01")),
                ("F", s("a01")),
                ("G", n),
                ("I", s("a03")),
                ("H", n),
            ],
            &["B", "C", "D", "F", "G", "H"],
            &["A", "I"],
            false,
        );
    }

    #[test]
    fn sync_20k_invalid_indices() {
        setup();
        const N: usize = 20_000;
        let all: Vec<String> = (0..N).map(|i| format!("A_{i}")).collect();
        let elements: Vec<Element> = all
            .iter()
            .map(|id| create(ElementType::Rectangle, |s| s.id = Some(id.clone())))
            .collect();
        let all_ref: Vec<&str> = all.iter().map(String::as_str).collect();
        check_sync(elements.clone(), Some(&all_ref), &[], false);
        check_sync(elements, None, &[], false);
        // growing: only the last has an index
        let mut last = None::<String>;
        let mut elements: Vec<Element> = all
            .iter()
            .enumerate()
            .map(|(i, id)| {
                last = Some(generate_key_between(last.as_deref(), None).unwrap());
                create(ElementType::Rectangle, |s| {
                    s.id = Some(id.clone());
                    s.index = (i == N - 1).then(|| last.clone().unwrap());
                })
            })
            .collect();
        check_sync(
            elements.clone(),
            Some(&all_ref[..N - 1]),
            &[&all[N - 1]],
            false,
        );
        check_sync(std::mem::take(&mut elements), None, &[&all[N - 1]], false);
        // declining: all indexed, in the wrong order
        let mut last = None::<String>;
        let elements: Vec<Element> = all
            .iter()
            .map(|id| {
                last = Some(generate_key_between(None, last.as_deref()).unwrap());
                create(ElementType::Rectangle, |s| {
                    s.id = Some(id.clone());
                    s.index = last.clone();
                })
            })
            .collect();
        check_sync(elements.clone(), Some(&all_ref[1..]), &["A_0"], false);
        check_sync(elements, None, &["A_0"], false);
    }

    #[test]
    fn order_by_fractional_index_breaks_ties_by_id() {
        setup();
        let mut els = mk(&[("b", Some("a1")), ("a", Some("a1")), ("c", Some("a0"))]);
        order_by_fractional_index(&mut els);
        assert_eq!(
            els.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["c", "a", "b"]
        );
    }

    // ---------------------------------------------------------------------------
    // Scene
    // ---------------------------------------------------------------------------

    #[test]
    fn scene_keeps_order_indices_and_views() {
        setup();
        let mut scene = Scene::new(vec![
            r("a", &[]),
            create(ElementType::Frame, |s| s.id = Some("f".into())),
            r("b", &["g"]),
        ]);
        assert_eq!(
            scene
                .elements_including_deleted()
                .iter()
                .map(|e| e.index.clone().unwrap())
                .collect::<Vec<_>>(),
            ["a0", "a1", "a2"]
        );
        let nonce = scene.scene_nonce();
        scene.insert_elements_at_index(vec![r("c", &[])], Some(1));
        assert_eq!(
            scene.get_element("c").unwrap().index.as_deref(),
            Some("a0V")
        );
        assert_eq!(scene.get_element_index("c"), Some(1));
        assert_ne!(scene.scene_nonce(), nonce);
        assert_eq!(scene.get_elements_from_id("g").len(), 1);
        assert_eq!(scene.non_deleted_frame_likes().count(), 1);
        let nonce = scene.scene_nonce();
        assert!(!scene.mutate_element("a", true, |e| e.x = 0.));
        assert_eq!(scene.scene_nonce(), nonce);
        assert!(scene.mutate_element("a", true, |e| e.is_deleted = true));
        assert_ne!(scene.scene_nonce(), nonce);
        assert!(scene.get_non_deleted_element("a").is_none());
        assert_eq!(scene.non_deleted_len(), 3);
    }

    // ---------------------------------------------------------------------------
    // restore.test.ts: restoreElements
    // ---------------------------------------------------------------------------

    #[test]
    fn basic_restore_elements() {
        setup();
        let els = vec![val(&create(ElementType::Text, |_| {})), val(&rect())];
        assert_eq!(restore(els, plain()).len(), 2);
    }

    #[test]
    fn restores_created_without_substituting_times() {
        for created in [Some(Some(123)), Some(Some(0)), Some(None), None] {
            setup();
            let e = create(ElementType::Rectangle, |s| s.index = Some("a0".into()));
            let v = with(&e, |o| {
                match created {
                    Some(c) => {
                        o.insert("created".into(), json!(c));
                    }
                    None => {
                        o.remove("created");
                    }
                }
                o.insert("updated".into(), json!(456));
            });
            let restored = restore(vec![v], plain());
            let want = created.flatten();
            assert_eq!(
                (&restored[0].id, restored[0].created, restored[0].updated),
                (&e.id, want, 456)
            );
            let exported: Value = serde_json::from_str(&serialize_as_json(
                &restored,
                &ExportedAppState::default(),
                &Default::default(),
                "test",
            ))
            .unwrap();
            assert_eq!(exported["elements"][0]["created"], json!(want));
            assert_eq!(
                restore_elements(exported.get("elements"), None, &plain()),
                restored
            );
        }
    }

    #[test]
    fn preserves_created_when_repairing_duplicate_ids() {
        setup();
        let e = create(ElementType::Rectangle, |s| s.created = Some(Some(123)));
        let restored = restore(
            vec![
                val(&e),
                with(&e, |o| {
                    o.insert("created".into(), Value::Null);
                }),
            ],
            plain(),
        );
        assert_eq!(
            restored.iter().map(|e| e.created).collect::<Vec<_>>(),
            [Some(123), None]
        );
        assert_ne!(restored[0].id, restored[1].id);
    }

    #[test]
    fn transparent_sticky_note_stroke_restores_as_black() {
        setup();
        let s = with(&create(ElementType::StickyNote, |_| {}), |o| {
            o.insert("strokeColor".into(), json!("transparent"));
        });
        assert_eq!(restore(vec![s], plain())[0].stroke_color, "#1e1e1e");
    }

    #[test]
    fn null_and_unsupported_input() {
        setup();
        assert!(restore_elements(None, None, &plain()).is_empty());
        assert!(restore_elements(Some(&Value::Null), None, &plain()).is_empty());
        assert!(restore(vec![json!({"type": "selection"})], plain()).is_empty());
        assert!(
            restore(
                vec![with(&create(ElementType::Text, |_| {}), |o| {
                    o.insert("type".into(), json!("not supported"));
                })],
                plain()
            )
            .is_empty()
        );
        assert!(restore(vec![json!(null), json!(3)], plain()).is_empty());
    }

    #[test]
    fn invisibly_small_elements_are_deleted() {
        setup();
        // upstream mocks isInvisiblySmallElement; a 0×0 rectangle is invisible
        let r0 = create(ElementType::Rectangle, |s| {
            s.width = 0.;
            s.height = Some(0.);
        });
        let out = restore(vec![val(&r0)], invisible());
        assert!(out[0].is_deleted);
        // "should remove imperceptibly small elements"
        let a = create(ElementType::Arrow, |s| {
            s.points = Some(vec![[0., 0.], [0.02, 0.05]])
        });
        let out = restore(vec![val(&a)], invisible());
        assert!(out[0].is_deleted);
        // "should keep 'imperceptibly' small freedraw/line elements"
        let f = create(ElementType::FreeDraw, |s| {
            s.points = Some(vec![[0., 0.], [0.0001, 0.0001]])
        });
        let l = create(ElementType::Line, |s| {
            s.points = Some(vec![[0., 0.], [0.0001, 0.0001]])
        });
        let out = restore(vec![val(&f), val(&l)], plain());
        assert_eq!(
            (out[0].id.as_str(), out[1].id.as_str()),
            (f.id.as_str(), l.id.as_str())
        );
    }

    #[test]
    fn restore_text_element_with_every_attribute() {
        setup();
        let t = create(ElementType::Text, |s| {
            s.font_size = Some(14.);
            s.font_family = Some(font_family::VIRGIL);
            s.text = Some("text".into());
            s.text_align = Some(TextAlign::Center);
            s.vertical_align = Some(VerticalAlign::Middle);
            s.id = Some("id-text01".into());
        });
        let r = &restore(vec![val(&t)], plain())[0];
        let d = r.text().unwrap();
        assert_eq!(
            (r.id.as_str(), r.x, r.y, r.width, r.height, r.angle),
            ("id-text01", -20., -8.75, 100., 100., 0.)
        );
        assert_eq!(
            (
                d.font_size,
                d.font_family,
                d.line_height,
                d.text.as_str(),
                d.original_text.as_str()
            ),
            (14., 1, 1.25, "text", "text")
        );
        assert_eq!(
            (
                d.text_align,
                d.vertical_align,
                d.container_id.as_deref(),
                d.base_font_size,
                d.label_position,
                d.auto_resize
            ),
            (
                TextAlign::Center,
                VerticalAlign::Middle,
                None,
                None,
                Some(None),
                true
            )
        );
        assert_eq!(
            (
                r.index.as_deref(),
                r.version,
                r.created,
                r.updated,
                r.is_deleted
            ),
            (Some("a0"), 2, Some(1), 1, false)
        );
        assert_eq!(
            (
                r.bound_elements.clone(),
                r.roundness,
                r.stroke_width,
                r.stroke_color.as_str()
            ),
            (Some(vec![]), None, 2., "#1e1e1e")
        );
        assert!(r.extra.is_empty() && r.custom_data.is_none() && r.link.is_none());
    }

    #[test]
    fn empty_text_kept_without_delete_invisible() {
        setup();
        let t = create(ElementType::Text, |_| {});
        let r = &restore(
            vec![with(&t, |o| {
                o.insert("text".into(), json!(""));
            })],
            plain(),
        )[0];
        assert_eq!((r.id.as_str(), r.is_deleted), (t.id.as_str(), false));
    }

    #[test]
    fn text_with_unknown_font_family_null_text_and_undefined_alignment() {
        setup();
        let t = create(ElementType::Text, |s| s.id = Some("id-text01".into()));
        let v = with(&t, |o| {
            o.insert("text".into(), Value::Null);
            o.insert("font".into(), json!("10 unknown"));
            o.remove("textAlign");
            o.remove("verticalAlign");
        });
        let r = &restore(vec![v], invisible())[0];
        let d = r.text().unwrap();
        assert!(r.is_deleted);
        assert_eq!(
            (
                d.font_size,
                d.font_family,
                d.text.as_str(),
                d.original_text.as_str(),
                d.text_align,
                d.vertical_align,
                d.line_height
            ),
            (10., 5, "", "", TextAlign::Left, VerticalAlign::Top, 1.25)
        );
        assert_eq!(
            (r.version, r.x, r.y, r.width, r.height, r.index.as_deref()),
            (3, 0., 0., 100., 100., Some("a0"))
        );
        assert_eq!(r.extra.get("font"), Some(&json!("10 unknown")));
    }

    #[test]
    fn line_height_from_legacy_font_prop() {
        setup();
        let t = create(ElementType::Text, |s| {
            s.id = Some("id-text-legacy-font".into())
        });
        let v = with(&t, |o| {
            for k in ["fontSize", "fontFamily", "lineHeight"] {
                o.remove(k);
            }
            o.insert("font".into(), json!("20px Virgil"));
            o.insert("text".into(), json!("hi"));
            o.insert("height".into(), json!(50));
        });
        let d = restore(vec![v], plain())[0].text().unwrap().clone();
        assert_eq!(
            (d.font_size, d.font_family, d.line_height),
            (20., font_family::VIRGIL, 2.5)
        );
        // can't be detected: the family's line height
        let v = with(&t, |o| {
            o.remove("lineHeight");
            o.insert("text".into(), json!("hi"));
            o.insert("height".into(), json!("unknown"));
        });
        assert_eq!(
            restore(vec![v], plain())[0].text().unwrap().line_height,
            get_line_height(DEFAULT_FONT_FAMILY)
        );
    }

    #[test]
    fn font_sizes_are_sanitized() {
        setup();
        let t = create(ElementType::Text, |s| s.text = Some("text".into()));
        // JSON has no NaN; null is what JSON.stringify makes of it
        let r = restore(
            vec![with(&t, |o| {
                o.insert("fontSize".into(), Value::Null);
                o.insert("baseFontSize".into(), json!("abc"));
            })],
            plain(),
        );
        assert_eq!(
            (
                r[0].text().unwrap().font_size,
                r[0].text().unwrap().base_font_size
            ),
            (DEFAULT_FONT_SIZE, None)
        );
        let r = restore(
            vec![with(&t, |o| {
                o.insert("baseFontSize".into(), json!(1e20));
            })],
            plain(),
        );
        assert_eq!(
            r[0].text().unwrap().base_font_size,
            Some(STICKY_NOTE_MAX_FONT_SIZE)
        );
        // a ceiling on text that isn't a sticky note label is cleared
        let t = create(ElementType::Text, |s| {
            s.text = Some("text".into());
            s.font_size = Some(20.);
        });
        let r = restore(
            vec![with(&t, |o| {
                o.insert("baseFontSize".into(), json!(28));
            })],
            repair(),
        );
        assert_eq!(r[0].text().unwrap().base_font_size, None);
    }

    #[test]
    fn sticky_note_labels() {
        setup();
        let note = create(ElementType::StickyNote, |s| {
            s.id = Some("sticky".into());
            s.bound_elements = Some(vec![text_bound("label")]);
        });
        let label = create(ElementType::Text, |s| {
            s.id = Some("label".into());
            s.text = Some("text".into());
            s.font_size = Some(20.);
            s.container_id = Some("sticky".into());
        });
        let v = with(&label, |o| {
            o.insert("strokeColor".into(), json!("transparent"));
            o.remove("baseFontSize");
        });
        let r = restore(vec![val(&note), v], repair());
        let l = r.iter().find(|e| e.id == "label").unwrap();
        assert_eq!(
            (l.text().unwrap().base_font_size, l.stroke_color.as_str()),
            (Some(20.), "#1e1e1e")
        );
        // drifted colors: the label's wins
        let label = create(ElementType::Text, |s| {
            s.id = Some("label".into());
            s.text = Some("text".into());
            s.font_size = Some(20.);
            s.container_id = Some("sticky".into());
            s.stroke_color = Some("#e03131".into());
        });
        let r = restore(vec![val(&note), val(&label)], repair());
        assert_eq!(
            r.iter().find(|e| e.id == "sticky").unwrap().stroke_color,
            "#e03131"
        );
        assert_eq!(
            r.iter().find(|e| e.id == "label").unwrap().stroke_color,
            "#e03131"
        );
    }

    #[test]
    fn restore_freedraw() {
        setup();
        let f = create(ElementType::FreeDraw, |s| {
            s.id = Some("id-freedraw01".into());
            s.points = Some(vec![[0., 0.], [10., 10.]]);
        });
        let r = &restore(vec![val(&f)], plain())[0];
        let d = r.freedraw().unwrap();
        assert_eq!(
            (d.points.clone(), d.pressures.clone(), d.simulate_pressure),
            (vec![[0., 0.], [10., 10.]], vec![], true)
        );
        assert_eq!(
            d.stroke_options,
            StrokeOptions {
                variability: StrokeVariability::Variable,
                streamline: 0.5
            }
        );
        assert_eq!(
            (
                r.stroke_width,
                r.width,
                r.height,
                r.version,
                r.index.as_deref()
            ),
            (1., 100., 100., 2, Some("a0"))
        );
        // only valid points, pressures kept aligned (JSON turns Infinity / NaN into null)
        let f = create(ElementType::FreeDraw, |s| {
            s.id = Some("id-freedraw-invalid-points".into());
            s.points = Some(vec![[0., 0.], [10., 10.]]);
        });
        let v = with(&f, |o| {
            o.insert("simulatePressure".into(), json!(false));
            o.insert(
                "points".into(),
                json!([[0, 0], [null, 10], null, [20, 20], [null, 30], [40, null]]),
            );
            o.insert("pressures".into(), json!([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]));
        });
        let r = &restore(vec![v], plain())[0];
        assert_eq!(
            (
                r.freedraw().unwrap().points.clone(),
                r.freedraw().unwrap().pressures.clone()
            ),
            (vec![[0., 0.], [20., 20.]], vec![0.1, 0.4])
        );
    }

    #[test]
    fn restore_freedraw_stroke_variability() {
        setup();
        let f = create(ElementType::FreeDraw, |s| {
            s.id = Some("id-freedraw-mode".into());
            s.points = Some(vec![[0., 0.], [10., 10.]]);
        });
        let opts = [
            json!(null),
            json!({"variability": "scribble"}),
            json!({"variability": 42}),
            json!({"variability": "constant", "streamline": 0.8}),
            json!({"variability": "variable", "streamline": 0.8}),
        ];
        let els: Vec<Value> = opts
            .iter()
            .enumerate()
            .map(|(i, so)| {
                with(&f, |o| {
                    o.insert("id".into(), json!(i.to_string()));
                    o.insert("strokeOptions".into(), so.clone());
                })
            })
            .collect();
        let got: Vec<(StrokeVariability, f64)> = restore(els, plain())
            .iter()
            .map(|e| {
                let s = e.freedraw().unwrap().stroke_options;
                (s.variability, s.streamline)
            })
            .collect();
        use StrokeVariability::*;
        assert_eq!(
            got,
            [
                (Variable, 0.5),
                (Variable, 0.5),
                (Variable, 0.5),
                (Constant, 0.8),
                (Variable, 0.8)
            ]
        );
    }

    #[test]
    fn restore_line_and_draw() {
        setup();
        let line = create(ElementType::Line, |s| s.id = Some("id-line01".into()));
        let draw = with(
            &create(ElementType::Line, |s| s.id = Some("id-draw01".into())),
            |o| {
                o.insert("type".into(), json!("draw"));
            },
        );
        let r = restore(vec![val(&line), draw], plain());
        for (e, id, index) in [(&r[0], "id-line01", "a0"), (&r[1], "id-draw01", "a1")] {
            assert_eq!(
                (
                    e.id.as_str(),
                    e.ty(),
                    e.index.as_deref(),
                    e.version,
                    e.width,
                    e.height,
                    e.roundness
                ),
                (id, ElementType::Line, Some(index), 2, 100., 100., None)
            );
            assert_eq!(
                e.kind,
                Kind::Line {
                    linear: LinearData {
                        points: vec![[0., 0.], [100., 100.]],
                        start_binding: None,
                        end_binding: None,
                        start_arrowhead: None,
                        end_arrowhead: None
                    },
                    polygon: false
                }
            );
        }
    }

    #[test]
    fn restore_arrow() {
        setup();
        let a = create(ElementType::Arrow, |s| s.id = Some("id-arrow01".into()));
        let r = &restore(vec![val(&a)], plain())[0];
        assert_eq!(
            r.kind,
            Kind::Arrow {
                linear: LinearData {
                    points: vec![[0., 0.], [100., 100.]],
                    start_binding: None,
                    end_binding: None,
                    start_arrowhead: None,
                    end_arrowhead: None
                },
                elbow: None
            }
        );
        assert_eq!(
            (r.version, r.index.as_deref(), r.width, r.height, r.x, r.y),
            (2, Some("a0"), 100., 100., 0., 0.)
        );
        // legacy crowfoot arrowheads
        let v = with(&a, |o| {
            o.insert("startArrowhead".into(), json!("crowfoot_one"));
            o.insert("endArrowhead".into(), json!("crowfoot_one_or_many"));
        });
        let l = restore(vec![v], plain())[0].linear().unwrap().clone();
        assert_eq!(
            (l.start_arrowhead, l.end_arrowhead),
            (
                Some(Arrowhead::CardinalityOne),
                Some(Arrowhead::CardinalityOneOrMany)
            )
        );
        // endArrowhead null stays null, undefined becomes "arrow"
        assert_eq!(
            restore(vec![val(&a)], plain())[0]
                .linear()
                .unwrap()
                .end_arrowhead,
            None
        );
        let v = with(&a, |o| {
            o.remove("endArrowhead");
        });
        assert_eq!(
            restore(vec![v], plain())[0].linear().unwrap().end_arrowhead,
            Some(Arrowhead::Arrow)
        );
    }

    #[test]
    fn strips_leaked_move_mid_points_with_element() {
        setup();
        let a = with(&create(ElementType::Arrow, |_| {}), |o| {
            o.insert("moveMidPointsWithElement".into(), json!(false));
        });
        let l = with(&create(ElementType::Line, |_| {}), |o| {
            o.insert("moveMidPointsWithElement".into(), json!(true));
        });
        let r = restore(vec![a, l], plain());
        assert_eq!(r.len(), 2);
        for e in &r {
            assert!(
                !val(e)
                    .as_object()
                    .unwrap()
                    .contains_key("moveMidPointsWithElement")
            );
        }
    }

    #[test]
    fn restore_loop_linears() {
        setup();
        let pts = vec![[0., 0.], [100., 100.], [100., 200.], [0., 0.]];
        let l = create(ElementType::Line, |s| s.points = Some(pts.clone()));
        let a = create(ElementType::Arrow, |s| {
            s.points = Some(pts.clone());
            s.x = 500.;
            s.y = Some(500.);
        });
        let r = restore(vec![val(&l), val(&a)], plain());
        assert_eq!(
            (r[0].ty(), r[0].points().unwrap()),
            (ElementType::Line, pts.as_slice())
        );
        assert_eq!(
            (r[1].ty(), r[1].points().unwrap()),
            (ElementType::Arrow, pts.as_slice())
        );
    }

    #[test]
    fn restore_linear_points() {
        setup();
        // not an array
        let l = create(ElementType::Line, |s| {
            s.width = 100.;
            s.height = Some(200.);
        });
        let r = &restore(
            vec![with(&l, |o| {
                o.insert("points".into(), json!("not an array"));
            })],
            plain(),
        )[0];
        assert_eq!(r.points().unwrap(), [[0., 0.], [100., 200.]]);
        // only valid points
        let l = create(ElementType::Line, |s| {
            s.x = 10.;
            s.y = Some(20.);
            s.width = 100.;
            s.height = Some(200.);
        });
        let a = create(ElementType::Arrow, |s| {
            s.width = 100.;
            s.height = Some(200.);
        });
        let r = restore(
            vec![
                with(&l, |o| {
                    o.insert(
                        "points".into(),
                        json!([[2, 3], null, [null, 4], [5, 7], [null, 8], [9, null]]),
                    );
                }),
                with(&a, |o| {
                    o.insert("points".into(), json!([[null, 0], [null, 4]]));
                }),
            ],
            plain(),
        );
        assert_eq!(
            (
                r[0].points().unwrap(),
                r[0].x,
                r[0].y,
                r[0].width,
                r[0].height
            ),
            ([[0., 0.], [3., 4.]].as_slice(), 12., 23., 3., 4.)
        );
        assert_eq!(r[1].points().unwrap(), [[0., 0.], [100., 200.]]);
        // two points or more: normalized to the first
        let l0 = create(ElementType::Line, |s| {
            s.width = 100.;
            s.height = Some(200.);
            s.x = 10.;
            s.y = Some(20.);
        });
        let l1 = create(ElementType::Line, |s| {
            s.width = 200.;
            s.height = Some(400.);
            s.x = 30.;
            s.y = Some(40.);
        });
        let r = restore(
            vec![
                with(&l0, |o| {
                    o.insert("points".into(), json!([[0, 0], [1, 1]]));
                }),
                with(&l1, |o| {
                    o.insert("points".into(), json!([[3, 4], [5, 6]]));
                }),
            ],
            plain(),
        );
        assert_eq!(r[0].points().unwrap(), [[0., 0.], [1., 1.]]);
        assert_eq!(
            (r[1].points().unwrap(), r[1].x, r[1].y),
            ([[0., 0.], [2., 2.]].as_slice(), 33., 44.)
        );
    }

    #[test]
    fn huge_linear_elements_are_deleted() {
        setup();
        let huge = with(
            &create(ElementType::Line, |s| {
                s.x = 419048829414166.;
                s.y = Some(8484.);
            }),
            |o| {
                o.insert(
                    "points".into(),
                    json!([[0, 0], [-302985021938436i64, 0], [-838097658820234i64, 30]]),
                );
            },
        );
        let arrow = with(&create(ElementType::Arrow, |_| {}), |o| {
            o.insert("points".into(), json!([[0, 0], [900000, 0]]));
        });
        let normal = with(&create(ElementType::Line, |_| {}), |o| {
            o.insert("points".into(), json!([[0, 0], [100, 200]]));
        });
        let r = restore(vec![huge, arrow, normal], plain());
        assert_eq!(
            (r[0].is_deleted, r[0].width, r[0].height),
            (true, 100., 100.)
        );
        assert_eq!(
            (r[1].is_deleted, r[1].width, r[1].height),
            (true, 100., 100.)
        );
        assert_eq!(
            (r[2].is_deleted, r[2].width, r[2].height),
            (false, 100., 200.)
        );
    }

    #[test]
    fn restore_rectangle_ellipse_diamond() {
        setup();
        let els: Vec<Value> = [
            ElementType::Rectangle,
            ElementType::Ellipse,
            ElementType::Diamond,
        ]
        .iter()
        .enumerate()
        .map(|(i, &ty)| {
            val(&create(ty, |s| {
                s.id = Some((i + 1).to_string());
                s.fill_style = Some(FillStyle::CrossHatch);
                s.stroke_width = Some(2.);
                s.stroke_style = Some(StrokeStyle::Dashed);
                s.roughness = Some(2.);
                s.opacity = Some(10.);
                s.x = 10.;
                s.y = Some(20.);
                s.stroke_color = Some("red".into());
                s.background_color = Some("blue".into());
                s.width = 100.;
                s.height = Some(200.);
                s.group_ids = ids(&["1", "2", "3"]);
                s.roundness = true;
            }))
        })
        .collect();
        let r = restore(els, plain());
        for (e, (id, ty, index, rk)) in r.iter().zip([
            ("1", ElementType::Rectangle, "a0", 3),
            ("2", ElementType::Ellipse, "a1", 2),
            ("3", ElementType::Diamond, "a2", 2),
        ]) {
            assert_eq!(
                (e.id.as_str(), e.ty(), e.index.as_deref(), e.roundness),
                (
                    id,
                    ty,
                    Some(index),
                    Some(Roundness {
                        kind: rk,
                        value: None
                    })
                )
            );
            assert_eq!(
                (
                    e.fill_style,
                    e.stroke_style,
                    e.roughness,
                    e.opacity,
                    e.x,
                    e.y,
                    e.width,
                    e.height
                ),
                (
                    FillStyle::CrossHatch,
                    StrokeStyle::Dashed,
                    2.,
                    10.,
                    10.,
                    20.,
                    100.,
                    200.
                )
            );
            assert_eq!(
                (
                    e.stroke_color.as_str(),
                    e.background_color.as_str(),
                    e.group_ids.clone(),
                    e.version,
                    e.created,
                    e.updated
                ),
                ("red", "blue", ids(&["1", "2", "3"]), 2, Some(1), 1)
            );
        }
    }

    #[test]
    fn bump_versions_of_local_duplicates() {
        setup();
        let rectangle = rect();
        let ellipse = create(ElementType::Ellipse, |_| {});
        let modified = new_element_with(&rectangle, |e| e.is_deleted = true, false);
        let r = bump_element_versions(
            restore(vec![val(&rectangle), val(&ellipse)], plain()),
            Some(&vec![modified.clone()]),
        );
        assert_eq!(r[0].id, rectangle.id);
        assert_ne!(r[0].version_nonce, rectangle.version_nonce);
        assert_eq!(
            (r[0].version, r[1].id.as_str(), r[1].version),
            (
                modified.version + 1,
                ellipse.id.as_str(),
                ellipse.version + 1
            )
        );

        // even with the same version
        let rectangle = rect();
        let r1 = restore(vec![val(&rectangle)], plain()).remove(0);
        let r2 = restore(vec![val(&r1)], plain()).remove(0);
        // +1 for the re-index, not again
        assert_ne!(rectangle.version, r1.version);
        assert_eq!(
            (r1.version, r1.version_nonce),
            (r2.version, r2.version_nonce)
        );
        let m1 = new_element_with(&r1, |e| e.width = 500., false);
        let m2 = new_element_with(&r2, |e| e.width = 600., false);
        let r = bump_element_versions(restore(vec![val(&m1)], plain()), Some(&vec![m2.clone()]));
        assert_eq!(
            (r[0].id.as_str(), r[0].version),
            (rectangle.id.as_str(), m2.version + 1)
        );
        assert_ne!(r[0].version_nonce, m1.version_nonce);
    }

    // ---------------------------------------------------------------------------
    // restore.test.ts: repairing bindings
    // ---------------------------------------------------------------------------

    #[test]
    fn repair_bound_label_order_and_index() {
        for ty in [ElementType::Arrow, ElementType::Rectangle] {
            setup();
            let c = create(ty, |s| {
                s.id = Some("container".into());
                s.index = Some("b2f".into());
                s.bound_elements = Some(vec![text_bound("label")]);
            });
            let l = create(ElementType::Text, |s| {
                s.id = Some("label".into());
                s.index = Some("b2a".into());
                s.container_id = Some("container".into());
            });
            let r = restore(vec![val(&l), val(&c)], repair());
            assert_eq!(
                r.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
                ["container", "label"],
                "{ty:?}"
            );
            assert_eq!(r[0].index, c.index);
            assert!(r[1].index > r[0].index);
        }
    }

    #[test]
    fn strips_arrow_binding_if_repair_fails() {
        setup();
        let container = create(ElementType::Rectangle, |s| s.bound_elements = Some(vec![]));
        let arrow = create(ElementType::Arrow, |s| {
            s.id = Some("id-arrow01".into());
            s.end_binding = Some(FixedPointBinding {
                element_id: container.id.clone(),
                fixed_point: [0.5, 0.5],
                mode: BindMode::Inside,
            });
        });
        let container = with(&container, |o| {
            o.insert(
                "boundElements".into(),
                json!([{"type": "arrow", "id": "id-arrow01"}]),
            );
        });
        // invalid reference
        let arrow = with(&arrow, |o| {
            o.insert("endBinding".into(), json!({"elementId": 42}));
        });
        let r = restore(vec![arrow, container], plain());
        assert_eq!(r.len(), 2);
        let a = &r[0];
        assert_eq!(
            (
                a.id.as_str(),
                a.linear().unwrap().end_binding.clone(),
                a.version,
                a.index.as_deref()
            ),
            ("id-arrow01", None, 2, Some("a0"))
        );
        assert_eq!(
            (a.width, a.height, a.roundness, a.bound_elements.clone()),
            (100., 100., None, Some(vec![]))
        );
    }

    #[test]
    fn repair_container_bound_elements() {
        setup();
        let container = create(ElementType::Rectangle, |s| s.bound_elements = Some(vec![]));
        let text = create(ElementType::Text, |s| {
            s.container_id = Some(container.id.clone())
        });
        let r = restore(vec![val(&container), val(&text)], plain());
        assert_eq!(
            (r[0].bound_elements.clone(), r[1].container_id()),
            (Some(vec![]), Some(container.id.as_str()))
        );
        let r = restore(vec![val(&container), val(&text)], repair());
        assert_eq!(
            (r[0].bound_elements.clone(), r[1].container_id()),
            (
                Some(vec![text_bound(&text.id)]),
                Some(container.id.as_str())
            )
        );
    }

    #[test]
    fn repair_container_id_of_bound_elements() {
        setup();
        let text = create(ElementType::Text, |s| s.container_id = None);
        let container = create(ElementType::Rectangle, |s| {
            s.bound_elements = Some(vec![text_bound(&text.id)])
        });
        let r = restore(vec![val(&container), val(&text)], plain());
        assert_eq!(
            (r[0].bound_elements.clone(), r[1].container_id()),
            (Some(vec![text_bound(&text.id)]), None)
        );
        let r = restore(vec![val(&container), val(&text)], repair());
        assert_eq!(
            (r[0].bound_elements.clone(), r[1].container_id()),
            (
                Some(vec![text_bound(&text.id)]),
                Some(container.id.as_str())
            )
        );
    }

    #[test]
    fn ignore_deleted_bound_element() {
        setup();
        let container = create(ElementType::Rectangle, |s| s.bound_elements = Some(vec![]));
        let text = create(ElementType::Text, |s| {
            s.container_id = Some(container.id.clone());
            s.is_deleted = true;
        });
        let r = restore(vec![val(&container), val(&text)], plain());
        assert_eq!(
            (r[0].bound_elements.clone(), r[1].container_id()),
            (Some(vec![]), Some(container.id.as_str()))
        );
    }

    #[test]
    fn remove_bindings_of_deleted_elements() {
        setup();
        let container = create(ElementType::Rectangle, |s| s.bound_elements = Some(vec![]));
        let deleted = create(ElementType::Text, |s| {
            s.container_id = Some(container.id.clone());
            s.is_deleted = true;
        });
        let invisible_text = create(ElementType::Text, |s| {
            s.container_id = Some(container.id.clone());
            s.width = 0.;
            s.height = Some(0.);
        });
        let list = vec![
            text_bound(&deleted.id),
            text_bound(&invisible_text.id),
            text_bound("non-existent"),
        ];
        let container = {
            let mut c = container.clone();
            c.bound_elements = Some(list.clone());
            c
        };
        let opts = RestoreOpts {
            delete_invisible_elements: true,
            ..Default::default()
        };
        let r = restore(
            vec![val(&container), val(&invisible_text), val(&deleted)],
            opts,
        );
        assert_eq!(r[0].bound_elements, Some(list));
        assert_eq!(
            (r[1].container_id(), r[1].is_deleted),
            (Some(container.id.as_str()), true)
        );
        assert_eq!(r[2].container_id(), Some(container.id.as_str()));
        let opts = RestoreOpts {
            delete_invisible_elements: true,
            repair_bindings: true,
            ..Default::default()
        };
        let r = restore(
            vec![val(&container), val(&invisible_text), val(&deleted)],
            opts,
        );
        assert_eq!(r[0].bound_elements, Some(vec![]));
        assert_eq!(
            (r[1].container_id(), r[1].is_deleted),
            (Some(container.id.as_str()), true)
        );
        assert_eq!(r[2].container_id(), Some(container.id.as_str()));
    }

    #[test]
    fn remove_container_id_if_container_missing() {
        setup();
        let t = create(ElementType::Text, |s| {
            s.container_id = Some("non-existent".into())
        });
        let td = create(ElementType::Text, |s| {
            s.container_id = Some("non-existent".into());
            s.is_deleted = true;
        });
        let r = restore(vec![val(&t), val(&td)], plain());
        assert_eq!(
            (r[0].container_id(), r[1].container_id()),
            (Some("non-existent"), Some("non-existent"))
        );
        let r = restore(vec![val(&t), val(&td)], repair());
        assert_eq!((r[0].container_id(), r[1].container_id()), (None, None));
    }

    #[test]
    fn legacy_bindings_go_through_the_hook() {
        setup();
        let target = create(ElementType::Rectangle, |s| s.id = Some("r".into()));
        let arrow = with(&create(ElementType::Arrow, |_| {}), |o| {
            o.insert(
                "startBinding".into(),
                json!({"elementId": "r", "focus": 0.2, "gap": 4}),
            );
        });
        // without a hook, a v1 binding is migrated by binding.rs (board_binding.rs checks how)
        assert_eq!(
            restore(vec![val(&target), arrow.clone()], repair())[1]
                .linear()
                .unwrap()
                .start_binding
                .as_ref()
                .map(|b| b.element_id.as_str()),
            Some("r")
        );
        fn hook(
            _: &Element,
            end: StartOrEnd,
            bound: &Element,
            _: &dyn ElementsMap,
        ) -> Option<FixedPointBinding> {
            assert_eq!(end, StartOrEnd::Start);
            Some(FixedPointBinding {
                element_id: bound.id.clone(),
                fixed_point: [0., 0.25],
                mode: BindMode::Orbit,
            })
        }
        let opts = RestoreOpts {
            legacy_binding: Some(hook),
            ..repair()
        };
        let b = restore(vec![val(&target), arrow], opts)[1]
            .linear()
            .unwrap()
            .start_binding
            .clone();
        assert_eq!(
            b,
            Some(FixedPointBinding {
                element_id: "r".into(),
                fixed_point: [0., 0.25],
                mode: BindMode::Orbit
            })
        );
    }

    #[test]
    fn restore_saved_app_state() {
        let a = restore_app_state(
            Some(
                &json!({"gridSize": 7.6, "gridStep": 500, "gridModeEnabled": true, "viewBackgroundColor": "#000"}),
            ),
            None,
        );
        assert_eq!(
            a,
            ExportedAppState {
                view_background_color: "#000".into(),
                grid_size: 8.,
                grid_step: 100.,
                grid_mode_enabled: true
            }
        );
        let local = ExportedAppState {
            view_background_color: "#123".into(),
            grid_size: 40.,
            grid_step: 2.,
            grid_mode_enabled: true,
        };
        // grid size and step don't fall back to the local state
        assert_eq!(
            restore_app_state(None, Some(&local)),
            ExportedAppState {
                grid_size: 20.,
                grid_step: 5.,
                ..local.clone()
            }
        );
        assert_eq!(
            restore_app_state(Some(&json!({"gridSize": "x"})), None),
            ExportedAppState::default()
        );
    }

    // ---------------------------------------------------------------------------
    // utils
    // ---------------------------------------------------------------------------

    #[test]
    fn utils() {
        assert!(
            is_transparent("transparent")
                && is_transparent("#ffffff00")
                && is_transparent("#fff0")
                && is_transparent("rgba(1, 2, 3, 0)")
        );
        assert!(
            !is_transparent("#ffffff")
                && !is_transparent("red")
                && !is_transparent("rgba(1,2,3,0.5)")
                && !is_transparent("nope")
        );
        assert_eq!(normalize_link("  javascript:alert(1) "), "about:blank");
        assert_eq!(normalize_link("\u{0}java\tscript:x"), "about:blank");
        assert_eq!(
            normalize_link("https://a.b/\"c\""),
            "https://a.b/&quot;c&quot;"
        );
        assert_eq!(normalize_link("/relative"), "/relative");
        assert_eq!(normalize_fixed_point(Some([0.5, 3.])), [0.5001, 3.]);
        assert_eq!(normalize_fixed_point(Some([11., -20.])), [10., -10.]);
        assert_eq!(normalize_fixed_point(None), [0.5001, 0.5001]);
        assert_eq!(hash_string("abc"), 193485963);
        for (v, s) in [
            (10., "10"),
            (10.5, "10.5"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (123456789012., "123456789012"),
            (1.5e-7, "1.5e-7"),
            (-0.000001, "-0.000001"),
            (2.5e25, "2.5e+25"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
            (0.000123, "0.000123"),
            (-42.75, "-42.75"),
            (1. / 3., "0.3333333333333333"),
            (-0., "0"),
        ] {
            assert_eq!(js_number(v), s);
        }
        assert_eq!(
            measure_text(&TestMeasure, "ab\n\nabc", Font::new(20., 5), 1.25),
            Metrics {
                width: 30.,
                height: 75.
            }
        );
    }

    // ---------------------------------------------------------------------------
    // files: round trips
    // ---------------------------------------------------------------------------

    const FIXTURE: &str = include_str!("fixtures/board/all-elements.excalidraw");

    #[test]
    fn excalidraw_file_round_trip() {
        setup();
        let data = load_file(FIXTURE, &RestoreOpts::load()).unwrap();
        let els = &data.elements;
        assert_eq!(els.len(), 11);
        // nothing in the fixture needs repair: versions and indices are as written
        assert_eq!(
            els.iter().map(|e| e.version).collect::<Vec<_>>(),
            [5, 3, 2, 7, 1, 12, 1, 3, 2, 4, 2]
        );
        assert_eq!(
            els[0].extra.get("customFlag"),
            Some(&json!({"nested": [1, 2.5, "x"]}))
        );
        assert_eq!(els[2].custom_data, Some(json!({"owner": "me", "n": 3})));
        let arrow = els[3].linear().unwrap();
        assert_eq!(
            arrow
                .start_binding
                .as_ref()
                .map(|b| (b.element_id.as_str(), b.mode)),
            Some(("rect1", BindMode::Orbit))
        );
        assert_eq!(
            arrow
                .end_binding
                .as_ref()
                .map(|b| (b.element_id.as_str(), b.fixed_point, b.mode)),
            Some(("ell1", [0.1, 0.75], BindMode::Inside))
        );
        assert!(els[4].is_line_polygon());
        assert_eq!(els[7].image().unwrap().crop.unwrap().natural_width, 640.);
        assert_eq!(els[7].image().unwrap().scale, [1., -1.]);
        assert_eq!(els[8].frame_name(), Some("Group A"));
        assert_eq!(els[10].text().unwrap().base_font_size, Some(28.));
        assert_eq!(data.app_state.view_background_color, "#f8f9fa");
        assert_eq!(data.files["file1"].last_retrieved, Some(1731576000000));

        let written =
            serialize_as_json(els, &data.app_state, &data.files, "https://excalidraw.com");
        let again = load_file(&written, &RestoreOpts::load()).unwrap();
        assert_eq!(again, data);
        assert_eq!(
            serialize_as_json(
                &again.elements,
                &again.app_state,
                &again.files,
                "https://excalidraw.com"
            ),
            written
        );
        // JSON.stringify(…, null, 2) layout
        assert!(written.starts_with("{\n  \"type\": \"excalidraw\",\n  \"version\": 2,\n  \"source\": \"https://excalidraw.com\",\n  \"elements\": [\n    {\n      \"id\": \"rect1\",\n      \"type\": \"rectangle\",\n      \"x\": 100,\n      \"y\": 120.5,"));

        let scene = serialize_scene(els, &data.files);
        assert_eq!(scene.lines().count(), 1 + 11 + 1 + 1 + 1);
        assert!(scene.starts_with("{\"elements\":[\n{\"id\":\"rect1\",\"type\":\"rectangle\",\"x\":100,\"y\":120.5,\"strokeColor\":\"#1e1e1e\""));
        assert!(scene.ends_with("\n],\"files\":{\n\"file1\":{\"mimeType\":\"image/png\",\"id\":\"file1\",\"dataURL\":\"data:image/png;base64,iVBORw0KGgo=\",\"created\":1731575000000,\"lastRetrieved\":1731576000000}\n}}"));
        let back = load_scene(&scene, &RestoreOpts::load()).unwrap();
        assert_eq!(
            (back.elements, back.files),
            (data.elements.clone(), data.files.clone())
        );
        // unknown keys come after the modeled ones
        let line0 = scene.lines().nth(1).unwrap();
        assert!(line0.ends_with(",\"link\":\"https://example.com/a\",\"locked\":false,\"customFlag\":{\"nested\":[1,2.5,\"x\"]}},"));
        // files only deleted elements use are left out
        let mut deleted = data.elements.clone();
        deleted[7].is_deleted = true;
        assert!(serialize_scene(&deleted, &data.files).ends_with("],\"files\":{}}"));
        assert_eq!(
            serialize_scene(&[], &data.files),
            "{\"elements\":[],\"files\":{}}"
        );
    }

    #[test]
    fn every_element_kind_round_trips() {
        setup();
        let mut els: Vec<Element> = [
            ElementType::Rectangle,
            ElementType::Diamond,
            ElementType::Ellipse,
            ElementType::Text,
            ElementType::Line,
            ElementType::Arrow,
            ElementType::FreeDraw,
            ElementType::Image,
            ElementType::Frame,
            ElementType::MagicFrame,
            ElementType::Embeddable,
            ElementType::Iframe,
            ElementType::StickyNote,
        ]
        .iter()
        .map(|&ty| {
            create(ty, |s| {
                s.points = Some(vec![[0., 0.], [10.5, -3.25], [20., 1e-7]]);
                s.roundness = true;
            })
        })
        .collect();
        els.push(new_arrow_element(
            ElementOpts {
                width: 50.,
                height: 50.,
                ..Default::default()
            },
            vec![[0., 0.], [0., 25.], [50., 25.], [50., 50.]],
            Some(Arrowhead::Diamond),
            Some(Arrowhead::CardinalityZeroOrMany),
            true,
            Some(vec![FixedSegment {
                start: [0., 25.],
                end: [50., 25.],
                index: 2,
            }]),
        ));
        let mut scene = Scene::new(els);
        scene.mutate_element("id0", false, |e| {
            e.custom_data = Some(json!({"k": [null, true, 1.5]}))
        });
        let els = scene.into_elements();
        let opts = RestoreOpts {
            repair_bindings: true,
            ..Default::default()
        };
        let first = load_scene(&serialize_scene(&els, &Default::default()), &opts)
            .unwrap()
            .elements;
        // restore turns `boundElements: null` into `[]` and sizes lines and
        // arrows by their points; nothing else changes
        let mut want = els.clone();
        for e in &mut want {
            e.bound_elements.get_or_insert_default();
            if let Some(p) = e.linear().map(|l| l.points.clone()) {
                (e.width, e.height) = get_size_from_points(&p);
            }
        }
        assert_eq!(first, want);
        let s = serialize_scene(&first, &Default::default());
        let back = load_scene(&s, &opts).unwrap();
        assert_eq!(back.elements, first);
        assert_eq!(serialize_scene(&back.elements, &Default::default()), s);
    }
}
