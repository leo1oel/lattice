// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Undo / redo and viewport math: upstream Excalidraw tests @ 3a317b5.
//! - element/tests/delta.test.tsx: all of it. The three "detects … by a
//!   container's redraw" / "container resized" cases need text layout and
//!   arrow routing, which aren't ported: a test `HistoryHooks` stands in
//!   (centers the label, grows the container, moves the arrow to its fixed
//!   point), so they check that layout effects count as visible. The redraw
//!   guard runs in the "test" and "production" modes (`guard_redraw` on / off;
//!   "development" is the same as "test").
//! - excalidraw/tests/history.test.tsx: the cases whose intent is a sequence
//!   of scene / app state updates, re-expressed through a small editor
//!   (`Ed`: scene + app state + Store + History, committing like `App`).
//!   UI gestures become the updates they make (`UI.createElement` adds the
//!   element and selects it in one capture, a click selects, delete marks the
//!   selection deleted and unbinds it, …).
//! - excalidraw/tests/viewport.test.ts (scrollBoundsIntoView), plus zoom
//!   about a point, zoom to fit and coordinate round trips, with
//!   fitToContent.test.tsx's "keep the current zoom and only center" values.
//!
//! history.test.tsx cases skipped, with reasons:
//! - "should not collapse when applying corrupted history entry": mocks
//!   `applyTo` to throw; nothing in the port throws.
//! - drag & drop / paste of scenes, images and embeddables, "should create
//!   entry when selecting freedraw", linear element editor points, "should
//!   disable undo/redo buttons", "remounting undo/redo buttons": React UI,
//!   file and clipboard plumbing, not history logic.
//! - "should support duplication of groups …": duplication isn't ported.
//! - "should redraw arrows on undo", "should update bound element points when
//!   rectangle was remotely moved …", "should redraw remotely added bound
//!   text …", "should redraw bound text to match container dimensions …":
//!   need elbow routing / text layout (the `HistoryHooks` points).
//! - "should not let remote changes to interfere with in progress freedraw /
//!   resizing / dragging": about the in-gesture guards of the UI.
//! - "should support undo and redo when escape unwinds nested group editing":
//!   `it.skip` upstream.
//! - "should unbind remotely deleted bindable elements from arrow …": empty
//!   upstream.
//! - the remaining "conflicts in bound text elements / arrows / frames"
//!   cases not listed below: each builds its scene through UI binding
//!   gestures and checks layout snapshots; the binding repairs they rely on
//!   are covered by the bidirectional binding and remote rebinding cases.

mod board {
    use lattice_board_core::board::app_state::*;
    use lattice_board_core::board::fractional_index::sync_moved_indices;
    use lattice_board_core::board::history::*;
    use lattice_board_core::board::mutate::{bump_version, fix_timestamp, new_element_with};
    use lattice_board_core::board::new_element::*;
    use lattice_board_core::board::random::reseed;
    use lattice_board_core::board::scene::Scene;
    use lattice_board_core::board::types::*;
    use lattice_board_core::board::viewport::*;
    use rustc_hash::FxHashSet;
    use serde_json::{Value, json};
    use std::collections::{BTreeMap, BTreeSet};

    fn setup() {
        reseed(7);
        fix_timestamp(Some(1));
    }

    fn opts(id: &str, index: &str) -> ElementOpts {
        ElementOpts {
            id: Some(id.into()),
            index: Some(index.into()),
            width: 100.,
            height: 100.,
            ..Default::default()
        }
    }
    fn rect_el(id: &str, index: &str) -> Element {
        new_element(ElementType::Rectangle, opts(id, index))
    }
    fn text_el(id: &str, index: &str, container: Option<&str>, text: &str) -> Element {
        let mut e = new_element(
            ElementType::Rectangle,
            ElementOpts {
                width: 0.,
                height: 25.,
                ..opts(id, index)
            },
        );
        e.kind = Kind::Text(TextData {
            font_size: 20.,
            font_family: 5,
            base_font_size: None,
            text: text.into(),
            text_align: TextAlign::Center,
            vertical_align: VerticalAlign::Middle,
            container_id: container.map(Into::into),
            original_text: text.into(),
            auto_resize: true,
            line_height: 1.25,
            label_position: None,
        });
        e
    }
    fn arrow_el(id: &str, index: &str, x: f64, y: f64, points: Vec<[f64; 2]>) -> Element {
        new_arrow_element(
            ElementOpts {
                x,
                y,
                ..opts(id, index)
            },
            points,
            None,
            Some(Arrowhead::Arrow),
            false,
            None,
        )
    }
    fn binding(id: &str, fp: [f64; 2]) -> Option<FixedPointBinding> {
        Some(FixedPointBinding {
            element_id: id.into(),
            fixed_point: fp,
            mode: BindMode::Orbit,
        })
    }
    fn bound(items: &[(&str, BoundType)]) -> Option<Vec<BoundElement>> {
        Some(
            items
                .iter()
                .map(|(id, kind)| BoundElement {
                    id: (*id).into(),
                    kind: *kind,
                })
                .collect(),
        )
    }
    fn with(e: &Element, f: impl FnOnce(&mut Element)) -> Element {
        new_element_with(e, f, false)
    }
    /// `newElementWith(e, { version: e.version + 1 })`: only the version moves.
    fn bumped(e: &Element) -> Element {
        let mut n = e.clone();
        bump_version(&mut n, None);
        n
    }
    fn map(els: Vec<Element>) -> ElementMap {
        els.into_iter().collect()
    }
    fn partial(v: Value) -> Partial {
        if let Value::Object(m) = v {
            m
        } else {
            panic!()
        }
    }
    fn d(a: Value, b: Value) -> Delta {
        Delta::from_json(a, b)
    }
    fn one(id: &str, delta: Delta) -> BTreeMap<String, Delta> {
        BTreeMap::from([(id.to_owned(), delta)])
    }

    // -----------------------------------------------------------------------
    // delta.test.tsx
    // -----------------------------------------------------------------------

    fn apply_with(
        before: &ElementMap,
        after: &ElementMap,
        hooks: &mut dyn HistoryHooks,
    ) -> (ElementMap, bool) {
        ElementsDelta::calculate(before, after).apply_to(
            before,
            before,
            &ApplyToOptions::history(),
            hooks,
        )
    }
    fn apply(before: &ElementMap, after: &ElementMap) -> (ElementMap, bool) {
        apply_with(before, after, &mut NoHooks)
    }

    /// The container (rectangle, sticky note or arrow) with an empty (or
    /// given) label, and the scene with the label deleted.
    fn bound_text(ty: ElementType, text: &str) -> (Element, Element, ElementMap, ElementMap) {
        let o = ElementOpts {
            width: 250.,
            height: if ty == ElementType::Arrow { 0. } else { 250. },
            bound_elements: bound(&[("label", BoundType::Text)]),
            ..opts("container", "a0")
        };
        let container = match ty {
            ElementType::StickyNote => new_sticky_note_element(o, Some(250.)),
            ElementType::Arrow => new_arrow_element(
                o,
                vec![[0., 0.], [250., 0.]],
                None,
                Some(Arrowhead::Arrow),
                false,
                None,
            ),
            _ => new_element(ElementType::Rectangle, o),
        };
        let label = text_el("label", "a1", Some("container"), text);
        let before = map(vec![container.clone(), label.clone()]);
        let after = map(vec![
            with(&container, |e| e.bound_elements = Some(vec![])),
            with(&label, |e| e.is_deleted = true),
        ]);
        (container, label, before, after)
    }

    #[test]
    fn ignores_empty_label_deletion_and_restoration() {
        for ty in [ElementType::Rectangle, ElementType::StickyNote] {
            setup();
            let (_, _, before, after) = bound_text(ty, "");
            let (deleted, visible) = apply(&before, &after);
            assert!(!visible);
            assert!(deleted.get("label").unwrap().is_deleted);
            assert_eq!(
                deleted.get("container").unwrap().bound_elements,
                Some(vec![])
            );
            let (restored, visible) = apply(&after, &before);
            assert!(!visible);
            assert!(!restored.get("label").unwrap().is_deleted);
            assert_eq!(
                restored.get("container").unwrap().bound_elements,
                bound(&[("label", BoundType::Text)])
            );
        }
    }

    #[test]
    fn keeps_deletion_and_restoration_of_nonempty_labels_visible() {
        setup();
        let (_, _, before, after) = bound_text(ElementType::StickyNote, "hello");
        assert!(apply(&before, &after).1);
        assert!(apply(&after, &before).1);
    }

    #[test]
    fn ignores_excluded_and_already_applied_properties() {
        for excluded in [true, false] {
            setup();
            let element = rect_el("r", "a0");
            let before = map(vec![element.clone()]);
            let after = map(vec![with(&element, |e| e.stroke_color = "red".into())]);
            let mut delta = ElementsDelta::calculate(&before, &after);
            let current = if excluded { &before } else { &after };
            let mut o = ApplyToOptions::history();
            if excluded {
                o.excluded_properties.push("strokeColor".into());
            }
            let (elements, visible) = delta.apply_to(current, current, &o, &mut NoHooks);
            assert_eq!(
                elements.get("r").unwrap().stroke_color,
                current.get("r").unwrap().stroke_color
            );
            assert!(!visible);
        }
    }

    #[test]
    fn keeps_snapshot_restoration_visible_for_a_metadata_only_update() {
        setup();
        let element = rect_el("r", "a0");
        let before = map(vec![element.clone()]);
        let after = map(vec![bumped(&element)]);
        let mut delta = ElementsDelta::calculate(&before, &after);
        let (elements, visible) = delta.apply_to(
            &ElementMap::new(),
            &before,
            &ApplyToOptions::default(),
            &mut NoHooks,
        );
        assert!(!elements.get("r").unwrap().is_deleted);
        assert!(visible);
    }

    #[test]
    fn keeps_an_arrows_empty_label_gap_visible() {
        setup();
        let (_, _, before, after) = bound_text(ElementType::Arrow, "");
        assert!(apply(&before, &after).1);
        assert!(apply(&after, &before).1);
    }

    /// Stands in for text layout and arrow routing: grows the container to
    /// fit the label and centers it; moves bound arrows' start to their fixed
    /// point.
    struct Layout;
    impl HistoryHooks for Layout {
        fn redraw_text_bounding_box(
            &mut self,
            text_id: &str,
            container_id: &str,
            els: &mut ElementMap,
        ) {
            let (c, t) = (
                els.get(container_id).unwrap().clone(),
                els.get(text_id).unwrap().clone(),
            );
            let h = c.height.max(t.height + 10.);
            els.mutate(container_id, |e| e.height = h);
            els.mutate(text_id, |e| {
                e.x = c.x + (c.width - t.width) / 2.;
                e.y = c.y + (h - t.height) / 2.;
            });
        }
        fn update_bound_elements(&mut self, id: &str, els: &mut ElementMap, _: &FxHashSet<String>) {
            let b = els.get(id).unwrap().clone();
            for be in b
                .bound_elements
                .iter()
                .flatten()
                .filter(|x| x.kind == BoundType::Arrow)
            {
                let Some(fp) = els.get(&be.id).and_then(|a| {
                    a.linear()?
                        .start_binding
                        .as_ref()
                        .filter(|s| s.element_id == id)
                        .map(|s| s.fixed_point)
                }) else {
                    continue;
                };
                els.mutate(&be.id, |a| {
                    a.x = b.x + b.width * fp[0];
                    a.y = b.y + b.height * fp[1];
                });
            }
        }
    }

    #[test]
    fn detects_a_container_resized_by_restoring_an_empty_label() {
        setup();
        let (container, label, _, _) = bound_text(ElementType::Rectangle, "");
        let small = with(&container, |e| {
            e.width = 20.;
            e.height = 10.;
            e.bound_elements = Some(vec![]);
        });
        let before = map(vec![small.clone(), with(&label, |e| e.is_deleted = true)]);
        let after = map(vec![
            with(&small, |e| {
                e.bound_elements = bound(&[("label", BoundType::Text)])
            }),
            with(&label, |e| e.is_deleted = false),
        ]);
        let (elements, visible) = apply_with(&before, &after, &mut Layout);
        assert!(elements.get("container").unwrap().height > 10.);
        assert!(visible);
    }

    #[test]
    fn detects_a_bound_label_repositioned_by_a_containers_redraw() {
        setup();
        let (container, label, _, _) = bound_text(ElementType::Rectangle, "hello");
        let misplaced = with(&label, |e| {
            e.x = -100.;
            e.y = -100.;
        });
        let before = map(vec![container.clone(), misplaced.clone()]);
        let after = map(vec![bumped(&container), misplaced]);
        let (elements, visible) = apply_with(&before, &after, &mut Layout);
        assert_eq!(elements.get("container").unwrap().height, container.height);
        assert_ne!(elements.get("label").unwrap().x, -100.);
        assert!(visible);
    }

    #[test]
    fn detects_a_bound_arrow_repositioned_by_a_containers_redraw() {
        setup();
        let container = new_element(
            ElementType::Rectangle,
            ElementOpts {
                bound_elements: bound(&[("arrow", BoundType::Arrow)]),
                ..opts("container", "a0")
            },
        );
        let mut arrow = arrow_el("arrow", "a1", 200., 50., vec![[0., 0.], [100., 0.]]);
        arrow.linear_mut().unwrap().start_binding = binding("container", [1., 0.5]);
        let before = map(vec![container.clone(), arrow.clone()]);
        let after = map(vec![bumped(&container), arrow]);
        let (elements, visible) = apply_with(&before, &after, &mut Layout);
        assert_eq!(elements.get("container").unwrap().width, container.width);
        assert_ne!(elements.get("arrow").unwrap().x, 200.);
        assert!(visible);
    }

    /// Moves an element the delta has nothing to do with.
    struct Rogue;
    impl HistoryHooks for Rogue {
        fn redraw_text_bounding_box(&mut self, _: &str, _: &str, _: &mut ElementMap) {}
        fn update_bound_elements(&mut self, _: &str, els: &mut ElementMap, _: &FxHashSet<String>) {
            els.mutate("unrelated", |e| e.x += 1.);
        }
    }

    #[test]
    fn guards_against_untracked_layout_mutations() {
        for guard in [true, false] {
            setup();
            let element = rect_el("changed", "a0");
            let unrelated = rect_el("unrelated", "a1");
            let before = map(vec![element.clone(), unrelated.clone()]);
            let after = map(vec![
                with(&element, |e| e.stroke_color = "red".into()),
                unrelated,
            ]);
            let mut delta = ElementsDelta::calculate(&before, &after);
            let o = ApplyToOptions {
                guard_redraw: guard,
                ..ApplyToOptions::history()
            };
            if guard {
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    delta.apply_to(&before, &before, &o, &mut Rogue)
                }));
                let msg = r
                    .err()
                    .and_then(|e| e.downcast_ref::<String>().cloned())
                    .unwrap();
                assert_eq!(
                    msg,
                    "Redrawn element \"unrelated\" is missing from idsToCheck"
                );
            } else {
                assert!(delta.apply_to(&before, &before, &o, &mut Rogue).1);
            }
        }
    }

    #[test]
    fn keeps_an_empty_text_elements_arrow_bindings_visible() {
        setup();
        let mut label = text_el("label", "a0", None, "");
        label.bound_elements = bound(&[("arrow", BoundType::Arrow)]);
        let mut arrow = arrow_el("arrow", "a1", 0., 0., vec![[0., 0.], [100., 0.]]);
        arrow.linear_mut().unwrap().start_binding = binding("label", [1., 0.5]);
        let before = map(vec![label.clone(), arrow.clone()]);
        let after = map(vec![
            with(&label, |e| {
                e.is_deleted = true;
                e.bound_elements = Some(vec![]);
            }),
            with(&arrow, |e| e.linear_mut().unwrap().start_binding = None),
        ]);
        assert!(apply(&before, &after).1);
    }

    #[test]
    fn calculation_does_not_throw_on_already_deleted_elements() {
        setup();
        let element = new_element(
            ElementType::Rectangle,
            ElementOpts {
                x: 100.,
                y: 100.,
                ..opts("r", "a0")
            },
        );
        let deleted = with(&element, |e| e.is_deleted = true);
        // removed but already deleted; added as already deleted
        let a = ElementsDelta::calculate(&map(vec![deleted.clone()]), &ElementMap::new());
        assert!(a.updated.contains_key("r") && a.removed.is_empty());
        let b = ElementsDelta::calculate(&ElementMap::new(), &map(vec![deleted]));
        assert!(b.updated.contains_key("r") && b.added.is_empty());
    }

    #[test]
    fn creates_updated_delta_for_a_version_only_change() {
        setup();
        let base = new_element(
            ElementType::Rectangle,
            ElementOpts {
                x: 100.,
                y: 100.,
                stroke_color: "#000000".into(),
                background_color: "#ffffff".into(),
                ..opts("r", "a0")
            },
        );
        let mut modified = base.clone();
        modified.version += 1;
        modified.version_nonce += 1;
        let delta = ElementsDelta::calculate(&map(vec![base.clone()]), &map(vec![modified]));
        assert_eq!(
            delta,
            ElementsDelta::create(
                BTreeMap::new(),
                BTreeMap::new(),
                one(
                    "r",
                    d(
                        json!({"version": base.version, "versionNonce": base.version_nonce}),
                        json!({"version": base.version + 1, "versionNonce": base.version_nonce + 1})
                    )
                ),
                false
            )
        );
    }

    #[test]
    fn squash_with_an_empty_delta_changes_nothing() {
        let updated = d(
            json!({"x": 100, "version": 1, "versionNonce": 1}),
            json!({"x": 200, "version": 2, "versionNonce": 2}),
        );
        let mut d1 = ElementsDelta::create(
            BTreeMap::new(),
            BTreeMap::new(),
            one("id1", updated.clone()),
            false,
        );
        let before = d1.clone();
        d1.squash(&ElementsDelta::empty());
        assert!(!d1.is_empty());
        assert_eq!(d1, before);
        assert_eq!(d1.updated["id1"], updated);
    }

    #[test]
    fn squash_mutually_exclusive_delta_types() {
        let added = d(
            json!({"x": 100, "version": 1, "versionNonce": 1, "isDeleted": true}),
            json!({"x": 200, "version": 2, "versionNonce": 2, "isDeleted": false}),
        );
        let removed = d(
            json!({"x": 100, "version": 1, "versionNonce": 1, "isDeleted": false}),
            json!({"x": 200, "version": 2, "versionNonce": 2, "isDeleted": true}),
        );
        let updated = d(
            json!({"x": 100, "version": 1, "versionNonce": 1}),
            json!({"x": 200, "version": 2, "versionNonce": 2}),
        );
        let mut d1 = ElementsDelta::create(
            one("id1", added.clone()),
            one("id2", removed.clone()),
            BTreeMap::new(),
            false,
        );
        d1.squash(&ElementsDelta::create(
            BTreeMap::new(),
            BTreeMap::new(),
            one("id3", updated.clone()),
            false,
        ));
        assert_eq!(
            (&d1.added["id1"], &d1.removed["id2"], &d1.updated["id3"]),
            (&added, &removed, &updated)
        );
    }

    #[test]
    fn squash_the_same_delta_types() {
        let mut d1 = ElementsDelta::create(
            one(
                "id1",
                d(
                    json!({"x": 100, "version": 1, "versionNonce": 1, "isDeleted": true}),
                    json!({"x": 200, "version": 2, "versionNonce": 2, "isDeleted": false}),
                ),
            ),
            one(
                "id2",
                d(
                    json!({"x": 100, "version": 1, "versionNonce": 1, "isDeleted": false}),
                    json!({"x": 200, "version": 2, "versionNonce": 2, "isDeleted": true}),
                ),
            ),
            one(
                "id3",
                d(
                    json!({"x": 100, "version": 1, "versionNonce": 1}),
                    json!({"x": 200, "version": 2, "versionNonce": 2}),
                ),
            ),
            false,
        );
        let d2 = ElementsDelta::create(
            one(
                "id1",
                d(
                    json!({"y": 100, "version": 2, "versionNonce": 2, "isDeleted": true}),
                    json!({"y": 200, "version": 3, "versionNonce": 3, "isDeleted": false}),
                ),
            ),
            one(
                "id2",
                d(
                    json!({"y": 100, "version": 2, "versionNonce": 2, "isDeleted": false}),
                    json!({"y": 200, "version": 3, "versionNonce": 3, "isDeleted": true}),
                ),
            ),
            one(
                "id3",
                d(
                    json!({"y": 100, "version": 2, "versionNonce": 2}),
                    json!({"y": 200, "version": 3, "versionNonce": 3}),
                ),
            ),
            false,
        );
        d1.squash(&d2);
        assert_eq!(
            d1.added["id1"],
            d(
                json!({"x": 100, "y": 100, "version": 2, "versionNonce": 2, "isDeleted": true}),
                json!({"x": 200, "y": 200, "version": 3, "versionNonce": 3, "isDeleted": false})
            )
        );
        assert_eq!(
            d1.removed["id2"],
            d(
                json!({"x": 100, "y": 100, "version": 2, "versionNonce": 2, "isDeleted": false}),
                json!({"x": 200, "y": 200, "version": 3, "versionNonce": 3, "isDeleted": true})
            )
        );
        assert_eq!(
            d1.updated["id3"],
            d(
                json!({"x": 100, "y": 100, "version": 2, "versionNonce": 2}),
                json!({"x": 200, "y": 200, "version": 3, "versionNonce": 3})
            )
        );
    }

    #[test]
    fn squash_different_delta_types() {
        // id1: added -> updated => added; id2: removed -> added => added; id3: updated -> removed => removed
        let mut d1 = ElementsDelta::create(
            one(
                "id1",
                d(
                    json!({"x": 100, "version": 1, "versionNonce": 1, "isDeleted": true}),
                    json!({"x": 101, "version": 2, "versionNonce": 2, "isDeleted": false}),
                ),
            ),
            one(
                "id2",
                d(
                    json!({"x": 200, "version": 1, "versionNonce": 1, "isDeleted": false}),
                    json!({"x": 201, "version": 2, "versionNonce": 2, "isDeleted": true}),
                ),
            ),
            one(
                "id3",
                d(
                    json!({"x": 300, "version": 1, "versionNonce": 1}),
                    json!({"x": 301, "version": 2, "versionNonce": 2}),
                ),
            ),
            false,
        );
        let d2 = ElementsDelta::create(
            one(
                "id2",
                d(
                    json!({"y": 200, "version": 2, "versionNonce": 2, "isDeleted": true}),
                    json!({"y": 201, "version": 3, "versionNonce": 3, "isDeleted": false}),
                ),
            ),
            one(
                "id3",
                d(
                    json!({"y": 300, "version": 2, "versionNonce": 2, "isDeleted": false}),
                    json!({"y": 301, "version": 3, "versionNonce": 3, "isDeleted": true}),
                ),
            ),
            one(
                "id1",
                d(
                    json!({"y": 100, "version": 2, "versionNonce": 2}),
                    json!({"y": 101, "version": 3, "versionNonce": 3}),
                ),
            ),
            false,
        );
        d1.squash(&d2);
        assert_eq!(
            d1.added,
            BTreeMap::from([
                (
                    "id1".to_owned(),
                    d(
                        json!({"x": 100, "y": 100, "version": 2, "versionNonce": 2, "isDeleted": true}),
                        json!({"x": 101, "y": 101, "version": 3, "versionNonce": 3, "isDeleted": false})
                    )
                ),
                (
                    "id2".to_owned(),
                    d(
                        json!({"x": 200, "y": 200, "version": 2, "versionNonce": 2, "isDeleted": true}),
                        json!({"x": 201, "y": 201, "version": 3, "versionNonce": 3, "isDeleted": false})
                    )
                ),
            ])
        );
        assert_eq!(
            d1.removed,
            one(
                "id3",
                d(
                    json!({"x": 300, "y": 300, "version": 2, "versionNonce": 2, "isDeleted": false}),
                    json!({"x": 301, "y": 301, "version": 3, "versionNonce": 3, "isDeleted": true})
                )
            )
        );
        assert!(d1.updated.is_empty());
    }

    #[test]
    fn squash_bound_elements() {
        let mut d1 = ElementsDelta::create(
            BTreeMap::new(),
            BTreeMap::new(),
            one(
                "id1",
                d(
                    json!({"version": 1, "versionNonce": 1, "boundElements": [{"id": "t1", "type": "text"}]}),
                    json!({"version": 2, "versionNonce": 2, "boundElements": [{"id": "t2", "type": "text"}]}),
                ),
            ),
            false,
        );
        let d2 = ElementsDelta::create(
            BTreeMap::new(),
            BTreeMap::new(),
            one(
                "id1",
                d(
                    json!({"version": 2, "versionNonce": 2, "boundElements": [{"id": "a1", "type": "arrow"}]}),
                    json!({"version": 3, "versionNonce": 3, "boundElements": [{"id": "a2", "type": "arrow"}]}),
                ),
            ),
            false,
        );
        d1.squash(&d2);
        assert_eq!(
            d1.updated["id1"].deleted["boundElements"],
            json!([{"id": "t1", "type": "text"}, {"id": "a1", "type": "arrow"}])
        );
        assert_eq!(
            d1.updated["id1"].inserted["boundElements"],
            json!([{"id": "t2", "type": "text"}, {"id": "a2", "type": "arrow"}])
        );
    }

    fn observed(f: impl FnOnce(&mut ObservedAppState)) -> ObservedAppState {
        let mut o = ObservedAppState::default();
        f(&mut o);
        o
    }
    fn ids(xs: &[&str]) -> BTreeSet<String> {
        xs.iter().map(|s| (*s).to_owned()).collect()
    }
    fn groups(xs: &[(&str, bool)]) -> BTreeMap<String, bool> {
        xs.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect()
    }

    #[test]
    fn app_state_delta_has_a_stable_order() {
        // root properties; the source order of fields can't vary here, the
        // serialized deltas are compared as upstream does
        let linear = Some(SelectedLinearElement {
            element_id: "id1".into(),
            is_editing: false,
        });
        let a = AppStateDelta::calculate(
            &observed(|o| o.name = Some("".into())),
            &observed(|o| {
                o.name = Some("untitled scene".into());
                o.selected_linear_element = linear.clone();
            }),
        );
        let b = AppStateDelta::calculate(
            &observed(|o| o.name = Some("".into())),
            &observed(|o| {
                o.selected_linear_element = linear.clone();
                o.name = Some("untitled scene".into());
            }),
        );
        assert_eq!(
            serde_json::to_string(&a.delta.inserted).unwrap(),
            serde_json::to_string(&b.delta.inserted).unwrap()
        );
        assert_eq!(
            a.delta.inserted.keys().collect::<Vec<_>>(),
            ["name", "selectedLinearElement"]
        );
        // selectedElementIds
        let a = AppStateDelta::calculate(
            &observed(|o| o.selected_element_ids = ids(&["id5", "id2", "id4"])),
            &observed(|o| o.selected_element_ids = ids(&["id1", "id2", "id3"])),
        );
        let b = AppStateDelta::calculate(
            &observed(|o| o.selected_element_ids = ids(&["id4", "id2", "id5"])),
            &observed(|o| o.selected_element_ids = ids(&["id3", "id2", "id1"])),
        );
        assert_eq!(a, b);
        assert_eq!(
            a.delta,
            d(
                json!({"selectedElementIds": {"id4": true, "id5": true}}),
                json!({"selectedElementIds": {"id1": true, "id3": true}})
            )
        );
        // selectedGroupIds
        let a = AppStateDelta::calculate(
            &observed(|o| {
                o.selected_group_ids =
                    groups(&[("id5", false), ("id2", true), ("id4", true), ("id0", true)])
            }),
            &observed(|o| {
                o.selected_group_ids =
                    groups(&[("id0", true), ("id1", true), ("id2", false), ("id3", true)])
            }),
        );
        let b = AppStateDelta::calculate(
            &observed(|o| {
                o.selected_group_ids =
                    groups(&[("id0", true), ("id4", true), ("id2", true), ("id5", false)])
            }),
            &observed(|o| {
                o.selected_group_ids =
                    groups(&[("id3", true), ("id2", false), ("id1", true), ("id0", true)])
            }),
        );
        assert_eq!(
            serde_json::to_string(&a.delta.deleted).unwrap(),
            serde_json::to_string(&b.delta.deleted).unwrap()
        );
        assert_eq!(a, b);
    }

    #[test]
    fn app_state_squash_with_an_empty_delta() {
        let delta = d(
            json!({"name": "untitled scene"}),
            json!({"name": "titled scene"}),
        );
        let mut a = AppStateDelta::new(delta.clone());
        a.squash(&AppStateDelta::empty());
        assert!(!a.is_empty());
        assert_eq!(a.delta, delta);
    }

    #[test]
    fn app_state_squash_exclusive_properties() {
        let mut a = AppStateDelta::new(d(
            json!({"name": "untitled scene"}),
            json!({"name": "titled scene"}),
        ));
        a.squash(&AppStateDelta::new(d(
            json!({"viewBackgroundColor": "#ffffff"}),
            json!({"viewBackgroundColor": "#000000"}),
        )));
        assert_eq!(
            a.delta,
            d(
                json!({"name": "untitled scene", "viewBackgroundColor": "#ffffff"}),
                json!({"name": "titled scene", "viewBackgroundColor": "#000000"})
            )
        );
    }

    #[test]
    fn app_state_squash_selection_maps() {
        let mut a = AppStateDelta::new(d(
            json!({"name": "untitled scene", "selectedElementIds": {"id1": true}, "selectedGroupIds": {}, "lockedMultiSelections": {"g1": true}}),
            json!({"name": "titled scene", "selectedElementIds": {"id2": true}, "selectedGroupIds": {"g1": true}, "lockedMultiSelections": {}}),
        ));
        a.squash(&AppStateDelta::new(d(
            json!({"selectedElementIds": {"id3": true}, "selectedGroupIds": {"g1": true}, "lockedMultiSelections": {}}),
            json!({"selectedElementIds": {"id2": true}, "selectedGroupIds": {"g2": true, "g3": true}, "lockedMultiSelections": {"g3": true}}))));
        assert_eq!(
            a.delta,
            d(
                json!({"name": "untitled scene", "selectedElementIds": {"id1": true, "id3": true}, "selectedGroupIds": {"g1": true}, "lockedMultiSelections": {"g1": true}}),
                json!({"name": "titled scene", "selectedElementIds": {"id2": true}, "selectedGroupIds": {"g1": true, "g2": true, "g3": true}, "lockedMultiSelections": {"g3": true}})
            )
        );
    }

    // -----------------------------------------------------------------------
    // history.test.tsx, through a small editor
    // -----------------------------------------------------------------------

    const RED: &str = "#ffc9c9";
    const BLUE: &str = "#a5d8ff";
    const YELLOW: &str = "#ffec99";
    const VIOLET: &str = "#eebefa";
    const TRANSPARENT: &str = "transparent";

    /// Scene, app state, store and history, committing the way `App` does.
    struct Ed {
        scene: Scene,
        app: AppState,
        store: Store,
        history: History,
    }

    impl Ed {
        fn new() -> Ed {
            setup();
            Ed {
                scene: Scene::default(),
                app: AppState::default(),
                store: Store::new(),
                history: History::new(),
            }
        }
        fn commit(&mut self, action: Option<CaptureUpdateAction>) {
            if let Some(a) = action {
                self.store.schedule_action(a);
            }
            let incs = self.store.commit(
                Some(self.scene.elements_including_deleted()),
                Some(&self.app),
            );
            self.history.record_increments(&incs);
        }
        /// `API.updateScene`.
        fn update(
            &mut self,
            elements: Option<Vec<Element>>,
            app: impl FnOnce(&mut AppState),
            action: Option<CaptureUpdateAction>,
        ) {
            if let Some(e) = elements {
                self.scene.replace_all_elements(e);
            }
            app(&mut self.app);
            self.commit(action);
        }
        fn remote(&mut self, elements: Vec<Element>) {
            self.update(Some(elements), |_| {}, Some(CaptureUpdateAction::Never));
        }
        fn capture(&mut self, f: impl FnOnce(&mut Ed)) {
            f(self);
            self.commit(Some(CaptureUpdateAction::Immediately));
        }
        /// `API.setElements` (not captured until the next capture).
        fn set_elements(&mut self, elements: Vec<Element>) {
            self.update(Some(elements), |_| {}, None);
        }
        /// `UI.createElement`: added on top and selected, one entry.
        fn create(&mut self, mut e: Element) -> String {
            e.index = None;
            let id = e.id.clone();
            self.capture(|ed| {
                ed.scene.insert_element(e);
                ed.app.selected_element_ids = ids(&[&id]);
                ed.app.selected_group_ids.clear();
            });
            id
        }
        fn rect(&mut self, x: f64, y: f64) -> String {
            self.create(new_element(
                ElementType::Rectangle,
                ElementOpts {
                    x,
                    y,
                    width: 10.,
                    height: 10.,
                    ..Default::default()
                },
            ))
        }
        /// A click (or shift-click) selecting exactly these.
        fn select(&mut self, sel: &[&str]) {
            let s = ids(sel);
            self.capture(|ed| {
                ed.app.selected_element_ids = s;
                ed.app.selected_group_ids.clear();
            });
        }
        fn click_empty(&mut self) {
            self.capture(|ed| {
                ed.app.selected_element_ids.clear();
                ed.app.selected_group_ids.clear();
                ed.app.editing_group_id = None;
            });
        }
        fn mutate(&mut self, id: &str, f: impl FnOnce(&mut Element)) {
            self.capture(|ed| {
                ed.scene.mutate_element(id, true, f);
            });
        }
        /// `actionDeleteSelected` for plain shapes and arrows: deleted,
        /// unbound from what they were bound to, selection cleared.
        fn delete_selected(&mut self) {
            let sel: Vec<String> = self.app.selected_element_ids.iter().cloned().collect();
            self.capture(|ed| {
                for id in &sel {
                    ed.scene.mutate_element(id, true, |e| e.is_deleted = true);
                    let others: Vec<String> = ed
                        .scene
                        .elements_including_deleted()
                        .iter()
                        .map(|e| e.id.clone())
                        .collect();
                    for o in others {
                        ed.scene.mutate_element(&o, true, |e| {
                            if let Some(b) = &mut e.bound_elements {
                                b.retain(|b| b.id != *id);
                            }
                        });
                    }
                }
                ed.app.selected_element_ids.clear();
            });
        }
        fn step(&mut self, undo: bool) {
            let r = if undo {
                self.history.undo(
                    &mut self.store,
                    self.scene.elements_including_deleted(),
                    &self.app,
                    &mut NoHooks,
                )
            } else {
                self.history.redo(
                    &mut self.store,
                    self.scene.elements_including_deleted(),
                    &self.app,
                    &mut NoHooks,
                )
            };
            match r {
                Some((els, app)) => {
                    self.scene.replace_all_elements(els);
                    self.app = app;
                    self.commit(Some(CaptureUpdateAction::Never));
                }
                None => self.commit(Some(CaptureUpdateAction::Eventually)),
            }
        }
        fn undo(&mut self) {
            self.step(true)
        }
        fn redo(&mut self) {
            self.step(false)
        }
        fn stacks(&self) -> (usize, usize) {
            (self.history.undo_stack.len(), self.history.redo_stack.len())
        }
        fn els(&self) -> &[Element] {
            self.scene.elements_including_deleted()
        }
        fn get(&self, id: &str) -> &Element {
            self.scene.get_element(id).unwrap()
        }
        fn order(&self) -> Vec<&str> {
            self.els().iter().map(|e| e.id.as_str()).collect()
        }
        fn deleted(&self) -> Vec<bool> {
            self.els().iter().map(|e| e.is_deleted).collect()
        }
        fn selected(&self) -> Vec<&str> {
            self.app
                .selected_element_ids
                .iter()
                .map(String::as_str)
                .collect()
        }
        fn assert_selected(&self, expected: &[&str]) {
            let mut e = expected.to_vec();
            e.sort();
            assert_eq!(self.selected(), e);
        }
        fn bg(&self, id: &str) -> &str {
            &self.get(id).background_color
        }
        /// Puts the elements in `order` (all ids), regenerating the indices
        /// of `moved` (`actionSendBackward`, `actionBringForward`, …).
        fn reorder(&mut self, order: &[&str], moved: &[&str]) {
            let mut v: Vec<Element> = order.iter().map(|id| self.get(id).clone()).collect();
            sync_moved_indices(&mut v, &moved.iter().map(|s| (*s).to_owned()).collect());
            self.capture(|ed| ed.scene.replace_all_elements(v));
        }
    }

    fn api_rect(f: impl FnOnce(&mut ElementOpts)) -> Element {
        let mut o = ElementOpts {
            width: 100.,
            height: 100.,
            ..Default::default()
        };
        f(&mut o);
        new_element(ElementType::Rectangle, o)
    }

    #[test]
    fn no_history_entry_without_appstate_changes() {
        let mut ed = Ed::new();
        let r1 = api_rect(|o| o.group_ids = vec!["A".into()]);
        let r2 = api_rect(|o| o.group_ids = vec!["A".into()]);
        ed.set_elements(vec![r1.clone(), r2.clone()]);
        let select_group = |ed: &mut Ed| {
            ed.capture(|ed| {
                ed.app.selected_element_ids = ids(&[&r1.id, &r2.id]);
                ed.app.selected_group_ids = groups(&[("A", true)]);
            })
        };
        select_group(&mut ed);
        assert_eq!(ed.stacks(), (1, 0));
        select_group(&mut ed);
        assert_eq!(ed.stacks(), (1, 0));
    }

    #[test]
    fn no_history_entry_without_element_changes() {
        let mut ed = Ed::new();
        let (r1, r2) = (api_rect(|_| {}), api_rect(|_| {}));
        ed.update(
            Some(vec![r1.clone(), r2.clone()]),
            |_| {},
            Some(CaptureUpdateAction::Immediately),
        );
        assert_eq!(ed.stacks(), (1, 0));
        let same = ed.els().to_vec();
        ed.update(Some(same), |_| {}, Some(CaptureUpdateAction::Immediately));
        assert_eq!(ed.stacks(), (1, 0));
        assert_eq!(ed.deleted(), [false, false]);
    }

    #[test]
    fn unrelated_appstate_change_modifies_nothing() {
        let mut ed = Ed::new();
        let r = api_rect(|_| {});
        ed.update(
            Some(vec![r.clone()]),
            |_| {},
            Some(CaptureUpdateAction::Never),
        );
        ed.update(None, |a| a.zoom = 2., Some(CaptureUpdateAction::Never));
        assert_eq!(ed.stacks(), (0, 0));
        assert!(!ed.store.snapshot.elements.get(&r.id).unwrap().is_deleted);
    }

    #[test]
    fn standalone_appstate_change_keeps_the_redo_stack() {
        let mut ed = Ed::new();
        let r1 = ed.rect(10., 0.);
        let r2 = ed.rect(20., 0.);
        assert_eq!(ed.stacks(), (2, 0));
        ed.assert_selected(&[&r2]);
        ed.undo();
        assert_eq!(ed.stacks(), (1, 1));
        ed.assert_selected(&[&r1]);
        assert_eq!(ed.deleted(), [false, true]);
        ed.click_empty();
        assert_eq!(ed.stacks(), (2, 1));
        ed.select(&[&r1]);
        assert_eq!(ed.stacks(), (3, 1));
        ed.redo();
        assert_eq!(ed.stacks(), (4, 0));
        ed.assert_selected(&[&r2]);
        assert_eq!(ed.deleted(), [false, false]);
    }

    #[test]
    fn appstate_changes_are_not_overridden_while_the_redo_stack_stays() {
        let mut ed = Ed::new();
        let r = ed.rect(10., 0.);
        ed.mutate(&r, |e| e.background_color = RED.into());
        ed.mutate(&r, |e| e.background_color = BLUE.into());
        assert_eq!(ed.stacks(), (3, 0));
        ed.undo();
        assert_eq!((ed.stacks(), ed.bg(&r)), ((2, 1), RED));
        ed.undo();
        assert_eq!((ed.stacks(), ed.bg(&r)), ((1, 2), TRANSPARENT));
        ed.assert_selected(&[&r]);
        ed.click_empty();
        assert_eq!(ed.stacks(), (2, 2));
        ed.redo();
        assert_eq!((ed.stacks(), ed.bg(&r)), ((3, 1), RED));
        ed.assert_selected(&[]);
        ed.redo();
        assert_eq!((ed.stacks(), ed.bg(&r)), ((4, 0), BLUE));
        ed.assert_selected(&[]);
        ed.undo();
        assert_eq!((ed.stacks(), ed.bg(&r)), ((3, 1), RED));
        ed.undo();
        assert_eq!((ed.stacks(), ed.bg(&r)), ((2, 2), TRANSPARENT));
        ed.assert_selected(&[]);
        ed.undo();
        assert_eq!((ed.stacks(), ed.bg(&r)), ((1, 3), TRANSPARENT));
        ed.assert_selected(&[&r]);
    }

    #[test]
    fn element_change_clears_the_redo_stack() {
        let mut ed = Ed::new();
        let r1 = ed.rect(10., 0.);
        ed.undo();
        assert_eq!(ed.stacks(), (0, 1));
        ed.assert_selected(&[]);
        let r2 = ed.rect(20., 0.);
        ed.assert_selected(&[&r2]);
        assert_eq!(ed.stacks(), (1, 0));
        let snap: Vec<(String, bool)> = ed
            .store
            .snapshot
            .elements
            .iter()
            .map(|e| (e.id.clone(), e.is_deleted))
            .collect();
        assert_eq!(snap, [(r1, true), (r2, false)]);
    }

    #[test]
    fn iterates_through_invisible_selection_changes() {
        let mut ed = Ed::new();
        let r = ed.rect(10., 0.);
        ed.click_empty();
        assert_eq!(ed.stacks(), (2, 0));
        ed.undo();
        assert_eq!(ed.stacks(), (1, 1));
        ed.assert_selected(&[&r]);
        ed.click_empty();
        assert_eq!(ed.stacks(), (2, 1));
        ed.undo();
        assert_eq!(ed.stacks(), (1, 2));
        ed.assert_selected(&[&r]);
        ed.redo();
        assert_eq!(ed.stacks(), (2, 1));
        ed.assert_selected(&[]);
        ed.redo(); // acceptable empty redo
        assert_eq!(ed.stacks(), (3, 0));
        ed.undo();
        assert_eq!(ed.stacks(), (2, 1));
        ed.assert_selected(&[&r]);
        ed.undo();
        assert_eq!(ed.stacks(), (0, 3));
        ed.assert_selected(&[]);
        assert_eq!(ed.deleted(), [true]);
    }

    #[test]
    fn no_history_entry_after_initializing_the_scene() {
        let mut ed = Ed::new();
        ed.update(
            Some(vec![api_rect(|o| o.id = Some("A".into()))]),
            |_| {},
            Some(CaptureUpdateAction::Never),
        );
        assert!(ed.history.is_undo_stack_empty());
        ed.undo(); // noop
        assert_eq!(ed.deleted(), [false]);
        let r = ed.rect(0., 0.);
        assert_eq!(ed.order(), ["A", r.as_str()]);
        ed.undo();
        assert_eq!(ed.deleted(), [false, true]);
        ed.undo(); // noop
        assert_eq!(ed.deleted(), [false, true]);
        assert_eq!(ed.stacks().0, 0);
        ed.redo();
        assert_eq!(ed.deleted(), [false, false]);
        assert_eq!(ed.stacks().0, 1);
    }

    #[test]
    fn supports_name_and_background_changes() {
        let mut ed = Ed::new();
        ed.update(
            None,
            |a| {
                a.name = Some("Old name".into());
                a.view_background_color = "#FFF".into();
            },
            Some(CaptureUpdateAction::Never),
        );
        ed.update(
            None,
            |a| a.name = Some("New name".into()),
            Some(CaptureUpdateAction::Immediately),
        );
        assert_eq!(ed.stacks(), (1, 0));
        ed.update(
            None,
            |a| a.view_background_color = "#000".into(),
            Some(CaptureUpdateAction::Immediately),
        );
        assert_eq!(ed.stacks(), (2, 0));
        // the same change isn't recorded twice
        ed.update(
            None,
            |a| {
                a.name = Some("New name".into());
                a.view_background_color = "#000".into();
            },
            Some(CaptureUpdateAction::Immediately),
        );
        assert_eq!(ed.stacks(), (2, 0));
        let st = |ed: &Ed| {
            (
                ed.stacks(),
                ed.app.name.clone().unwrap(),
                ed.app.view_background_color.clone(),
            )
        };
        ed.undo();
        assert_eq!(st(&ed), ((1, 1), "New name".into(), "#FFF".into()));
        ed.undo();
        assert_eq!(st(&ed), ((0, 2), "Old name".into(), "#FFF".into()));
        ed.redo();
        assert_eq!(st(&ed), ((1, 1), "New name".into(), "#FFF".into()));
        ed.redo();
        assert_eq!(st(&ed), ((2, 0), "New name".into(), "#000".into()));
    }

    #[test]
    fn supports_creation_deletion_and_selection() {
        let mut ed = Ed::new();
        let r1 = ed.rect(10., 0.);
        let r2 = ed.rect(20., 20.);
        let r3 = ed.rect(40., 40.);
        ed.select(&[&r2]);
        ed.select(&[&r2, &r3]);
        ed.delete_selected();
        assert_eq!(ed.stacks().0, 6);
        ed.undo();
        ed.assert_selected(&[&r2, &r3]);
        assert_eq!(ed.deleted(), [false, false, false]);
        ed.undo();
        ed.assert_selected(&[&r2]);
        ed.undo();
        ed.assert_selected(&[&r3]);
        ed.undo();
        ed.assert_selected(&[&r2]);
        assert_eq!(ed.deleted(), [false, false, true]);
        ed.undo();
        ed.assert_selected(&[&r1]);
        assert_eq!(ed.deleted(), [false, true, true]);
        ed.undo();
        ed.assert_selected(&[]);
        assert_eq!(ed.deleted(), [true, true, true]);
        ed.undo(); // noop
        assert_eq!(ed.deleted(), [true, true, true]);
        ed.redo();
        ed.assert_selected(&[&r1]);
        assert_eq!(ed.deleted(), [false, true, true]);
        ed.redo();
        ed.assert_selected(&[&r2]);
        ed.redo();
        ed.assert_selected(&[&r3]);
        ed.redo();
        ed.assert_selected(&[&r2]);
        ed.redo();
        ed.assert_selected(&[&r2, &r3]);
        assert_eq!(ed.deleted(), [false, false, false]);
        ed.redo();
        assert_eq!(ed.stacks(), (6, 0));
        ed.assert_selected(&[]);
        assert_eq!(ed.deleted(), [false, true, true]);
        ed.redo(); // noop
        assert_eq!(ed.stacks(), (6, 0));
    }

    #[test]
    fn supports_changes_in_element_order() {
        let mut ed = Ed::new();
        let r1 = ed.rect(10., 0.);
        let r2 = ed.rect(20., 20.);
        let r3 = ed.rect(40., 40.);
        ed.reorder(&[&r1, &r3, &r2], &[&r3]); // send backward
        assert_eq!(ed.stacks(), (4, 0));
        ed.assert_selected(&[&r3]);
        ed.undo();
        assert_eq!(ed.stacks(), (3, 1));
        ed.assert_selected(&[&r3]);
        assert_eq!(ed.order(), [&r1, &r2, &r3]);
        ed.redo();
        assert_eq!(ed.stacks(), (4, 0));
        ed.assert_selected(&[&r3]);
        assert_eq!(ed.order(), [&r1, &r3, &r2]);
        ed.select(&[&r1]);
        ed.select(&[&r1, &r3]);
        assert_eq!(ed.stacks(), (6, 0));
        ed.reorder(&[&r2, &r1, &r3], &[&r1, &r3]); // bring forward
        assert_eq!(ed.stacks(), (7, 0));
        ed.undo();
        assert_eq!(ed.stacks(), (6, 1));
        ed.assert_selected(&[&r1, &r3]);
        assert_eq!(ed.order(), [&r1, &r3, &r2]);
        ed.redo();
        assert_eq!(ed.stacks(), (7, 0));
        ed.assert_selected(&[&r1, &r3]);
        assert_eq!(ed.order(), [&r2, &r1, &r3]);
    }

    /// The bidirectional bindings scene: rect1 with a label and an arrow to
    /// rect2, built in five captures as upstream's UI steps make it.
    fn binding_scene() -> (Ed, [String; 4]) {
        let mut ed = Ed::new();
        let rect1 = api_rect(|o| {
            o.x = -100.;
            o.y = -50.;
        });
        let text = text_el(
            &lattice_board_core::board::random::random_id(),
            "a0",
            None,
            "ola",
        );
        let rect2 = api_rect(|o| {
            o.x = 100.;
            o.y = -50.;
        });
        let (r1, t, r2) = (rect1.id.clone(), text.id.clone(), rect2.id.clone());
        ed.update(
            Some(vec![rect1, text, rect2]),
            |_| {},
            Some(CaptureUpdateAction::Immediately),
        );
        ed.select(&[&r1]);
        ed.select(&[&r1, &t]);
        // bind text to the container
        ed.capture(|ed| {
            ed.scene.mutate_element(&t, true, |e| {
                e.text_mut().unwrap().container_id = Some(r1.clone())
            });
            ed.scene.mutate_element(&r1, true, |e| {
                e.bound_elements = bound(&[(&t, BoundType::Text)])
            });
            ed.app.selected_element_ids = ids(&[&r1]);
        });
        assert_eq!(ed.stacks().0, 4);
        let mut arrow = new_arrow_element(
            ElementOpts {
                x: 3.,
                y: 0.,
                ..Default::default()
            },
            vec![[0., 0.], [44., 0.]],
            None,
            Some(Arrowhead::Arrow),
            false,
            None,
        );
        arrow.linear_mut().unwrap().start_binding = binding(&r1, [1., 0.5001]);
        arrow.linear_mut().unwrap().end_binding = binding(&r2, [0.5001, 0.5001]);
        let a = arrow.id.clone();
        ed.capture(|ed| {
            ed.scene.insert_element(arrow);
            ed.scene.mutate_element(&r1, true, |e| {
                e.bound_elements = bound(&[(&t, BoundType::Text), (&a, BoundType::Arrow)])
            });
            ed.scene.mutate_element(&r2, true, |e| {
                e.bound_elements = bound(&[(&a, BoundType::Arrow)])
            });
            ed.app.selected_element_ids = ids(&[&a]);
        });
        assert_eq!(ed.stacks().0, 5);
        (ed, [r1, t, r2, a])
    }

    fn assert_arrow_bound(ed: &Ed, a: &str, r1: &str, r2: &str) {
        let l = ed.get(a).linear().unwrap();
        assert_eq!(l.start_binding.as_ref().unwrap().element_id, r1);
        assert_eq!(l.end_binding.as_ref().unwrap().element_id, r2);
    }

    #[test]
    fn bindings_unbind_arrow_on_undo_and_rebind_on_redo() {
        let (mut ed, [r1, t, r2, a]) = binding_scene();
        ed.undo();
        assert_eq!(ed.stacks(), (4, 1));
        assert_arrow_bound(&ed, &a, &r1, &r2);
        assert_eq!(ed.get(&r1).bound_elements, bound(&[(&t, BoundType::Text)]));
        assert_eq!(ed.get(&r2).bound_elements, Some(vec![]));
        assert!(ed.get(&a).is_deleted);
        ed.redo();
        assert_eq!(ed.stacks(), (5, 0));
        assert_arrow_bound(&ed, &a, &r1, &r2);
        assert_eq!(
            ed.get(&r1).bound_elements,
            bound(&[(&t, BoundType::Text), (&a, BoundType::Arrow)])
        );
        assert_eq!(ed.get(&r2).bound_elements, bound(&[(&a, BoundType::Arrow)]));
        assert!(!ed.get(&a).is_deleted);
    }

    #[test]
    fn bindings_unbind_arrow_on_deletion_and_rebind_on_undo() {
        let (mut ed, [r1, t, r2, a]) = binding_scene();
        ed.delete_selected();
        assert_eq!(ed.stacks(), (6, 0));
        assert_arrow_bound(&ed, &a, &r1, &r2);
        assert_eq!(ed.get(&r1).bound_elements, bound(&[(&t, BoundType::Text)]));
        assert_eq!(ed.get(&r2).bound_elements, Some(vec![]));
        assert!(ed.get(&a).is_deleted);
        ed.undo();
        assert_eq!(ed.stacks(), (5, 1));
        assert_arrow_bound(&ed, &a, &r1, &r2);
        assert_eq!(
            ed.get(&r1).bound_elements,
            bound(&[(&t, BoundType::Text), (&a, BoundType::Arrow)])
        );
        assert_eq!(ed.get(&r2).bound_elements, bound(&[(&a, BoundType::Arrow)]));
        assert!(!ed.get(&a).is_deleted);
    }

    #[test]
    fn bindings_unbind_everything_through_the_whole_stack_and_rebind_on_redo() {
        let (mut ed, [r1, t, r2, a]) = binding_scene();
        for _ in 0..5 {
            ed.undo();
        }
        assert_eq!(ed.stacks(), (0, 5));
        assert_eq!(
            (ed.get(&r1).bound_elements.clone(), ed.get(&r1).is_deleted),
            (Some(vec![]), true)
        );
        assert_eq!(
            (ed.get(&t).container_id(), ed.get(&t).is_deleted),
            (None, true)
        );
        assert_eq!(
            (ed.get(&r2).bound_elements.clone(), ed.get(&r2).is_deleted),
            (Some(vec![]), true)
        );
        assert_arrow_bound(&ed, &a, &r1, &r2);
        assert!(ed.get(&a).is_deleted);
        for _ in 0..5 {
            ed.redo();
        }
        assert_eq!(ed.stacks(), (5, 0));
        let b1: BTreeSet<String> = ed
            .get(&r1)
            .bound_elements
            .iter()
            .flatten()
            .map(|b| b.id.clone())
            .collect();
        assert_eq!(b1, ids(&[&t, &a]));
        assert!(!ed.get(&r1).is_deleted);
        assert_eq!(
            (ed.get(&t).container_id(), ed.get(&t).is_deleted),
            (Some(r1.as_str()), false)
        );
        assert_eq!(
            (ed.get(&r2).bound_elements.clone(), ed.get(&r2).is_deleted),
            (bound(&[(&a, BoundType::Arrow)]), false)
        );
        assert_arrow_bound(&ed, &a, &r1, &r2);
        assert!(!ed.get(&a).is_deleted);
    }

    #[test]
    fn remote_changes_on_different_elements_are_kept() {
        let mut ed = Ed::new();
        let r = ed.rect(10., 0.);
        ed.mutate(&r, |e| e.background_color = RED.into());
        assert_eq!(ed.stacks().0, 2);
        let mut els = ed.els().to_vec();
        els.push(api_rect(|o| o.stroke_color = BLUE.into()));
        let other = els[1].id.clone();
        ed.remote(els);
        ed.undo();
        assert_eq!(
            (ed.bg(&r), ed.get(&other).stroke_color.as_str()),
            (TRANSPARENT, BLUE)
        );
        ed.redo();
        assert_eq!(
            (ed.bg(&r), ed.get(&other).stroke_color.as_str()),
            (RED, BLUE)
        );
        ed.undo();
        assert_eq!(ed.stacks().0, 1);
        assert_eq!(
            (ed.bg(&r), ed.get(&other).stroke_color.as_str()),
            (TRANSPARENT, BLUE)
        );
    }

    #[test]
    fn remote_changes_on_different_properties_are_kept() {
        let mut ed = Ed::new();
        let r = ed.rect(10., 0.);
        ed.mutate(&r, |e| e.background_color = RED.into());
        let e = with(ed.get(&r), |e| e.stroke_color = YELLOW.into());
        ed.remote(vec![e]);
        ed.undo();
        assert_eq!(
            (ed.bg(&r), ed.get(&r).stroke_color.as_str()),
            (TRANSPARENT, YELLOW)
        );
        ed.redo();
        assert_eq!((ed.bg(&r), ed.get(&r).stroke_color.as_str()), (RED, YELLOW));
    }

    #[test]
    fn history_entries_follow_remote_changes_on_the_same_properties() {
        let mut ed = Ed::new();
        let r = ed.rect(10., 0.);
        ed.mutate(&r, |e| e.background_color = RED.into());
        ed.mutate(&r, |e| e.background_color = BLUE.into());
        assert_eq!(ed.stacks().0, 3);
        ed.undo();
        assert_eq!(ed.bg(&r), RED);
        ed.redo();
        assert_eq!(ed.bg(&r), BLUE);
        let e = with(ed.get(&r), |e| e.background_color = YELLOW.into());
        ed.remote(vec![e]);
        // red -> blue became red -> yellow
        ed.undo();
        assert_eq!(ed.bg(&r), RED);
        let e = with(ed.get(&r), |e| e.background_color = VIOLET.into());
        ed.remote(vec![e]);
        // the inverse red -> yellow became violet -> yellow
        ed.redo();
        assert_eq!(ed.bg(&r), YELLOW);
        ed.undo();
        assert_eq!(ed.bg(&r), VIOLET);
        ed.undo();
        assert_eq!(ed.bg(&r), TRANSPARENT);
    }

    #[test]
    fn remotely_added_groups_are_overridden_on_undo_and_restored_on_redo() {
        let mut ed = Ed::new();
        let (r1, r2) = (api_rect(|_| {}), api_rect(|_| {}));
        ed.update(
            Some(vec![r1.clone(), r2.clone()]),
            |_| {},
            Some(CaptureUpdateAction::Never),
        );
        let els: Vec<Element> = ed
            .els()
            .iter()
            .map(|e| with(e, |e| e.group_ids = vec!["A".into()]))
            .collect();
        ed.update(Some(els), |_| {}, Some(CaptureUpdateAction::Immediately));
        let r3 = api_rect(|o| o.group_ids = vec!["B".into()]);
        let r4 = api_rect(|o| o.group_ids = vec!["B".into()]);
        let mut els: Vec<Element> = ed
            .els()
            .iter()
            .map(|e| with(e, |e| e.group_ids = vec!["A".into(), "B".into()]))
            .collect();
        els.extend([r3, r4]);
        ed.remote(els);
        let g = |ed: &Ed| {
            ed.els()
                .iter()
                .map(|e| e.group_ids.join(","))
                .collect::<Vec<_>>()
        };
        ed.undo();
        assert_eq!(ed.stacks(), (0, 1));
        assert_eq!(g(&ed), ["", "", "B", "B"]);
        ed.redo();
        assert_eq!(ed.stacks(), (1, 0));
        assert_eq!(g(&ed), ["A,B", "A,B", "B", "B"]);
    }

    #[test]
    fn remotely_added_points_are_overridden_on_undo_and_restored_on_redo() {
        let mut ed = Ed::new();
        let a = ed.create(arrow_el("arrow", "a0", 0., 0., vec![[0., 0.], [10., 10.]]));
        ed.mutate(&a, |e| e.linear_mut().unwrap().points.push([20., 20.]));
        let e = with(ed.get(&a), |e| {
            e.linear_mut().unwrap().points =
                vec![[0., 0.], [5., 5.], [10., 10.], [15., 15.], [20., 20.]]
        });
        ed.remote(vec![e]);
        let p = |ed: &Ed| ed.get(&a).points().unwrap().to_vec();
        ed.undo();
        assert_eq!(ed.stacks(), (1, 1));
        assert_eq!(p(&ed), [[0., 0.], [10., 10.]]);
        ed.undo();
        assert_eq!(ed.stacks(), (0, 2));
        assert!(ed.get(&a).is_deleted);
        assert_eq!(p(&ed), [[0., 0.], [10., 10.]]);
        ed.redo();
        assert_eq!(ed.stacks(), (1, 1));
        assert!(!ed.get(&a).is_deleted);
        assert_eq!(p(&ed), [[0., 0.], [10., 10.]]);
        ed.redo();
        assert_eq!(ed.stacks(), (2, 0));
        assert_eq!(
            p(&ed),
            [[0., 0.], [5., 5.], [10., 10.], [15., 15.], [20., 20.]]
        );
    }

    #[test]
    fn deltas_are_redistributed_when_a_locally_removed_element_is_restored_remotely() {
        let mut ed = Ed::new();
        let r = ed.rect(10., 0.);
        ed.delete_selected();
        assert_eq!(ed.stacks().0, 2);
        assert!(ed.get(&r).is_deleted);
        let e = with(ed.get(&r), |e| {
            e.background_color = YELLOW.into();
            e.is_deleted = false;
        });
        ed.remote(vec![e]);
        ed.assert_selected(&[]);
        ed.undo();
        ed.assert_selected(&[&r]);
        assert_eq!(ed.stacks(), (1, 1));
        assert_eq!((ed.bg(&r), ed.get(&r).is_deleted), (YELLOW, false));
        ed.undo();
        ed.assert_selected(&[]);
        assert_eq!(ed.stacks(), (0, 2));
        assert_eq!((ed.bg(&r), ed.get(&r).is_deleted), (YELLOW, true));
        ed.redo();
        ed.assert_selected(&[&r]);
        assert_eq!(ed.stacks(), (1, 1));
        assert_eq!((ed.bg(&r), ed.get(&r).is_deleted), (YELLOW, false));
        ed.redo();
        ed.assert_selected(&[]);
        assert_eq!(ed.stacks(), (2, 0));
        assert_eq!((ed.bg(&r), ed.get(&r).is_deleted), (YELLOW, false));
    }

    #[test]
    fn iterates_when_the_change_relates_to_a_remotely_deleted_element() {
        let mut ed = Ed::new();
        let r = ed.rect(10., 0.);
        ed.mutate(&r, |e| e.background_color = RED.into());
        let e = with(ed.get(&r), |e| {
            e.background_color = YELLOW.into();
            e.is_deleted = true;
        });
        ed.remote(vec![e]);
        ed.undo();
        assert_eq!(ed.stacks(), (0, 2));
        assert_eq!((ed.bg(&r), ed.get(&r).is_deleted), (TRANSPARENT, true));
        ed.redo();
        ed.assert_selected(&[]);
        assert_eq!(ed.stacks(), (2, 0));
        assert_eq!((ed.bg(&r), ed.get(&r).is_deleted), (YELLOW, true));
    }

    #[test]
    fn iterates_when_changes_relate_only_to_remotely_deleted_elements() {
        let mut ed = Ed::new();
        let r1 = ed.rect(10., 0.);
        let r2 = ed.rect(20., 0.);
        ed.mutate(&r2, |e| e.background_color = RED.into());
        let r3 = ed.rect(30., 30.);
        ed.mutate(&r3, |e| {
            e.x = 50.;
            e.y = 50.;
        });
        assert_eq!(ed.stacks().0, 5);
        let els = vec![
            ed.els()[0].clone(),
            with(&ed.els()[1], |e| e.is_deleted = true),
            with(&ed.els()[2], |e| e.is_deleted = true),
        ];
        ed.remote(els);
        ed.undo();
        assert_eq!(ed.stacks(), (1, 4));
        ed.assert_selected(&[&r1]);
        assert_eq!(ed.deleted(), [false, true, true]);
        assert_eq!(
            (ed.bg(&r2), ed.get(&r3).x, ed.get(&r3).y),
            (TRANSPARENT, 30., 30.)
        );
        ed.redo();
        assert_eq!(ed.stacks(), (5, 0));
        ed.assert_selected(&[]);
        assert_eq!(ed.deleted(), [false, true, true]);
        assert_eq!((ed.bg(&r2), ed.get(&r3).x, ed.get(&r3).y), (RED, 50., 50.));
    }

    #[test]
    fn iterates_when_selected_elements_relate_only_to_remotely_deleted_elements() {
        let mut ed = Ed::new();
        let (r1, r2, r3) = (
            api_rect(|o| o.x = 10.),
            api_rect(|o| o.x = 20.),
            api_rect(|o| o.x = 30.),
        );
        let (i1, i2, i3) = (r1.id.clone(), r2.id.clone(), r3.id.clone());
        ed.set_elements(vec![r1, r2, r3]);
        ed.select(&[&i1]);
        ed.select(&[&i2]);
        ed.select(&[&i2, &i3]);
        assert_eq!(ed.stacks().0, 3);
        let set_deleted = |ed: &mut Ed, deleted: bool| {
            let els = vec![
                ed.els()[0].clone(),
                with(&ed.els()[1], |e| e.is_deleted = deleted),
                with(&ed.els()[2], |e| e.is_deleted = deleted),
            ];
            ed.remote(els);
        };
        set_deleted(&mut ed, true);
        ed.undo();
        assert_eq!(ed.stacks(), (1, 2));
        ed.assert_selected(&[&i1]);
        ed.redo();
        assert_eq!(ed.stacks(), (3, 0));
        ed.assert_selected(&[]);
        assert_eq!(ed.deleted(), [false, true, true]);
        ed.undo();
        assert_eq!(ed.stacks(), (1, 2));
        ed.assert_selected(&[&i1]);
        set_deleted(&mut ed, false);
        ed.redo();
        assert_eq!(ed.stacks(), (2, 1));
        ed.assert_selected(&[&i2]);
        ed.redo();
        assert_eq!(ed.stacks(), (3, 0));
        ed.assert_selected(&[&i2, &i3]);
        assert_eq!(ed.deleted(), [false, false, false]);
    }

    #[test]
    fn iterates_when_selected_groups_contain_only_remotely_deleted_elements() {
        let mut ed = Ed::new();
        let r1 = api_rect(|o| o.group_ids = vec!["A".into()]);
        let r2 = api_rect(|o| o.group_ids = vec!["A".into()]);
        let r3 = api_rect(|o| o.group_ids = vec!["B".into()]);
        let r4 = api_rect(|o| o.group_ids = vec!["B".into()]);
        ed.remote(vec![r1, r2]);
        let select_all = |ed: &mut Ed| {
            ed.capture(|ed| {
                ed.app.selected_element_ids = ed
                    .scene
                    .non_deleted_elements()
                    .map(|e| e.id.clone())
                    .collect();
                ed.app.selected_group_ids = ed
                    .scene
                    .non_deleted_elements()
                    .flat_map(|e| e.group_ids.clone())
                    .map(|g| (g, true))
                    .collect();
            })
        };
        select_all(&mut ed);
        let els = vec![
            ed.els()[0].clone(),
            ed.els()[1].clone(),
            r3.clone(),
            r4.clone(),
        ];
        ed.remote(els);
        select_all(&mut ed);
        assert_eq!(ed.stacks(), (2, 0));
        assert_eq!(
            ed.app.selected_group_ids,
            groups(&[("A", true), ("B", true)])
        );
        let els = vec![
            with(&ed.els()[0], |e| e.is_deleted = true),
            with(&ed.els()[1], |e| e.is_deleted = true),
        ];
        ed.remote(els);
        ed.undo();
        assert_eq!(ed.stacks(), (0, 2)); // iterated two steps back
        assert_eq!(ed.app.selected_group_ids, groups(&[]));
        ed.redo();
        assert_eq!(ed.stacks(), (2, 0));
        assert_eq!(ed.app.selected_group_ids, groups(&[]));
        ed.undo();
        let els = vec![
            with(&ed.els()[0], |e| e.is_deleted = false),
            with(&ed.els()[1], |e| e.is_deleted = false),
        ];
        ed.remote(els);
        ed.redo();
        assert_eq!(ed.stacks(), (1, 1));
        assert_eq!(ed.app.selected_group_ids, groups(&[("A", true)]));
        let els = vec![ed.els()[0].clone(), ed.els()[1].clone(), r3, r4];
        ed.remote(els);
        ed.redo();
        assert_eq!(ed.stacks(), (2, 0));
        assert_eq!(
            ed.app.selected_group_ids,
            groups(&[("A", true), ("B", true)])
        );
    }

    #[test]
    fn iterates_when_the_editing_group_contains_only_remotely_deleted_elements() {
        let mut ed = Ed::new();
        let r1 = api_rect(|o| {
            o.group_ids = vec!["A".into()];
            o.x = 0.;
        });
        let r2 = api_rect(|o| {
            o.group_ids = vec!["A".into()];
            o.x = 100.;
        });
        let (i1, i2) = (r1.id.clone(), r2.id.clone());
        ed.set_elements(vec![r1, r2]);
        ed.capture(|ed| {
            ed.app.selected_element_ids = ids(&[&i1, &i2]);
            ed.app.selected_group_ids = groups(&[("A", true)]);
        });
        // double click inside the group
        ed.capture(|ed| {
            ed.app.selected_element_ids = ids(&[&i2]);
            ed.app.selected_group_ids.clear();
            ed.app.editing_group_id = Some("A".into());
        });
        assert_eq!(ed.stacks(), (2, 0));
        ed.click_empty();
        assert_eq!(ed.stacks(), (3, 0));
        assert_eq!(ed.app.editing_group_id, None);
        let els = vec![
            with(&ed.els()[0], |e| e.is_deleted = true),
            with(&ed.els()[1], |e| e.is_deleted = true),
        ];
        ed.remote(els);
        ed.undo();
        assert_eq!(ed.stacks(), (0, 3));
        assert_eq!(ed.app.editing_group_id, None);
        ed.redo();
        assert_eq!(ed.stacks(), (3, 0));
        assert_eq!(ed.app.editing_group_id, None);
    }

    #[test]
    fn iterates_when_the_selected_linear_element_was_remotely_deleted() {
        let mut ed = Ed::new();
        let a = ed.create(arrow_el("arrow", "a0", 0., 0., vec![[0., 0.], [10., 10.]]));
        ed.capture(|ed| {
            ed.app.selected_linear_element = Some(SelectedLinearElement {
                element_id: a.clone(),
                is_editing: true,
            })
        });
        ed.capture(|ed| {
            ed.app.selected_linear_element = Some(SelectedLinearElement {
                element_id: a.clone(),
                is_editing: false,
            })
        });
        assert_eq!(ed.stacks(), (3, 0));
        let e = with(ed.get(&a), |e| e.is_deleted = true);
        ed.remote(vec![e]);
        ed.undo();
        assert_eq!(ed.stacks(), (0, 3));
        assert_eq!(ed.app.selected_linear_element, None);
        ed.redo();
        assert_eq!(ed.stacks(), (3, 0));
        assert_eq!(ed.app.selected_linear_element, None);
    }

    #[test]
    fn iterates_when_z_index_changes_are_invisible_after_synced_changed_indices() {
        let mut ed = Ed::new();
        let r1 = api_rect(|o| {
            o.x = 10.;
            o.index = Some("a0".into());
        });
        let r2 = api_rect(|o| {
            o.x = 20.;
            o.index = Some("a1".into());
        });
        let r3 = api_rect(|o| {
            o.x = 30.;
            o.index = Some("a2".into());
        });
        let (i1, i2, i3) = (r1.id.clone(), r2.id.clone(), r3.id.clone());
        ed.set_elements(vec![r1, r2, r3]);
        ed.select(&[&i2]);
        ed.reorder(&[&i2, &i1, &i3], &[&i2]); // send to back
        assert_eq!(ed.stacks(), (2, 0));
        assert_eq!(ed.order(), [&i2, &i1, &i3]);
        let els = vec![
            with(&ed.els()[2], |e| e.index = Some("Zy".into())),
            ed.els()[0].clone(),
            ed.els()[1].clone(),
        ];
        ed.remote(els);
        assert_eq!(ed.order(), [&i3, &i2, &i1]);
        ed.undo();
        assert_eq!(ed.stacks(), (1, 1));
        ed.assert_selected(&[&i2]);
        assert_eq!(ed.order(), [&i3, &i1, &i2]);
        ed.redo();
        assert_eq!(ed.stacks(), (2, 0));
        assert_eq!(ed.order(), [&i3, &i2, &i1]);
        let els = vec![
            with(&ed.els()[2], |e| e.index = Some("Zx".into())),
            ed.els()[0].clone(),
            ed.els()[1].clone(),
        ];
        ed.remote(els);
        assert_eq!(ed.order(), [&i1, &i3, &i2]);
        ed.undo();
        // two steps, as there was no change in order
        assert_eq!(ed.stacks(), (0, 2));
        ed.assert_selected(&[]);
        assert_eq!(ed.order(), [&i1, &i3, &i2]);
    }

    #[test]
    fn rebinds_remotely_added_bound_text_when_its_container_is_added_through_history() {
        let mut ed = Ed::new();
        let c = ed.rect(0., 0.);
        ed.undo();
        assert!(ed.get(&c).is_deleted);
        // remote: a label bound to the (deleted) container
        let mut els = ed.els().to_vec();
        els[0] = with(&els[0], |e| {
            e.bound_elements = bound(&[("label", BoundType::Text)])
        });
        els.push(text_el("label", "a5", Some(&c), "hi"));
        ed.remote(els);
        ed.redo();
        assert!(!ed.get(&c).is_deleted);
        assert_eq!(
            ed.get(&c).bound_elements,
            bound(&[("label", BoundType::Text)])
        );
        assert_eq!(ed.get("label").container_id(), Some(c.as_str()));
        ed.undo();
        assert!(ed.get(&c).is_deleted);
        // the label is unbound from the deleted container
        assert_eq!(ed.get("label").container_id(), None);
    }

    #[test]
    fn unbinds_remotely_deleted_bound_text_when_the_container_is_added_through_history() {
        let mut ed = Ed::new();
        let mut container = api_rect(|o| o.id = Some("container".into()));
        container.bound_elements = bound(&[("label", BoundType::Text)]);
        ed.update(
            Some(vec![
                container,
                text_el("label", "a1", Some("container"), "hi"),
            ]),
            |_| {},
            Some(CaptureUpdateAction::Never),
        );
        ed.select(&["container"]);
        ed.delete_selected();
        let els = vec![
            ed.els()[0].clone(),
            with(&ed.els()[1], |e| e.is_deleted = true),
        ];
        ed.remote(els);
        ed.undo();
        assert!(!ed.get("container").is_deleted);
        assert_eq!(ed.get("container").bound_elements, Some(vec![]));
        assert!(ed.get("label").is_deleted);
    }

    // -----------------------------------------------------------------------
    // viewport
    // -----------------------------------------------------------------------

    fn vp(zoom: f64) -> Viewport {
        Viewport {
            scroll_x: 0.,
            scroll_y: 0.,
            zoom,
        }
    }
    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn scrolls_bounds_into_view() {
        let (w, h) = (1000., 800.);
        assert_eq!(
            scroll_bounds_into_view(
                [100., 100., 200., 200.],
                vp(1.),
                w,
                h,
                None,
                TooLarge::AlignStart
            ),
            None
        );
        // 50px past the right edge, 30px above the top
        assert_eq!(
            scroll_bounds_into_view(
                [900., -30., 1050., 100.],
                vp(1.),
                w,
                h,
                None,
                TooLarge::AlignStart
            ),
            Some((-50., 30.))
        );
        // a 320px sidebar on the right
        let right = Some(Offsets {
            right: 320.,
            ..Default::default()
        });
        assert_eq!(
            scroll_bounds_into_view(
                [900., 100., 1000., 200.],
                vp(1.),
                w,
                h,
                right,
                TooLarge::AlignStart
            ),
            Some((-320., 0.))
        );
        // at 200%, [450, 550] is 100px past the edge on screen: 50 scene units
        assert_eq!(
            scroll_bounds_into_view(
                [450., 100., 550., 150.],
                vp(2.),
                w,
                h,
                None,
                TooLarge::AlignStart
            ),
            Some((-50., 0.))
        );
        // taller than the view
        assert_eq!(
            scroll_bounds_into_view(
                [100., 500., 200., 2000.],
                vp(1.),
                w,
                h,
                None,
                TooLarge::AlignStart
            ),
            Some((0., -500.))
        );
        assert_eq!(
            scroll_bounds_into_view(
                [100., 500., 200., 2000.],
                vp(1.),
                w,
                h,
                None,
                TooLarge::Leave
            ),
            None
        );
        let no_room = Some(Offsets {
            left: 600.,
            right: 600.,
            ..Default::default()
        });
        assert_eq!(
            scroll_bounds_into_view(
                [900., 0., 1100., 10.],
                vp(1.),
                w,
                h,
                no_room,
                TooLarge::AlignStart
            ),
            None
        );
    }

    #[test]
    fn zoom_about_a_point_keeps_it_fixed() {
        let c = Canvas {
            offset_left: 40.,
            offset_top: 30.,
            width: 1000.,
            height: 800.,
        };
        let v = Viewport {
            scroll_x: -123.5,
            scroll_y: 77.25,
            zoom: 1.3,
        };
        for (anchor, z) in [
            ([500., 400.], 2.),
            ([40., 30.], 0.1),
            ([1040., 830.], 30.),
            ([333., 111.], 0.7),
        ] {
            let before = viewport_coords_to_scene_coords(anchor, v, c);
            let next = get_viewport_for_zoom(anchor[0], anchor[1], z, v, c);
            assert_eq!(next.zoom, z);
            let after = viewport_coords_to_scene_coords(anchor, next, c);
            assert!(
                close(before[0], after[0]) && close(before[1], after[1]),
                "{before:?} {after:?}"
            );
        }
        // zoom in / out by a step about the canvas center
        let center = zoom_anchor(c);
        let s = viewport_coords_to_scene_coords(center, v, c);
        let z = zoom_in(v, c, None, None);
        assert!(close(z.zoom, 1.4));
        let s2 = viewport_coords_to_scene_coords(center, z, c);
        assert!(close(s[0], s2[0]) && close(s[1], s2[1]));
        assert!(close(zoom_out(v, c, None, None).zoom, 1.2));
        assert_eq!(reset_zoom(v, c, None, None).zoom, 1.);
        // clamped and rounded
        assert_eq!(
            zoom_in(Viewport { zoom: 30., ..v }, c, None, None).zoom,
            30.
        );
        assert_eq!(
            zoom_out(Viewport { zoom: 0.1, ..v }, c, None, None).zoom,
            0.1
        );
        assert_eq!(get_normalized_zoom(1.23456789), 1.234568);
    }

    #[test]
    fn coordinates_round_trip() {
        let c = Canvas {
            offset_left: 12.,
            offset_top: 34.,
            width: 800.,
            height: 600.,
        };
        let v = Viewport {
            scroll_x: 15.5,
            scroll_y: -40.,
            zoom: 2.5,
        };
        let scene = viewport_coords_to_scene_coords([112., 84.], v, c);
        assert_eq!(scene, [(112. - 12.) / 2.5 - 15.5, (84. - 34.) / 2.5 + 40.]);
        let back = scene_coords_to_viewport_coords(scene, v, c);
        assert!(close(back[0], 112.) && close(back[1], 84.));
        let p = [-321.25, 987.5];
        let q = viewport_coords_to_scene_coords(scene_coords_to_viewport_coords(p, v, c), v, c);
        assert!(close(p[0], q[0]) && close(p[1], q[1]));
    }

    #[test]
    fn zoom_to_fit_bounds_values() {
        let c = Canvas {
            offset_left: 0.,
            offset_top: 0.,
            width: 100.,
            height: 100.,
        };
        // fitToContent: keep the current zoom and only center the target
        let v = Viewport {
            scroll_x: 0.,
            scroll_y: 0.,
            zoom: 0.5,
        };
        let r = zoom_to_fit_bounds(
            [1000., 1000., 1050., 1050.],
            v,
            c,
            FitOpts {
                fit: Fit::None,
                ..Default::default()
            },
        );
        assert_eq!(r.zoom, 0.5);
        assert!(
            close(r.scroll_x, 100. / 2. / 0.5 - 1025.)
                && close(r.scroll_y, 100. / 2. / 0.5 - 1025.)
        );
        // scale-down: small content stays at 100%, large content shrinks
        let r = zoom_to_fit_bounds([0., 0., 50., 50.], vp(0.3), c, FitOpts::default());
        assert_eq!(r.zoom, 1.);
        let r = zoom_to_fit_bounds([0., 0., 400., 200.], vp(1.), c, FitOpts::default());
        assert_eq!(r.zoom, 0.25);
        // the center of the bounds ends up at the center of the canvas
        let center = scene_coords_to_viewport_coords([200., 100.], r, c);
        assert!(close(center[0], 50.) && close(center[1], 50.));
        // contain may zoom in; offsets shrink the room and shift the center
        let off = Offsets {
            left: 20.,
            ..Default::default()
        };
        let r = zoom_to_fit_bounds(
            [0., 0., 40., 20.],
            vp(1.),
            c,
            FitOpts {
                fit: Fit::Contain,
                offsets: Some(off),
                ..Default::default()
            },
        );
        assert_eq!(r.zoom, 2.);
        let center = scene_coords_to_viewport_coords([20., 10.], r, c);
        assert!(close(center[0], 60.) && close(center[1], 50.));
        // stepped zoom floors to ZOOM_STEP; tiny content clamps at MIN_ZOOM
        let r = zoom_to_fit_bounds(
            [0., 0., 300., 300.],
            vp(1.),
            c,
            FitOpts {
                stepped_zoom: true,
                ..Default::default()
            },
        );
        assert!(close(r.zoom, 0.3));
        let r = zoom_to_fit_bounds([0., 0., 1e6, 10.], vp(1.), c, FitOpts::default());
        assert_eq!(r.zoom, 0.1);
        assert!(!is_bounds_in_viewport([1e7, 0., 1e7 + 1., 1.], r, c));
        assert!(is_bounds_in_viewport([499_990., 0., 500_010., 10.], r, c));
        assert!(!is_bounds_in_viewport([0., 0., 10., 10.], r, c));
    }

    #[test]
    fn scroll_constraints_clamp() {
        let c = Canvas {
            width: 100.,
            height: 100.,
            ..Default::default()
        };
        let sc = ScrollConstraints {
            x: 0.,
            y: 0.,
            width: 1000.,
            height: 1000.,
            lock_scroll: true,
            lock_zoom: true,
            zoom: 0.5,
            offsets: None,
            overscroll: 0.,
        };
        // zoom floored at the lock, scroll kept inside the box
        let r = constrain_scroll_state(
            Viewport {
                scroll_x: 50.,
                scroll_y: -5000.,
                zoom: 0.2,
            },
            c,
            Some(&sc),
            0.,
        );
        assert_eq!(
            r,
            Viewport {
                scroll_x: 0.,
                scroll_y: 200. - 1000.,
                zoom: 0.5
            }
        );
        // a box smaller than the view rests centered
        let small = ScrollConstraints {
            width: 10.,
            height: 10.,
            lock_zoom: false,
            ..sc
        };
        let r = constrain_scroll_state(
            Viewport {
                scroll_x: 0.,
                scroll_y: 0.,
                zoom: 1.,
            },
            c,
            Some(&small),
            0.,
        );
        assert_eq!((r.scroll_x, r.scroll_y), (45., 45.));
        assert_eq!(scroll_constraints_bounds(&small), [0., 0., 10., 10.]);
        let free = Viewport {
            scroll_x: 3.,
            scroll_y: 4.,
            zoom: 0.2,
        };
        assert_eq!(constrain_scroll_state(free, c, None, 0.), free);
        let _ = partial(json!({}));
    }

    #[test]
    fn app_state_defaults_and_storage() {
        let a = AppState::default();
        assert_eq!(
            (a.active_tool.ty, a.zoom, a.grid_size, a.grid_step),
            (ToolType::Selection, 1., 20., 5.)
        );
        assert_eq!(a.current_item_end_arrowhead, Some(Arrowhead::Arrow));
        assert_eq!(a.current_item_stroke_width(false), 2.);
        assert_eq!(a.current_item_stroke_width(true), 1.);
        let exported: Vec<&str> = APP_STATE_STORAGE_CONF
            .iter()
            .filter(|(_, c)| c.export)
            .map(|(k, _)| *k)
            .collect();
        assert_eq!(
            exported,
            [
                "lockedMultiSelections",
                "gridSize",
                "gridStep",
                "gridModeEnabled",
                "viewBackgroundColor"
            ]
        );
        let mut history: Vec<&str> = APP_STATE_STORAGE_CONF
            .iter()
            .filter(|(_, c)| c.history)
            .map(|(k, _)| *k)
            .collect();
        history.sort();
        let mut observed: Vec<String> = ObservedAppState::default()
            .to_partial()
            .keys()
            .cloned()
            .collect();
        observed.sort();
        assert_eq!(history, observed);
    }
}
