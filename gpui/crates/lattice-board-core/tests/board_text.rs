// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! Board text: upstream Excalidraw tests @ 3a317b5 translated with their
//! inputs and expected values. Measuring is upstream's test mock
//! (`TestMeasure`: 10px per UTF-16 unit).
//! - element/tests/textWrapping.test.ts, element/tests/textElement.test.ts: all.
//! - excalidraw/wysiwyg/textWysiwyg.test.tsx: the parts that are element
//!   logic, re-expressed as calls on `TextEditSession` (an "update" is
//!   `on_change`, "exit" is `submit`) and the bound-text actions.
//! - element/src/__tests__/stickyNote.test.ts: layout, fit, footer, ink.
//! - element/tests/duplicate.test.tsx: advancing list markers.
//! - the resize cases of textWysiwyg.test.tsx ("should keep width when
//!   editing a wrapped text", "should restore original text after
//!   unwrapping", "should respect text alignment when resizing", "should
//!   scale font size … using shift") and stickyNote.test.ts
//!   (resizeSingleElement / resizeMultipleElements), through resize.rs;
//!   `UI.resize` is one `transform_elements` call (see board_transform).
//! - excalidraw/tests/data/restore.test.ts: refitting with refreshDimensions.
//!
//! Skipped, with reasons:
//! - textWysiwyg "start text editing" (which text the text tool, Enter or a
//!   double-click edits, hover highlights, pending center clicks, frames),
//!   theme, zoom-by-keyboard, side panels, sidebar insets, caret panning,
//!   wheel panning, the autoResize handle and the history entries: app
//!   pointer / DOM behaviour (`AppText` / the canvas), not element logic.
//! - textWysiwyg "find the caret in a bidirectional line": the browser's bidi
//!   layout; `caret_index_at` measures prefixes instead (own test).
//! - textWysiwyg paste tests: clipboard parsing is the app's.
//! - stickyNote binding-intersection and roughness tests (collision, rendering), the
//!   measurement-count spy and render-environment test (no spies; one
//!   measurer per call here).

// The ported tests keep Excalidraw's helper signatures, so each stays
// traceable to its upstream counterpart.
#![allow(clippy::too_many_arguments)]

mod board {
    use lattice_board_core::board::binding::NO_BINDING_HOOKS;
    use lattice_board_core::board::consts::*;
    use lattice_board_core::board::handles::{
        HandleType, OmitSides, PointerType, get_transform_handles,
    };
    use lattice_board_core::board::history::{ElementMap, HistoryHooks};
    use lattice_board_core::board::list_marker::*;
    use lattice_board_core::board::math::point_rotate_rads;
    use lattice_board_core::board::mutate::*;
    use lattice_board_core::board::new_element::*;
    use lattice_board_core::board::random::reseed;
    use lattice_board_core::board::resize::*;
    use lattice_board_core::board::restore::*;
    use lattice_board_core::board::scene::Scene;
    use lattice_board_core::board::sticky::*;
    use lattice_board_core::board::text::*;
    use lattice_board_core::board::text_edit::*;
    use lattice_board_core::board::text_measure::*;
    use lattice_board_core::board::text_wrapping::*;
    use lattice_board_core::board::types::*;
    use lattice_board_core::board::utils::array_to_map;
    use lattice_board_core::board::viewport::{Canvas, Viewport};
    use rustc_hash::FxHashSet;

    const M: &TestMeasure = &TestMeasure;
    fn setup() {
        reseed(1);
        fix_timestamp(Some(1));
        reset_char_width_cache();
    }
    fn font() -> Font {
        Font::new(10., font_family::CASCADIA)
    }
    fn wrap(text: &str, w: f64) -> String {
        wrap_text(M, text, font(), w)
    }

    // ---------------------------------------------------------------------------
    // textWrapping.test.ts
    // ---------------------------------------------------------------------------

    #[test]
    fn wrap_text_basics() {
        // word exactly as wide as the line
        assert_eq!(wrap("Hello Excalidraw", 100.), "Hello\nExcalidraw");
        // invalid widths
        for w in [f64::NAN, -1., f64::INFINITY] {
            assert_eq!(wrap("Hello Excalidraw", w), "Hello Excalidraw");
        }
        assert_eq!(wrap("Hello😀", 10.), "H\ne\nl\nl\no\n😀");
        assert_eq!(
            wrap("don't wrap this number 99,100.99", 300.),
            "don't wrap this number\n99,100.99"
        );
        assert_eq!(wrap("Hello     ", 50.), "Hello");
        assert_eq!(wrap("Hello     ", 60.), "Hello ");
        assert_eq!(wrap("  Hello  World", 90.), "  Hello\nWorld");
        assert_eq!(
            wrap("   Hello  World            ", 90.),
            "   Hello\nWorld    "
        );
        assert_eq!(
            wrap("Hello   Wo rl  d                     ", 100.),
            "Hello   Wo\nrl  d     "
        );
        assert_eq!(wrap("😀🗺🔥👩🏽‍🦰👨‍👩‍👧‍👦🇨🇿", 1.), "😀\n🗺\n🔥\n👩🏽‍🦰\n👨‍👩‍👧‍👦\n🇨🇿");
    }

    #[test]
    fn wrap_text_hyphens_and_lists() {
        let text = "Wikipedia is hosted by Wikimedia- Foundation, a non-profit organization that also hosts a range-of other projects";
        assert_eq!(
            wrap(text, 110.),
            "Wikipedia\nis hosted\nby\nWikimedia-\nFoundation,\na non-\nprofit\norganizatio\nn that also\nhosts a\nrange-of\nother\nprojects"
        );
        assert_eq!(
            wrap("Hello thereusing-now", 100.),
            "Hello\nthereusing\n-now"
        );
        let text = "\tA) one tab\t\t- two tabs        - 8 spaces";
        assert_eq!(wrap(text, 100.), "\tA) one\ntab\t\t- two\ntabs\n- 8 spaces");
        assert_eq!(
            wrap(text, 50.),
            "\tA)\none\ntab\n- two\ntabs\n- 8\nspace\ns"
        );
    }

    fn line(text: &str, start: usize, end: usize) -> WrappedTextLine {
        WrappedTextLine {
            text: text.into(),
            start,
            end,
        }
    }

    #[test]
    fn wrapped_line_offsets() {
        assert_eq!(
            get_wrapped_text_lines(M, "Hello World!", font(), 60.),
            [line("Hello", 0, 5), line("World!", 6, 12)]
        );
        assert_eq!(
            get_wrapped_text_lines(M, "  Hello  World", font(), 90.),
            [line("  Hello", 0, 7), line("World", 9, 14)]
        );
        assert_eq!(
            get_wrapped_text_lines(M, "Excalidraw", font(), 50.),
            [line("Excal", 0, 5), line("idraw", 5, 10)]
        );
        assert_eq!(
            get_wrapped_text_lines(M, "A\n\nB", font(), 100.),
            [line("A", 0, 1), line("", 2, 2), line("B", 3, 4)]
        );
    }

    #[test]
    fn wrap_cjk() {
        let text = "안녕하세요こんにちは世界ｺﾝﾆﾁハ你好";
        assert_eq!(
            wrap(text, 10.),
            "안\n녕\n하\n세\n요\nこ\nん\nに\nち\nは\n世\n界\nｺ\nﾝ\nﾆ\nﾁ\nハ\n你\n好"
        );
        assert_eq!(
            wrap(text, 30.),
            "안녕하\n세요こ\nんにち\nは世界\nｺﾝﾆ\nﾁハ你\n好"
        );
        let text = "a醫 醫      bb  你好  world-i-😀🗺🔥";
        assert_eq!(wrap(text, 150.), "a醫 醫      bb  你\n好  world-i-😀🗺\n🔥");
        assert_eq!(wrap(text, 50.), "a醫 醫\nbb  你\n好\nworld\n-i-😀\n🗺🔥");
        assert_eq!(
            wrap(text, 30.),
            "a醫\n醫\nbb\n你好\nwor\nld-\ni-\n😀\n🗺\n🔥"
        );
        assert_eq!(wrap("HelloたWorld", 50.), "Hello\nた\nWorld");
        assert_eq!(wrap("HelloたWorld", 60.), "Helloた\nWorld");
        assert_eq!(wrap("こんにちは〃世界", 50.), "こんにちは\n〃世界");
        assert_eq!(wrap("こんにちは〃世界", 60.), "こんにちは〃\n世界");
        assert_eq!(wrap("Hello た。", 70.), "Hello\nた。");
        assert_eq!(wrap("Hello「たWorld」", 60.), "Hello\n「た\nWorld」");
        assert_eq!(wrap("「Helloた」World", 70.), "「Hello\nた」World");
    }

    #[test]
    fn wrap_cjk_sentences() {
        let zh = "中国你好！这是一个测试。\n我们来看看：人民币¥1234「很贵」\n（括号）、逗号，句号。空格 换行　全角符号…—";
        assert_eq!(
            wrap(zh, 80.),
            "中国你好！这是一\n个测试。\n我们来看看：人民\n币¥1234「很\n贵」\n（括号）、逗号，\n句号。空格 换行\n全角符号…—"
        );
        assert_eq!(
            wrap(zh, 50.),
            "中国你好！\n这是一个测\n试。\n我们来看\n看：人民币\n¥1234\n「很贵」\n（括号）、\n逗号，句\n号。空格\n换行　全角\n符号…—"
        );
        let ja = "日本こんにちは！これはテストです。\n  見てみましょう：円￥1234「高い」\n  （括弧）、読点、句点。\n  空白 改行　全角記号…ー";
        assert_eq!(
            wrap(ja, 80.),
            "日本こんにちは！\nこれはテストで\nす。\n  見てみましょ\nう：円￥1234\n「高い」\n  （括弧）、読\n点、句点。\n  空白 改行\n全角記号…ー"
        );
        assert_eq!(
            wrap(ja, 50.),
            "日本こんに\nちは！これ\nはテストで\nす。\n  見てみ\nましょう：\n円\n￥1234\n「高い」\n  （括\n弧）、読\n点、句点。\n  空白\n改行　全角\n記号…ー"
        );
        let ko = "한국 안녕하세요! 이것은 테스트입니다.\n우리 보자: 원화₩1234「비싸다」\n(괄호), 쉼표, 마침표.\n공백 줄바꿈　전각기호…—";
        assert_eq!(
            wrap(ko, 80.),
            "한국 안녕하세\n요! 이것은 테\n스트입니다.\n우리 보자: 원\n화₩1234「비\n싸다」\n(괄호), 쉼\n표, 마침표.\n공백 줄바꿈　전\n각기호…—"
        );
        assert_eq!(
            wrap(ko, 60.),
            "한국 안녕하\n세요! 이것\n은 테스트입\n니다.\n우리 보자:\n원화\n₩1234\n「비싸다」\n(괄호),\n쉼표, 마침\n표.\n공백 줄바꿈\n전각기호…—"
        );
    }

    #[test]
    fn wrap_leading_and_trailing_whitespace() {
        let text = "  \t   Hello world";
        assert_eq!(wrap(text, 120.), "  \t   Hello\nworld");
        assert_eq!(wrap(text, 60.), "\nHello\nworld");
        assert_eq!(wrap(text, 30.), "\nHel\nlo\nwor\nld");
        assert_eq!(wrap("Hello whats up     ", 190.), "Hello whats up     ");
        let text = "Hippopotomonstrosesquippedaliophobia        ??????";
        assert_eq!(
            wrap(text, 400.),
            "Hippopotomonstrosesquippedaliophobia\n??????"
        );
        assert_eq!(
            wrap(text, 300.),
            "Hippopotomonstrosesquippedalio\nphobia        ??????"
        );
        assert_eq!(
            wrap(text, 180.),
            "Hippopotomonstrose\nsquippedaliophobia\n??????"
        );
    }

    #[test]
    fn wrap_by_width() {
        for (w, res) in [
            (70., "Hello\nwhats\nup"),
            (15., "H\ne\nl\nl\no\nw\nh\na\nt\ns\nu\np"),
            (130., "Hello whats\nup"),
            (240., "Hello whats up"),
            (50., "Hello\nwhats\nup"),
        ] {
            assert_eq!(wrap("Hello whats up", w), res, "{w}");
        }
        for (w, res) in [
            (70., "Hello\n  whats\nup"),
            (15., "H\ne\nl\nl\no\n\nw\nh\na\nt\ns\nu\np"),
            (140., "Hello\n  whats up"),
        ] {
            assert_eq!(wrap("Hello\n  whats up", w), res, "{w}");
        }
        let text = "hellolongtextthisiswhatsupwithyouIamtypingggggandtypinggg break it now";
        assert_eq!(
            wrap(text, 160.),
            "hellolongtextthi\nsiswhatsupwithyo\nuIamtypingggggan\ndtypinggg break\nit now"
        );
        assert_eq!(
            wrap(text, 120.),
            "hellolongtex\ntthisiswhats\nupwithyouIam\ntypingggggan\ndtypinggg\nbreak it now"
        );
        assert_eq!(
            wrap(text, 590.),
            "hellolongtextthisiswhatsupwithyouIamtypingggggandtypinggg\nbreak it now"
        );
    }

    #[test]
    fn parse_tokens_latin_and_emojis() {
        assert_eq!(
            parse_tokens("Excalidraw is a virtual collaborative whiteboard"),
            [
                "Excalidraw",
                " ",
                "is",
                " ",
                "a",
                " ",
                "virtual",
                " ",
                "collaborative",
                " ",
                "whiteboard"
            ]
        );
        assert_eq!(
            parse_tokens(
                "Wikipedia is hosted by Wikimedia- Foundation, a non-profit organization that also hosts a range-of other projects"
            ),
            [
                "Wikipedia",
                " ",
                "is",
                " ",
                "hosted",
                " ",
                "by",
                " ",
                "Wikimedia-",
                " ",
                "Foundation,",
                " ",
                "a",
                " ",
                "non-",
                "profit",
                " ",
                "organization",
                " ",
                "that",
                " ",
                "also",
                " ",
                "hosts",
                " ",
                "a",
                " ",
                "range-",
                "of",
                " ",
                "other",
                " ",
                "projects"
            ]
        );
        assert_eq!(parse_tokens("99,100.99"), ["99,100.99"]);
        assert_eq!(
            parse_tokens("😬🌍🗺🔥☂️👩🏽‍🦰👨‍👩‍👧‍👦👩🏾‍🔬🏳️‍🌈🧔‍♀️🧑‍🤝‍🧑🙅🏽‍♂️✅0️⃣🇨🇿🦅"),
            [
                "😬",
                "🌍",
                "🗺",
                "🔥",
                "☂️",
                "👩🏽‍🦰",
                "👨‍👩‍👧‍👦",
                "👩🏾‍🔬",
                "🏳️‍🌈",
                "🧔‍♀️",
                "🧑‍🤝‍🧑",
                "🙅🏽‍♂️",
                "✅",
                "0️⃣",
                "🇨🇿",
                "🦅"
            ]
        );
        assert_eq!(
            parse_tokens("😬a🌍b🗺c🔥d☂️《👩🏽‍🦰》👨‍👩‍👧‍👦德👩🏾‍🔬こ🏳️‍🌈안🧔‍♀️g🧑‍🤝‍🧑h🙅🏽‍♂️e✅f0️⃣g🇨🇿10🦅#hash"),
            [
                "😬",
                "a",
                "🌍",
                "b",
                "🗺",
                "c",
                "🔥",
                "d",
                "☂️",
                "《",
                "👩🏽‍🦰",
                "》",
                "👨‍👩‍👧‍👦",
                "德",
                "👩🏾‍🔬",
                "こ",
                "🏳️‍🌈",
                "안",
                "🧔‍♀️",
                "g",
                "🧑‍🤝‍🧑",
                "h",
                "🙅🏽‍♂️",
                "e",
                "✅",
                "f0️⃣g",
                "🇨🇿",
                "10",
                "🦅",
                "#hash"
            ]
        );
    }

    #[test]
    fn parse_tokens_decomposed() {
        let text = "c\u{30c}\u{3066}\u{3099}a\u{308}\u{3072}\u{309a}\u{3b5}\u{301}\u{1103}\u{1161}\u{438}\u{306}\u{1112}\u{1161}\u{11ab}";
        assert_eq!(
            parse_tokens(text),
            ["č", "で", "ä", "ぴ", "έ", "다", "й", "한"]
        );
    }

    #[test]
    fn parse_tokens_artificial_cjk() {
        let text = "《道德經》醫-醫こんにちは世界！안녕하세요세계；요』,다.다...원/달(((다)))[[1]]〚({((한))>)〛(「た」)た…[Hello] \t　World？ニューヨーク・￥3700.55す。090-1234-5678￥1,000〜＄5,000「素晴らしい！」〔重要〕＃１：Taro君30％は、（たなばた）〰￥110±￥570で20℃〜9:30〜10:00【一番】";
        let tokens = parse_tokens(text);
        for t in [
            "[[1]]",
            "[Hello]",
            "World？",
            "Taro",
            "《道",
            "德",
            "經》",
            "醫-",
            "醫",
            "こ",
            "ん",
            "に",
            "ち",
            "は",
            "世",
            "ク・",
            "界！",
            "た…",
            "す。",
            "ュ",
            "「素",
            "晴",
            "ら",
            "し",
            "い！」",
            "君",
            "は、",
            "（た",
            "な",
            "ば",
            "た）",
            "で",
            "【一",
            "番】",
            "안",
            "녕",
            "하",
            "세",
            "요",
            "계；",
            "요』,",
            "다.",
            "다...",
            "원/",
            "달",
            "(((다)))",
            "〚({((한))>)〛",
            "(「た」)",
            "￥3700.55",
            "090-",
            "1234-",
            "5678",
            "￥1,000〜",
            "＄5,000",
            "１：",
            "30％",
            "￥110±",
            "20℃〜",
            "9:30〜",
            "10:00",
            " ",
            "\t",
            "　",
            "ニ",
            "ー",
            "ヨ",
            "〰",
            "＃",
        ] {
            assert!(tokens.iter().any(|x| x == t), "{t:?} in {tokens:?}");
        }
    }

    #[test]
    fn contains_cjk_detects() {
        assert!(contains_cjk("Hello 世界"));
        assert!(contains_cjk("「"));
        assert!(!contains_cjk("Hello world"));
    }

    // ---------------------------------------------------------------------------
    // API.createElement
    // ---------------------------------------------------------------------------

    fn shape(ty: ElementType, x: f64, y: f64, w: f64, h: f64) -> Element {
        let o = ElementOpts {
            seed: Some(1),
            x,
            y,
            width: w,
            height: h,
            created: Some(Some(1)),
            ..Default::default()
        };
        match ty {
            ElementType::Arrow => {
                new_arrow_element(o, vec![[0., 0.], [100., 100.]], None, None, false, None)
            }
            ElementType::StickyNote => new_sticky_note_element(o, Some(h)),
            _ => new_element(ty, o),
        }
    }

    /// `API.createElement({ type: "text", … })`: measured, then sized to
    /// `width` × `height` (default 100 × 100).
    fn text_el(text: &str, f: impl FnOnce(&mut TextOpts, &mut ElementOpts)) -> Element {
        let mut t = TextOpts {
            text: text.into(),
            font_size: Some(20.),
            font_family: Some(DEFAULT_FONT_FAMILY),
            ..Default::default()
        };
        let mut o = ElementOpts {
            seed: Some(1),
            width: 100.,
            height: 100.,
            created: Some(Some(1)),
            ..Default::default()
        };
        f(&mut t, &mut o);
        let (w, h) = (o.width, o.height);
        let mut e = new_text_element(t, o, M);
        (e.width, e.height) = (w, h);
        e
    }

    fn bind(container: &mut Element, text: &Element) {
        container.bound_elements = Some(vec![BoundElement {
            id: text.id.clone(),
            kind: BoundType::Text,
        }]);
    }
    fn get<'a>(s: &'a Scene, id: &str) -> &'a Element {
        s.get_element(id).unwrap()
    }
    fn txt<'a>(s: &'a Scene, id: &str) -> &'a TextData {
        get(s, id).text().unwrap()
    }

    // ---------------------------------------------------------------------------
    // textElement.test.ts
    // ---------------------------------------------------------------------------

    #[test]
    fn container_coords() {
        setup();
        let p = |ty| get_container_coords(&shape(ty, 10., 20., 200., 100.));
        assert_eq!(
            p(ElementType::Ellipse),
            [44.289321881345245, 39.64466094067262]
        );
        assert_eq!(p(ElementType::Rectangle), [15., 25.]);
        assert_eq!(p(ElementType::Diamond), [65., 50.]);
    }

    #[test]
    fn container_dimension_for_bound_text() {
        assert_eq!(
            compute_container_dimension_for_bound_text(150., ElementType::Rectangle),
            160.
        );
        assert_eq!(
            compute_container_dimension_for_bound_text(150., ElementType::Ellipse),
            226.
        );
        assert_eq!(
            compute_container_dimension_for_bound_text(150., ElementType::Diamond),
            320.
        );
    }

    #[test]
    fn bound_text_max_width_and_height() {
        setup();
        let c = |ty| shape(ty, 0., 0., 178., 194.);
        assert_eq!(
            get_bound_text_max_width(&c(ElementType::Rectangle), None),
            168.
        );
        assert_eq!(
            get_bound_text_max_width(&c(ElementType::Ellipse), None),
            116.
        );
        assert_eq!(
            get_bound_text_max_width(&c(ElementType::Diamond), None),
            79.
        );
        let t = text_el(
            "Excalidraw is a\nvirtual \nopensource \nwhiteboard for \nsketching \nhand-drawn like\ndiagrams",
            |t, o| {
                (o.x, o.y, o.width, o.height) = (560.51171875, 202.033203125, 154., 175.);
                (
                    t.font_family,
                    t.text_align,
                    t.vertical_align,
                    t.container_id,
                ) = (
                    Some(1),
                    Some(TextAlign::Center),
                    Some(VerticalAlign::Middle),
                    Some("\"container-id".into()),
                );
            },
        );
        assert_eq!(
            get_bound_text_max_height(&c(ElementType::Rectangle), &t),
            184.
        );
        assert_eq!(
            get_bound_text_max_height(&c(ElementType::Ellipse), &t),
            127.
        );
        assert_eq!(get_bound_text_max_height(&c(ElementType::Diamond), &t), 87.);
        assert_eq!(get_bound_text_max_height(&c(ElementType::Arrow), &t), 194.);
        let low = shape(ElementType::Arrow, 0., 0., 178., 70.);
        assert_eq!(get_bound_text_max_height(&low, &t), t.height);
    }

    #[test]
    fn line_heights() {
        setup();
        let t = text_el(
            "Excalidraw is a\nvirtual \nopensource \nwhiteboard for \nsketching \nhand-drawn like\ndiagrams",
            |t, o| {
                t.font_family = Some(1);
                o.height = 175.;
            },
        );
        let d = t.text().unwrap();
        assert_eq!(detect_line_height(&d.text, t.height, d.font_size), 1.25);
        assert_eq!(get_line_height_in_px(d.font_size, d.line_height), 25.);
        assert_eq!(get_line_height(DEFAULT_FONT_FAMILY), 1.25);
        assert_eq!(get_line_height(5), 1.25);
        assert_eq!(get_line_height(font_family::CASCADIA), 1.2);
    }

    #[test]
    fn bound_text_position_rotated_90() {
        setup();
        let mut c = shape(ElementType::Rectangle, 100., 100., 200., 100.);
        c.angle = std::f64::consts::PI / 2.;
        let cases = [
            (TextAlign::Left, VerticalAlign::Top, 185., 75.),
            (TextAlign::Left, VerticalAlign::Middle, 160., 75.),
            (TextAlign::Left, VerticalAlign::Bottom, 135., 75.),
            (TextAlign::Center, VerticalAlign::Top, 185., 130.),
            (TextAlign::Center, VerticalAlign::Middle, 160., 130.),
            (TextAlign::Center, VerticalAlign::Bottom, 135., 130.),
            (TextAlign::Right, VerticalAlign::Top, 185., 185.),
            (TextAlign::Right, VerticalAlign::Middle, 160., 185.),
            (TextAlign::Right, VerticalAlign::Bottom, 135., 185.),
        ];
        for (a, v, x, y) in cases {
            let t = text_el("hello darkness my old friend", |t, o| {
                (o.width, o.height) = (80., 40.);
                (t.text_align, t.vertical_align, t.container_id) =
                    (Some(a), Some(v), Some(c.id.clone()));
            });
            let [rx, ry] = compute_bound_text_position(&c, &t, &Vec::<Element>::new());
            assert!(
                (rx - x).abs() < 0.05 && (ry - y).abs() < 0.05,
                "{a:?} {v:?}: {rx} {ry}"
            );
        }
    }

    // ---------------------------------------------------------------------------
    // textWysiwyg.test.tsx: Tab / Shift+Tab
    // ---------------------------------------------------------------------------

    #[test]
    fn indent_and_outdent() {
        let tab = "    ";
        assert_eq!(
            indent("Line#1\nLine#2", 0, 0),
            (format!("{tab}Line#1\nLine#2"), 4, 4)
        );
        assert_eq!(
            indent("Line#1\nLine#2", 10, 10),
            (format!("Line#1\n{tab}Line#2"), 14, 14)
        );
        assert_eq!(
            indent("Line#1\nLine#2\nLine#3", 2, 9),
            (format!("{tab}Line#1\n{tab}Line#2\nLine#3"), 6, 17)
        );
        assert_eq!(
            outdent(&format!("{tab}Line#1\nLine#2"), 0, 0),
            ("Line#1\nLine#2".into(), 0, 0)
        );
        assert_eq!(
            outdent(&format!("Line#1\n{tab}Line#2"), 15, 15),
            ("Line#1\nLine#2".into(), 11, 11)
        );
        assert_eq!(
            outdent(&format!("{tab}Line#1\n{tab}Line#2\nLine#3"), 6, 17),
            ("Line#1\nLine#2\nLine#3".into(), 2, 9)
        );
        assert_eq!(outdent(&format!("Line#1\n{tab}Line#2"), 9, 9).1, 7);
        assert_eq!(outdent("Line#1\n  Line#2", 15, 15).0, "Line#1\nLine#2");
        assert_eq!(outdent("Line#1\nLine#2", 9, 9).0, "Line#1\nLine#2");
    }

    // ---------------------------------------------------------------------------
    // textWysiwyg.test.tsx: container-unbound text
    // ---------------------------------------------------------------------------

    fn view(width: f64, zoom: f64) -> EditView {
        EditView {
            viewport: Viewport {
                scroll_x: 0.,
                scroll_y: 0.,
                zoom,
            },
            canvas: Canvas {
                offset_left: 0.,
                offset_top: 0.,
                width,
                height: 400.,
            },
        }
    }

    /// The text tool's empty free text, being edited (`UI.createElement("text")`).
    fn free_text_session(align: TextAlign) -> (Scene, TextEditSession) {
        let t = new_text_element(
            TextOpts {
                text: String::new(),
                text_align: Some(align),
                ..Default::default()
            },
            ElementOpts::at(30., 30.),
            M,
        );
        let id = t.id.clone();
        let mut scene = Scene::new(vec![t]);
        let mut s = TextEditSession::new(&scene, &id, false);
        s.update_style(&mut scene, &view(800., 1.));
        (scene, s)
    }

    #[test]
    fn wrapping_editor_keeps_exact_width() {
        setup();
        let t = text_el("Hello world", |t, o| {
            o.width = 98.46;
            t.text_align = Some(TextAlign::Center);
            t.auto_resize = Some(false);
        });
        let id = t.id.clone();
        let mut scene = Scene::new(vec![t]);
        let mut s = TextEditSession::new(&scene, &id, true);
        s.update_style(&mut scene, &view(800., 1.));
        s.update_element(&mut scene, M, "Hello world", false, 760.);
        let l = s.update_style(&mut scene, &view(800., 1.)).layout.unwrap();
        assert!(l.wraps);
        assert_eq!(l.placement.width, 98.46);
        assert_eq!(l.placement.origin_x, -49.23);
    }

    #[test]
    fn growing_text_stops_at_view_width() {
        setup();
        let max = get_max_text_width(800., TEXT_VIEWPORT_PADDING, TEXT_VIEWPORT_PADDING, 1.);
        assert_eq!(max, 800. - 2. * TEXT_VIEWPORT_PADDING);
        let (mut scene, mut s) = free_text_session(TextAlign::Left);
        let line = "Excalidraw is an opensource virtual collaborative whiteboard for sketching hand-drawn like diagrams!";
        let r = s.on_change(&mut scene, M, line, max, &view(800., 1.));
        assert!(r.started_wrapping);
        let id = s.element_id.clone();
        let (t, d) = (get(&scene, &id), txt(&scene, &id));
        assert!(!d.auto_resize);
        assert_eq!(t.width, max);
        assert_eq!(d.original_text, line);
        assert!(d.text.contains('\n'));
        let l = r.style.layout.unwrap();
        assert!(l.wraps);
        assert_eq!(l.placement.width, max);
        let h = t.height;
        s.on_change(
            &mut scene,
            M,
            &format!("{line} {line}"),
            max,
            &view(800., 1.),
        );
        assert_eq!(get(&scene, &id).width, max);
        assert!(get(&scene, &id).height > h);
    }

    #[test]
    fn max_text_width_follows_zoom_sidebar_and_cap() {
        // a 300px docked sidebar at 200%
        assert_eq!(
            get_max_text_width(
                800.,
                300. + TEXT_VIEWPORT_PADDING,
                TEXT_VIEWPORT_PADDING,
                2.
            ),
            (800. - 300. - 2. * TEXT_VIEWPORT_PADDING) / 2.
        );
        for zoom in [0.5, 2.] {
            assert_eq!(
                get_max_text_width(2000., TEXT_VIEWPORT_PADDING, TEXT_VIEWPORT_PADDING, zoom),
                TEXT_MAX_WRAP_WIDTH
            );
        }
        setup();
        let (mut scene, mut s) = free_text_session(TextAlign::Left);
        let max = get_max_text_width(
            800.,
            300. + TEXT_VIEWPORT_PADDING,
            TEXT_VIEWPORT_PADDING,
            2.,
        );
        s.on_change(
            &mut scene,
            M,
            "Excalidraw is an opensource virtual collaborative whiteboard",
            max,
            &view(800., 2.),
        );
        assert_eq!(get(&scene, &s.element_id).width, max);
    }

    #[test]
    fn right_aligned_text_keeps_right_edge() {
        setup();
        let (mut scene, mut s) = free_text_session(TextAlign::Right);
        s.on_change(&mut scene, M, "short", 760., &view(800., 1.));
        let (x, w) = (
            get(&scene, &s.element_id).x,
            get(&scene, &s.element_id).width,
        );
        s.on_change(&mut scene, M, "Excalidraw is an opensource virtual collaborative whiteboard for sketching hand-drawn like diagrams!", 760., &view(800., 1.));
        let t = get(&scene, &s.element_id);
        assert!(!t.text().unwrap().auto_resize);
        assert!((t.x + t.width - (x + w)).abs() < 1e-6);
    }

    // ---------------------------------------------------------------------------
    // textWysiwyg.test.tsx: container-bound text
    // ---------------------------------------------------------------------------

    /// Enter on a selected container (`startTextEditing` binding a new label).
    fn start_label(scene: &mut Scene, container_id: &str) -> TextEditSession {
        let c = get(scene, container_id).clone();
        let (font_size, family) = (DEFAULT_FONT_SIZE, DEFAULT_FONT_FAMILY);
        let lh = get_line_height(family);
        let at = if c.is_arrow() || c.is_sticky_note() {
            get_container_center(&c, scene)
        } else {
            grow_container_for_new_label(scene, container_id, Font::new(font_size, family), lh, M)
                .unwrap()
        };
        let c = get(scene, container_id).clone();
        let t = new_text_element(
            TextOpts {
                text: String::new(),
                font_size: Some(font_size),
                font_family: Some(family),
                text_align: Some(TextAlign::Center),
                vertical_align: Some(VerticalAlign::Middle),
                container_id: Some(c.id.clone()),
                label_position: c.is_arrow().then_some(DEFAULT_BOUND_TEXT_LABEL_POSITION),
                line_height: Some(lh),
                ..Default::default()
            },
            ElementOpts {
                angle: if c.is_arrow() { 0. } else { c.angle },
                group_ids: c.group_ids.clone(),
                ..ElementOpts::at(at[0], at[1])
            },
            M,
        );
        let id = t.id.clone();
        scene.mutate_element(container_id, true, |e| {
            e.bound_elements
                .get_or_insert_with(Vec::new)
                .push(BoundElement {
                    id: id.clone(),
                    kind: BoundType::Text,
                })
        });
        let i = scene.get_element_index(container_id).unwrap();
        scene.insert_elements_at_index(vec![t], Some(i + 1));
        edit(scene, &id, false)
    }

    fn edit(scene: &mut Scene, id: &str, existing: bool) -> TextEditSession {
        let mut s = TextEditSession::new(scene, id, existing);
        s.update_style(scene, &view(800., 1.));
        let ot = txt(scene, id).original_text.clone();
        s.update_element(scene, M, &ot, false, 760.);
        s.update_style(scene, &view(800., 1.));
        s
    }

    fn type_text(scene: &mut Scene, s: &mut TextEditSession, text: &str) {
        s.on_change(scene, M, text, 760., &view(800., 1.));
    }
    fn exit(scene: &mut Scene, s: &mut TextEditSession) -> SubmitOutcome {
        let v = txt(scene, &s.element_id).original_text.clone();
        s.submit(scene, M, &v, true, 760.).unwrap()
    }

    fn rect_scene() -> (Scene, String) {
        let r = shape(ElementType::Rectangle, 10., 20., 90., 75.);
        let id = r.id.clone();
        (Scene::new(vec![r]), id)
    }

    #[test]
    fn label_wraps_and_centers_on_submit() {
        setup();
        let (mut scene, rid) = rect_scene();
        let mut s = start_label(&mut scene, &rid);
        let tid = s.element_id.clone();
        type_text(&mut scene, &mut s, "Hello World!");
        exit(&mut scene, &mut s);
        let (t, d, r) = (get(&scene, &tid), txt(&scene, &tid), get(&scene, &rid));
        assert_eq!(
            (d.text.as_str(), d.original_text.as_str()),
            ("Hello\nWorld!", "Hello World!")
        );
        assert_eq!(t.y, r.y + r.height / 2. - t.height / 2.);
        assert_eq!((t.x, t.height, t.width), (25., 50., 60.));
        // edit again, removing the second line
        let mut s = edit(&mut scene, &tid, true);
        type_text(&mut scene, &mut s, "Hello");
        exit(&mut scene, &mut s);
        let (t, d, r) = (get(&scene, &tid), txt(&scene, &tid), get(&scene, &rid));
        assert_eq!(
            (d.text.as_str(), d.original_text.as_str()),
            ("Hello", "Hello")
        );
        assert_eq!((t.height, t.width, t.x), (25., 50., 30.));
        assert_eq!(t.y, r.y + r.height / 2. - t.height / 2.);
        assert_eq!(
            r.bound_elements,
            Some(vec![BoundElement {
                id: tid.clone(),
                kind: BoundType::Text
            }])
        );
    }

    #[test]
    fn container_grows_and_shrinks_while_typing() {
        setup();
        let d = shape(ElementType::Diamond, 10., 20., 90., 75.);
        let did = d.id.clone();
        let mut scene = Scene::new(vec![d]);
        let mut s = start_label(&mut scene, &did);
        let value = ["1"; 1000].join("\n");
        let r = s.on_change(&mut scene, M, &value, 760., &view(800., 1.));
        assert_eq!(get(&scene, &did).height, 50020.);
        assert_eq!(r.style.resized_containers, std::slice::from_ref(&did));
        type_text(&mut scene, &mut s, "");
        assert_eq!(get(&scene, &did).height, 70.);
    }

    #[test]
    fn whitespace_only_label_is_deleted() {
        setup();
        let (mut scene, rid) = rect_scene();
        let mut s = start_label(&mut scene, &rid);
        type_text(&mut scene, &mut s, "   ");
        let out = exit(&mut scene, &mut s);
        assert!(out.is_deleted);
        assert_eq!(get(&scene, &rid).bound_elements, Some(vec![]));
        assert!(get(&scene, &s.element_id).is_deleted);
    }

    #[test]
    fn deleting_a_label_reselects_its_container() {
        for arrow in [false, true] {
            setup();
            let mut c = if arrow {
                shape(ElementType::Arrow, 0., 0., 100., 100.)
            } else {
                shape(ElementType::Rectangle, 0., 0., 100., 100.)
            };
            let t = text_el(if arrow { "test" } else { "sample-text" }, |t, o| {
                (o.width, o.height) = (50., 20.);
                t.container_id = Some(c.id.clone());
                if !arrow {
                    t.font_size = Some(16.);
                }
            });
            bind(&mut c, &t);
            let (cid, tid) = (c.id.clone(), t.id.clone());
            let mut scene = Scene::new(vec![c, t]);
            let mut s = edit(&mut scene, &tid, true);
            type_text(&mut scene, &mut s, "");
            let out = exit(&mut scene, &mut s);
            assert_eq!(out.select_id.as_deref(), Some(cid.as_str()));
            assert!(out.capture);
            assert_eq!(get(&scene, &cid).bound_elements, Some(vec![]));
            assert!(get(&scene, &tid).is_deleted);
        }
    }

    #[test]
    fn unbinding_restores_container_height() {
        setup();
        let c = shape(ElementType::Rectangle, 0., 0., 90., 75.);
        let t = text_el("Online whiteboard collaboration made easy", |_, _| {});
        let (cid, tid) = (c.id.clone(), t.id.clone());
        let mut scene = Scene::new(vec![c, t]);
        assert!(can_bind_text(
            &[get(&scene, &cid), get(&scene, &tid)],
            &scene
        ));
        bind_text_to_container(&mut scene, &tid, &cid, M);
        assert_eq!(
            txt(&scene, &tid).text,
            "Online\nwhiteboa\nrd\ncollabor\nation\nmade\neasy"
        );
        assert_eq!(
            scene
                .elements_including_deleted()
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            [cid.as_str(), tid.as_str()]
        );
        assert!(can_unbind_text(&[get(&scene, &cid)]));
        assert_eq!(
            unbind_text(&mut scene, &cid, M).as_deref(),
            Some(tid.as_str())
        );
        assert_eq!(get(&scene, &cid).bound_elements, Some(vec![]));
        assert_eq!(txt(&scene, &tid).container_id, None);
        assert_eq!(get_original_container_height_from_cache(&cid), None);
        assert_eq!(get(&scene, &cid).height, 75.);
    }

    #[test]
    fn container_cache_resets_on_resize() {
        setup();
        let (mut scene, rid) = rect_scene();
        let mut s = start_label(&mut scene, &rid);
        assert_eq!(get_original_container_height_from_cache(&rid), Some(75.));
        let tid = s.element_id.clone();
        type_text(&mut scene, &mut s, "Hello");
        exit(&mut scene, &mut s);
        // a resize (the "ne" handle) to 155 high
        scene.mutate_element(&rid, true, |e| {
            e.y -= 80.;
            e.height = 155.;
            e.width = 190.;
        });
        handle_bind_text_resize(
            &mut scene,
            &rid,
            M,
            Some(lattice_board_core::board::handles::HandleType::Ne),
            false,
            false,
            false,
        );
        assert_eq!(get(&scene, &rid).height, 155.);
        assert_eq!(get_original_container_height_from_cache(&rid), None);
        let mut s = edit(&mut scene, &tid, true);
        exit(&mut scene, &mut s);
        assert_eq!(get(&scene, &rid).height, 155.);
        assert_eq!(get_original_container_height_from_cache(&rid), Some(155.));
    }

    #[test]
    fn container_cache_follows_font_changes() {
        setup();
        let (mut scene, rid) = rect_scene();
        let mut s = start_label(&mut scene, &rid);
        let tid = s.element_id.clone();
        type_text(&mut scene, &mut s, "Hello World!");
        exit(&mut scene, &mut s);
        let mut s = edit(&mut scene, &tid, true);
        // the font family action: family and its line height, then a redraw
        let mut change = |scene: &mut Scene, f: &dyn Fn(&mut TextData)| {
            scene.mutate_element(&tid, true, |e| f(e.text_mut().unwrap()));
            let t = get(scene, &tid).clone();
            redraw_text_bounding_box(scene, &t, Some(&rid), M);
            s.update_style(scene, &view(800., 1.));
        };
        change(&mut scene, &|d| {
            d.font_family = font_family::COMIC_SHANNS;
            d.line_height = get_line_height(font_family::COMIC_SHANNS);
        });
        assert_eq!(txt(&scene, &tid).font_family, font_family::COMIC_SHANNS);
        assert_eq!(get_original_container_height_from_cache(&rid), Some(75.));
        assert_eq!(txt(&scene, &tid).line_height, 1.25);
        change(&mut scene, &|d| d.font_size = 36.);
        assert_eq!(get_original_container_height_from_cache(&rid), Some(100.));
        change(&mut scene, &|d| {
            d.font_family = font_family::NUNITO;
            d.line_height = get_line_height(font_family::NUNITO);
        });
        assert_eq!(txt(&scene, &tid).line_height, 1.25);
    }

    #[test]
    fn label_alignment() {
        let cases = [
            (TextAlign::Left, VerticalAlign::Top, 15., 25.),
            (TextAlign::Center, VerticalAlign::Top, 30., 25.),
            (TextAlign::Right, VerticalAlign::Top, 45., 25.),
            (TextAlign::Left, VerticalAlign::Middle, 15., 45.),
            (TextAlign::Center, VerticalAlign::Middle, 30., 45.),
            (TextAlign::Right, VerticalAlign::Middle, 45., 45.),
            (TextAlign::Left, VerticalAlign::Bottom, 15., 65.),
            (TextAlign::Center, VerticalAlign::Bottom, 30., 65.),
            (TextAlign::Right, VerticalAlign::Bottom, 45., 65.),
        ];
        for (a, v, x, y) in cases {
            setup();
            let (mut scene, rid) = rect_scene();
            let mut s = start_label(&mut scene, &rid);
            let tid = s.element_id.clone();
            type_text(&mut scene, &mut s, "Hello");
            exit(&mut scene, &mut s);
            let mut s = edit(&mut scene, &tid, true);
            scene.mutate_element(&tid, true, |e| {
                let d = e.text_mut().unwrap();
                (d.text_align, d.vertical_align) = (a, v);
            });
            let t = get(&scene, &tid).clone();
            redraw_text_bounding_box(&mut scene, &t, Some(&rid), M);
            s.update_style(&mut scene, &view(800., 1.));
            assert_eq!(
                [get(&scene, &tid).x, get(&scene, &tid).y],
                [x, y],
                "{a:?} {v:?}"
            );
        }
    }

    #[test]
    fn wrap_text_in_container() {
        setup();
        let (mut scene, _) = rect_scene();
        // the text tool at (20, 30)
        let lh = get_line_height(DEFAULT_FONT_FAMILY);
        let [x, y] = new_free_text_position(20., 30., DEFAULT_FONT_SIZE, lh, None);
        let t = new_text_element(
            TextOpts {
                text: String::new(),
                ..Default::default()
            },
            ElementOpts::at(x, y),
            M,
        );
        let tid = t.id.clone();
        scene.insert_element(t);
        let mut s = edit(&mut scene, &tid, false);
        type_text(
            &mut scene,
            &mut s,
            "Excalidraw is an opensource virtual collaborative whiteboard",
        );
        exit(&mut scene, &mut s);
        let t = get(&scene, &tid);
        assert_eq!(
            (t.width, t.height, txt(&scene, &tid).text_align),
            (600., 25., TextAlign::Left)
        );
        assert!(can_wrap_text_in_container(&[t]));
        let ids = wrap_texts_in_containers(&mut scene, std::slice::from_ref(&tid), false, M);
        let els = scene.elements_including_deleted();
        assert_eq!(els.len(), 3);
        let c = &els[1];
        assert_eq!(c.id, ids[0]);
        assert_eq!(
            (
                c.ty(),
                c.angle,
                c.background_color.as_str(),
                c.fill_style,
                c.height,
                c.width,
                c.x,
                c.y
            ),
            (
                ElementType::Rectangle,
                0.,
                "transparent",
                FillStyle::Solid,
                35.,
                610.,
                15.,
                12.5
            )
        );
        assert_eq!(
            (
                c.roundness,
                c.stroke_color.as_str(),
                c.stroke_style,
                c.stroke_width,
                c.roughness,
                c.opacity,
                c.updated,
                c.version
            ),
            (None, "#1e1e1e", StrokeStyle::Solid, 2., 1., 100., 1, 2)
        );
        assert_eq!(
            c.bound_elements,
            Some(vec![BoundElement {
                id: tid.clone(),
                kind: BoundType::Text
            }])
        );
        let d = els[2].text().unwrap();
        assert_eq!(
            (
                d.text.as_str(),
                d.vertical_align,
                d.text_align,
                els[2].bound_elements.clone()
            ),
            (
                "Excalidraw is an opensource virtual collaborative whiteboard",
                VerticalAlign::Middle,
                TextAlign::Center,
                None
            )
        );
    }

    #[test]
    fn label_angles() {
        // binding a rotated text resets its angle to the container's (0 on arrows)
        for (ty, expected) in [(ElementType::Rectangle, 30.), (ElementType::Arrow, 0.)] {
            setup();
            let mut c = shape(ty, 0., 0., 90., 75.);
            c.angle = 30.;
            let t = text_el("Hello World!", |_, o| o.angle = 45.);
            let (cid, tid) = (c.id.clone(), t.id.clone());
            let mut scene = Scene::new(vec![c, t]);
            assert_eq!(
                bind_text_pair(&[get(&scene, &cid), get(&scene, &tid)]),
                Some((tid.clone(), cid.clone()))
            );
            bind_text_to_container(&mut scene, &tid, &cid, M);
            assert_eq!(get(&scene, &tid).angle, expected);
            assert_eq!(get(&scene, &cid).angle, 30.);
        }
        // a new label keeps that angle while edited
        for (ty, angle, expected) in [
            (ElementType::Arrow, 30., 0.),
            (ElementType::Rectangle, 30., 30.),
            (ElementType::Rectangle, 45., 45.),
        ] {
            setup();
            let mut c = shape(ty, 0., 0., 90., 75.);
            c.angle = angle;
            let cid = c.id.clone();
            let mut scene = Scene::new(vec![c]);
            let mut s = start_label(&mut scene, &cid);
            assert_eq!(get(&scene, &s.element_id).angle, expected);
            type_text(&mut scene, &mut s, "Hello World!");
            exit(&mut scene, &mut s);
            assert_eq!(get(&scene, &s.element_id).angle, expected);
            assert_eq!(
                get(&scene, &cid).bound_elements,
                Some(vec![BoundElement {
                    id: s.element_id.clone(),
                    kind: BoundType::Text
                }])
            );
        }
    }

    // ---------------------------------------------------------------------------
    // own: caret, resize, history
    // ---------------------------------------------------------------------------

    #[test]
    fn caret_geometry() {
        let b = TextBox {
            x: 0.,
            y: 0.,
            width: 50.,
            height: 50.,
            angle: 0.,
            line_height_px: 25.,
            align: TextAlign::Left,
            font: Font::new(20., 5),
        };
        assert_eq!(caret_index_at(M, &b, "Hello World", [32., 30.], true), 9);
        assert_eq!(caret_index_at(M, &b, "Hello World", [-5., 5.], true), 0);
        assert_eq!(
            caret_viewport_bounds(M, &b, "Hello World", 8, true, |p| p),
            [20., 25., 20., 50.]
        );
    }

    #[test]
    fn bind_text_resize_rewraps() {
        setup();
        let (mut scene, rid) = rect_scene();
        let mut s = start_label(&mut scene, &rid);
        let tid = s.element_id.clone();
        type_text(&mut scene, &mut s, "Hello World!");
        exit(&mut scene, &mut s);
        scene.mutate_element(&rid, true, |e| e.width = 200.);
        handle_bind_text_resize(
            &mut scene,
            &rid,
            M,
            Some(lattice_board_core::board::handles::HandleType::E),
            false,
            false,
            false,
        );
        let t = get(&scene, &tid);
        assert_eq!(txt(&scene, &tid).text, "Hello World!");
        assert_eq!((t.x, t.width, t.height), (10. + 100. - 60., 120., 25.));
        // a vertical resize keeps the wrap
        scene.mutate_element(&rid, true, |e| e.width = 90.);
        handle_bind_text_resize(
            &mut scene,
            &rid,
            M,
            Some(lattice_board_core::board::handles::HandleType::S),
            false,
            false,
            false,
        );
        assert_eq!(txt(&scene, &tid).text, "Hello World!");
    }

    #[test]
    fn history_hook_relayouts_labels() {
        setup();
        let mut c = shape(ElementType::Rectangle, 0., 0., 200., 100.);
        let t = text_el("Hello World!", |t, _| {
            t.container_id = Some(c.id.clone());
            t.text_align = Some(TextAlign::Center);
            t.vertical_align = Some(VerticalAlign::Middle);
        });
        bind(&mut c, &t);
        let (cid, tid) = (c.id.clone(), t.id.clone());
        let mut map = ElementMap::from_slice(&[c, t]);
        map.mutate(&cid, |e| e.width = 90.);
        TextHooks(M).redraw_text_bounding_box(&tid, &cid, &mut map);
        let t = map.get(&tid).unwrap();
        assert_eq!(t.text().unwrap().text, "Hello\nWorld!");
        assert_eq!((t.x, t.y, t.width, t.height), (15., 25., 60., 50.));
    }

    #[test]
    fn refresh_text_dimensions_rewraps() {
        setup();
        let mut c = shape(ElementType::Rectangle, 0., 0., 90., 100.);
        let t = text_el("Hello World!", |t, _| t.container_id = Some(c.id.clone()));
        bind(&mut c, &t);
        let d = refresh_text_dimensions(&t, Some(&c), &vec![c.clone(), t.clone()], None, None, M)
            .unwrap();
        assert_eq!(
            (d.text.as_str(), d.width, d.height),
            ("Hello\nWorld!", 60., 50.)
        );
        assert_eq!(
            get_text_from_elements(&[t.clone(), c.clone(), t], "\n\n"),
            "Hello World!\n\nHello World!"
        );
    }

    // ---------------------------------------------------------------------------
    // stickyNote.test.ts
    // ---------------------------------------------------------------------------

    const STICKY_FONT_SIZE: f64 = 28.;

    fn sticky_with_text(original: &str) -> (Scene, String, String) {
        let mut note = new_sticky_note_element(
            ElementOpts {
                x: 100.,
                y: 100.,
                width: DEFAULT_STICKY_NOTE_SIZE,
                height: DEFAULT_STICKY_NOTE_SIZE,
                ..Default::default()
            },
            Some(DEFAULT_STICKY_NOTE_SIZE),
        );
        let t = new_text_element(
            TextOpts {
                text: original.into(),
                original_text: Some(original.into()),
                font_size: Some(STICKY_FONT_SIZE),
                base_font_size: Some(STICKY_FONT_SIZE),
                text_align: Some(TextAlign::Center),
                vertical_align: Some(VerticalAlign::Middle),
                container_id: Some(note.id.clone()),
                auto_resize: Some(true),
                ..Default::default()
            },
            ElementOpts::at(225., 225.),
            M,
        );
        bind(&mut note, &t);
        let (nid, tid) = (note.id.clone(), t.id.clone());
        let mut scene = Scene::new(vec![note, t]);
        let t = get(&scene, &tid).clone();
        assert!(redraw_text_bounding_box(&mut scene, &t, Some(&nid), M));
        (scene, nid, tid)
    }
    fn base_height(e: &Element) -> f64 {
        match e.kind {
            Kind::StickyNote { base_height } => base_height,
            _ => panic!(),
        }
    }
    fn layout(scene: &Scene, nid: &str, tid: &str, opts: StickyNoteLayoutOpts) -> StickyNoteLayout {
        get_sticky_note_layout(get(scene, nid), Some(get(scene, tid)), &opts, M)
    }

    #[test]
    fn sticky_font_floor_and_ceilings() {
        setup();
        let (mut scene, nid, tid) = sticky_with_text("short");
        let fs = STICKY_NOTE_MIN_FONT_SIZE - 1.;
        scene.mutate_element(&tid, true, |e| {
            let d = e.text_mut().unwrap();
            d.font_size = fs;
            d.base_font_size = Some(fs);
        });
        assert_eq!(
            layout(&scene, &nid, &tid, Default::default())
                .text
                .unwrap()
                .font_size,
            fs
        );
        assert_eq!(
            normalize_sticky_note_font_size(f64::NAN),
            STICKY_NOTE_FALLBACK_FONT_SIZE
        );
        assert_eq!(
            normalize_sticky_note_font_size(f64::INFINITY),
            STICKY_NOTE_FALLBACK_FONT_SIZE
        );
        assert_eq!(
            normalize_sticky_note_font_size(f64::NEG_INFINITY),
            STICKY_NOTE_FALLBACK_FONT_SIZE
        );
        assert_eq!(
            normalize_sticky_note_font_size(1e20),
            STICKY_NOTE_MAX_FONT_SIZE
        );
        assert_eq!(normalize_sticky_note_font_size(0.), MIN_FONT_SIZE);
        assert_eq!(normalize_sticky_note_font_size(24.), 24.);
        let (mut scene, nid, tid) = sticky_with_text("some text that must wrap");
        for b in [1e20, f64::INFINITY, f64::NAN] {
            scene.mutate_element(&tid, true, |e| {
                e.text_mut().unwrap().base_font_size = Some(b)
            });
            let l = layout(&scene, &nid, &tid, Default::default());
            let fs = l.text.unwrap().font_size;
            assert!(fs.is_finite() && fs <= STICKY_NOTE_MAX_FONT_SIZE);
            assert!(l.container.height.is_finite());
        }
    }

    #[test]
    fn sticky_downscales_then_grows() {
        setup();
        let (scene, nid, tid) = sticky_with_text(&["abcdefghij"; 7].join("\n"));
        let (n, t) = (get(&scene, &nid), get(&scene, &tid));
        let d = t.text().unwrap();
        assert_eq!(
            (n.width, n.height, base_height(n)),
            (
                DEFAULT_STICKY_NOTE_SIZE,
                DEFAULT_STICKY_NOTE_SIZE,
                DEFAULT_STICKY_NOTE_SIZE
            )
        );
        assert!(t.x - n.x >= STICKY_NOTE_PADDING && t.y - n.y >= STICKY_NOTE_PADDING);
        assert!(d.font_size < d.base_font_size.unwrap() && d.font_size > STICKY_NOTE_MIN_FONT_SIZE);

        let (mut scene, nid, tid) = sticky_with_text(&["abcdefghijklmnopqrstuvwx"; 40].join("\n"));
        assert_eq!(txt(&scene, &tid).font_size, STICKY_NOTE_MIN_FONT_SIZE);
        assert!(get(&scene, &nid).height > base_height(get(&scene, &nid)));
        assert_eq!(get(&scene, &nid).y, 100.);
        scene.mutate_element(&tid, true, |e| {
            let d = e.text_mut().unwrap();
            d.original_text = "short".into();
            d.text = "short".into();
        });
        let t = get(&scene, &tid).clone();
        redraw_text_bounding_box(&mut scene, &t, Some(&nid), M);
        let n = get(&scene, &nid);
        assert_eq!((n.height, n.y), (base_height(n), 100.));
        assert_eq!(
            Some(txt(&scene, &tid).font_size),
            txt(&scene, &tid).base_font_size
        );
    }

    #[test]
    fn sticky_ceiling_grid() {
        setup();
        let (scene, nid, tid) = sticky_with_text("short");
        assert_eq!(txt(&scene, &tid).font_size, STICKY_FONT_SIZE);
        let l = layout(
            &scene,
            &nid,
            &tid,
            StickyNoteLayoutOpts {
                base_font_size: Some(20.),
                ..Default::default()
            },
        )
        .text
        .unwrap();
        assert_eq!((l.font_size, l.base_font_size), (20., 20.));
        assert_eq!(
            layout(
                &scene,
                &nid,
                &tid,
                StickyNoteLayoutOpts {
                    base_font_size: Some(27.),
                    ..Default::default()
                }
            )
            .text
            .unwrap()
            .font_size,
            27.
        );
        assert_eq!(
            layout(
                &scene,
                &nid,
                &tid,
                StickyNoteLayoutOpts {
                    base_font_size: Some(27.5),
                    ..Default::default()
                }
            )
            .text
            .unwrap()
            .font_size,
            27.5
        );
        let fitted = layout(
            &scene,
            &nid,
            &tid,
            StickyNoteLayoutOpts {
                original_text: Some(["abcdefghij"; 7].join("\n")),
                base_font_size: Some(27.),
                ..Default::default()
            },
        )
        .text
        .unwrap()
        .font_size;
        assert!(fitted < 27.);
        assert!(fitted == STICKY_NOTE_MIN_FONT_SIZE || (27. - fitted) % 2. == 0.);
        // a 512 ceiling with nothing fitting still terminates at the minimum
        let mut big = get(&scene, &tid).clone();
        big.text_mut().unwrap().font_size = STICKY_NOTE_MAX_FONT_SIZE;
        let l = get_sticky_note_layout(
            get(&scene, &nid),
            Some(&big),
            &StickyNoteLayoutOpts {
                original_text: Some(["abcdefghijklmnopqrstuvwx"; 40].join("\n")),
                base_font_size: Some(STICKY_NOTE_MAX_FONT_SIZE),
                ..Default::default()
            },
            M,
        );
        assert_eq!(l.text.unwrap().font_size, STICKY_NOTE_MIN_FONT_SIZE);
    }

    #[test]
    fn sticky_min_size() {
        assert_eq!(
            get_sticky_note_min_size(20., font_family::EXCALIFONT),
            (STICKY_NOTE_MIN_SIZE, 25. + STICKY_NOTE_BODY_INSET_Y)
        );
        assert_eq!(
            get_sticky_note_min_size(48., font_family::EXCALIFONT),
            (
                60. + STICKY_NOTE_PADDING * 2.,
                60. + STICKY_NOTE_BODY_INSET_Y
            )
        );
        assert_eq!(
            get_sticky_note_min_size(STICKY_FONT_SIZE, font_family::EXCALIFONT),
            (STICKY_NOTE_MIN_SIZE, 35. + STICKY_NOTE_BODY_INSET_Y)
        );
    }

    #[test]
    fn sticky_label_clears_footer() {
        setup();
        let (scene, nid, tid) = sticky_with_text("Tall");
        let (n, t) = (get(&scene, &nid), get(&scene, &tid));
        let padded = n.height - STICKY_NOTE_PADDING * 2.;
        let body_bottom = n.y + n.height - STICKY_NOTE_PADDING - STICKY_NOTE_FOOTER_HEIGHT;
        let mut short = t.clone();
        short.height = 100.;
        assert!(
            (compute_bound_text_position(n, &short, &scene)[1]
                - (n.y + STICKY_NOTE_PADDING + (padded - 100.) / 2.))
                .abs()
                < 1e-9
        );
        let mut tall = t.clone();
        tall.height = padded - STICKY_NOTE_FOOTER_HEIGHT;
        assert!(
            (compute_bound_text_position(n, &tall, &scene)[1] - (body_bottom - tall.height)).abs()
                < 1e-9
        );
        assert_eq!(
            get_bound_text_max_height(n, t),
            n.height - STICKY_NOTE_BODY_INSET_Y
        );
        for angle in [0., std::f64::consts::FRAC_PI_4, std::f64::consts::FRAC_PI_2] {
            let (mut scene, nid, tid) = sticky_with_text("Last line");
            scene.mutate_element(&nid, true, |e| e.angle = angle);
            scene.mutate_element(&tid, true, |e| {
                e.text_mut().unwrap().vertical_align = VerticalAlign::Bottom
            });
            let t = get(&scene, &tid).clone();
            redraw_text_bounding_box(&mut scene, &t, Some(&nid), M);
            let (n, t) = (get(&scene, &nid), get(&scene, &tid));
            let [_, cy] = point_rotate_rads(
                [t.x + t.width / 2., t.y + t.height / 2.],
                [n.x + n.width / 2., n.y + n.height / 2.],
                -angle,
            );
            assert!(
                (cy + t.height / 2.
                    - (n.y + n.height - STICKY_NOTE_PADDING - STICKY_NOTE_FOOTER_HEIGHT))
                    .abs()
                    < 1e-6,
                "{angle}"
            );
            assert_eq!(
                (base_height(n), n.height),
                (DEFAULT_STICKY_NOTE_SIZE, DEFAULT_STICKY_NOTE_SIZE)
            );
        }
    }

    /// Epoch ms of a UTC calendar day at noon.
    fn noon(y: i64, m0: i64, d: i64) -> i64 {
        let (y, m) = if m0 < 2 {
            (y - 1, m0 + 13)
        } else {
            (y, m0 + 1)
        };
        let days = 365 * y + y / 4 - y / 100 + y / 400 + (153 * (m - 3) + 2) / 5 + d - 719_469;
        days * 86_400_000 + 12 * 3_600_000
    }

    #[test]
    fn sticky_dates_and_footer() {
        let now = noon(2026, 8, 8);
        let label = |c: Option<i64>, short| get_sticky_note_date_label(c, short, now, 0);
        assert_eq!(
            label(Some(noon(2026, 8, 7)), false).as_deref(),
            Some("7 Sep")
        );
        assert_eq!(
            label(Some(noon(2025, 11, 31)), false).as_deref(),
            Some("31 Dec 2025")
        );
        assert_eq!(
            label(Some(noon(2025, 11, 31)), true).as_deref(),
            Some("31 Dec")
        );
        assert_eq!(
            label(Some(noon(2027, 0, 1)), false).as_deref(),
            Some("1 Jan 2027")
        );
        assert_eq!(label(None, false), None);
        assert_eq!(label(Some(8_640_000_000_000_001), false), None);
        let created = noon(2025, 4, 30);
        let footer = |w: f64, h: f64| {
            let mut e = shape(ElementType::StickyNote, 0., 0., w, h);
            e.created = Some(created);
            get_sticky_note_footer(&e, now, 0)
        };
        let year_width = STICKY_NOTE_PADDING * 2. + STICKY_NOTE_FOOTER_MIN_BODY_WIDTH_FOR_YEAR;
        assert_eq!(
            footer(DEFAULT_STICKY_NOTE_SIZE, DEFAULT_STICKY_NOTE_SIZE),
            Some((
                "30 May 2025".into(),
                DEFAULT_STICKY_NOTE_SIZE - STICKY_NOTE_PADDING,
                DEFAULT_STICKY_NOTE_SIZE - STICKY_NOTE_FOOTER_BASELINE_FROM_BOTTOM
            ))
        );
        assert_eq!(footer(year_width, 250.).unwrap().0, "30 May 2025");
        assert_eq!(footer(year_width - 1., 250.).unwrap().0, "30 May");
        assert_eq!(
            footer(STICKY_NOTE_MIN_SIZE, STICKY_NOTE_MIN_SIZE)
                .unwrap()
                .0,
            "30 May"
        );
        assert_eq!(footer(0., 0.), None);
        let mut e = shape(ElementType::StickyNote, 0., 0., 250., 250.);
        e.created = None;
        assert_eq!(get_sticky_note_footer(&e, now, 0), None);
    }

    #[test]
    fn sticky_ink() {
        const RED: &str = "#e03131";
        const BLUE: &str = "#1971c2";
        let pair = |ci: &str, li: &str| {
            let mut c = new_sticky_note_element(
                ElementOpts {
                    width: 250.,
                    height: 250.,
                    stroke_color: ci.into(),
                    ..Default::default()
                },
                Some(250.),
            );
            let l = new_text_element(
                TextOpts {
                    text: "hi".into(),
                    original_text: Some("hi".into()),
                    container_id: Some(c.id.clone()),
                    ..Default::default()
                },
                ElementOpts {
                    stroke_color: li.into(),
                    ..Default::default()
                },
                M,
            );
            bind(&mut c, &l);
            vec![c, l]
        };
        let inks = |els: Vec<Element>| els.into_iter().map(|e| e.stroke_color).collect::<Vec<_>>();
        let els = pair(RED, RED);
        assert_eq!(sync_sticky_note_ink(&els, &array_to_map(&els)), None);
        let prev = pair(RED, RED);
        let pm = array_to_map(&prev);
        let mut a = prev.clone();
        a[0].stroke_color = BLUE.into();
        assert_eq!(inks(sync_sticky_note_ink(&a, &pm).unwrap()), [BLUE, BLUE]);
        let mut b = prev.clone();
        b[1].stroke_color = BLUE.into();
        assert_eq!(inks(sync_sticky_note_ink(&b, &pm).unwrap()), [BLUE, BLUE]);
        let empty: Vec<Element> = vec![];
        assert_eq!(
            inks(sync_sticky_note_ink(&pair(RED, BLUE), &empty).unwrap()),
            [BLUE, BLUE]
        );
        assert_eq!(
            inks(sync_sticky_note_ink(&pair(RED, "transparent"), &empty).unwrap()),
            [RED, RED]
        );
    }

    #[test]
    fn sticky_relayout_in_arrays() {
        setup();
        let (scene, nid, tid) = sticky_with_text("short");
        let mut els = scene.elements_including_deleted().to_vec();
        els[1].text_mut().unwrap().original_text = ["abcdefghijklmnopqrstuvwx"; 40].join("\n");
        let affected: FxHashSet<String> = [tid.clone()].into_iter().collect();
        let out = relayout_sticky_notes(&els, &affected, Some(&scene), M);
        assert!(out[0].height > DEFAULT_STICKY_NOTE_SIZE);
        assert_eq!(out[1].text().unwrap().font_size, STICKY_NOTE_MIN_FONT_SIZE);
        // nothing changed since: skipped
        let same = relayout_sticky_notes(
            scene.elements_including_deleted(),
            &[nid].into_iter().collect(),
            Some(&scene),
            M,
        );
        assert_eq!(same, scene.elements_including_deleted());
    }

    // ---------------------------------------------------------------------------
    // restore.test.ts: refreshDimensions
    // ---------------------------------------------------------------------------

    #[test]
    fn restore_refits_sticky_notes() {
        setup();
        let mut note = shape(ElementType::StickyNote, 0., 0., 250., 250.);
        note.id = "sticky".into();
        let label = text_el(&["abcdefghijklmnopqrstuvwx"; 40].join("\n"), |t, o| {
            t.font_size = Some(28.);
            t.container_id = Some("sticky".into());
            o.id = Some("label".into());
        });
        bind(&mut note, &label);
        let raw = serde_json::Value::Array(vec![
            lattice_board_core::board::json::element_to_value(&note),
            lattice_board_core::board::json::element_to_value(&label),
        ]);
        let opts = RestoreOpts {
            repair_bindings: true,
            refresh_dimensions: Some(M),
            ..Default::default()
        };
        let restored = restore_elements(Some(&raw), None, &opts);
        let (n, t) = (
            restored.iter().find(|e| e.id == "sticky").unwrap(),
            restored.iter().find(|e| e.id == "label").unwrap(),
        );
        assert_eq!(base_height(n), 250.);
        assert!(n.height > 250.);
        assert_eq!(t.text().unwrap().font_size, STICKY_NOTE_MIN_FONT_SIZE);
        assert_eq!(t.text().unwrap().base_font_size, Some(28.));
        assert!(
            (n.height
                - get_sticky_note_layout(n, Some(t), &Default::default(), M)
                    .container
                    .height)
                .abs()
                < 1e-9
        );
    }

    #[test]
    fn restore_refreshes_text_dimensions() {
        setup();
        let mut c = shape(ElementType::Rectangle, 0., 0., 90., 100.);
        let t = text_el("Hello World!", |t, _| t.container_id = Some(c.id.clone()));
        bind(&mut c, &t);
        let raw = serde_json::Value::Array(vec![
            lattice_board_core::board::json::element_to_value(&c),
            lattice_board_core::board::json::element_to_value(&t),
        ]);
        let restored = restore_elements(
            Some(&raw),
            None,
            &RestoreOpts {
                repair_bindings: true,
                refresh_dimensions: Some(M),
                ..Default::default()
            },
        );
        let t = restored[1].text().unwrap();
        assert_eq!(
            (t.text.as_str(), restored[1].width, restored[1].height),
            ("Hello\nWorld!", 60., 50.)
        );
    }

    // ---------------------------------------------------------------------------
    // duplicate.test.tsx: list markers
    // ---------------------------------------------------------------------------

    /// Duplicates of these texts, advanced (the duplicates are the scene).
    fn duplicate(texts: &[&str]) -> Vec<String> {
        setup();
        let els: Vec<Element> = texts
            .iter()
            .enumerate()
            .map(|(i, t)| text_el(t, |_, o| o.y = i as f64 * 100.))
            .collect();
        let ids: Vec<String> = els.iter().map(|e| e.id.clone()).collect();
        let mut scene = Scene::new(els);
        advance_duplicated_list_markers(&ids, &mut scene, M);
        ids.iter()
            .map(|id| {
                let d = txt(&scene, id);
                assert_eq!(d.text, d.original_text);
                d.original_text.clone()
            })
            .collect()
    }

    #[test]
    fn advances_list_markers() {
        for (text, expected) in [
            ("1. foo", "2. foo"),
            ("1) foo", "2) foo"),
            ("(9) foo", "(10) foo"),
            ("[1] foo", "[2] foo"),
            ("09. foo", "10. foo"),
            ("0.", "1."),
            ("  b. foo", "  c. foo"),
            ("A) foo", "B) foo"),
            ("(a) foo", "(b) foo"),
            ("(A) foo", "(B) foo"),
            ("h. foo", "i. foo"),
            ("i. foo", "ii. foo"),
            ("viii) foo", "ix) foo"),
            ("(iv) foo", "(v) foo"),
            ("XXXIX. foo", "XL. foo"),
            ("l. foo", "li. foo"),
            ("1. step\n  a. sub-step", "2. step\n  a. sub-step"),
            ("7", "8"),
            (" 05 ", " 06 "),
            ("41", "42"),
            ("42", "42"),
            ("2024", "2024"),
            ("(41) foo", "(42) foo"),
            ("42. foo", "42. foo"),
            ("1.5 kg", "1.5 kg"),
            ("e.g. foo", "e.g. foo"),
            ("[a] foo", "[a] foo"),
            ("j. foo", "j. foo"),
            ("Ii. foo", "Ii. foo"),
            ("iiii. foo", "iiii. foo"),
            ("xcix. foo", "xcix. foo"),
            ("1. foo\n2. bar", "1. foo\n2. bar"),
        ] {
            assert_eq!(duplicate(&[text]), [expected], "{text:?}");
        }
        assert_eq!(
            duplicate(&["5.", "1.", "3.", "a.", "1", "1"]),
            ["8.", "6.", "7.", "b.", "2", "3"]
        );
        assert_eq!(
            duplicate(&["1. aa", "2. bb", "3. cc"]),
            ["1. aa", "2. bb", "3. cc"]
        );
        assert_eq!(duplicate(&["1. foo", "foo"]), ["1. foo", "foo"]);
        assert_eq!(duplicate(&["g.", "h."]), ["i.", "h."]);
    }

    #[test]
    fn advances_label_markers() {
        for (ty, text, expected) in [
            (ElementType::Rectangle, "9. foo", "10. foo"),
            (ElementType::StickyNote, "9. foo", "10. foo"),
            (ElementType::Ellipse, "3", "4"),
        ] {
            setup();
            let mut c = shape(ty, 0., 0., 100., 100.);
            let t = text_el(text, |t, _| t.container_id = Some(c.id.clone()));
            bind(&mut c, &t);
            let (cid, tid) = (c.id.clone(), t.id.clone());
            let mut scene = Scene::new(vec![c, t]);
            let adv = advance_duplicated_list_markers(&[cid.clone(), tid.clone()], &mut scene, M);
            assert_eq!(txt(&scene, &tid).original_text, expected);
            assert_eq!(adv[0].prev_original_text, text);
            apply_list_marker_advances(&adv, true, &mut scene, M);
            assert_eq!(txt(&scene, &tid).original_text, text);
        }
        // labeled containers continue the list
        setup();
        let mut els = vec![];
        let mut ids = vec![];
        for label in ["1.", "2."] {
            let mut c = shape(ElementType::Rectangle, 0., 0., 100., 100.);
            let t = text_el(label, |t, o| {
                (o.width, o.height) = (50., 20.);
                t.font_size = Some(16.);
                t.container_id = Some(c.id.clone());
            });
            bind(&mut c, &t);
            ids.extend([c.id.clone(), t.id.clone()]);
            els.extend([c, t]);
        }
        let mut scene = Scene::new(els);
        advance_duplicated_list_markers(&ids, &mut scene, M);
        assert_eq!(
            [
                txt(&scene, &ids[1]).original_text.as_str(),
                txt(&scene, &ids[3]).original_text.as_str()
            ],
            ["3.", "4."]
        );
        // along with a non-list element, copied as they are
        setup();
        let r = shape(ElementType::Rectangle, 0., 0., 100., 100.);
        let t = text_el("1. foo", |_, _| {});
        let ids = vec![t.id.clone(), r.id.clone()];
        let mut scene = Scene::new(vec![t, r]);
        assert!(advance_duplicated_list_markers(&ids, &mut scene, M).is_empty());
        assert_eq!(txt(&scene, &ids[0]).original_text, "1. foo");
    }

    // ---------------------------------------------------------------------------
    // resizing (textWysiwyg.test.tsx, stickyNote.test.ts): resize.rs
    // ---------------------------------------------------------------------------

    /// `UI.resize` on one element: down on the handle's center, one move.
    fn ui_resize(scene: &mut Scene, id: &str, h: HandleType, mv: [f64; 2], shift: bool) {
        let original: Vec<Element> = scene.non_deleted_elements().cloned().collect();
        let e = get(scene, id).clone();
        let hc = get_transform_handles(&e, 1., scene, PointerType::Mouse, OmitSides::default())
            .get(h)
            .unwrap();
        let (cx, cy) = (hc[0] + hc[2] / 2., hc[1] + hc[3] / 2.);
        let off = get_resize_offset_xy(Some(h), &[&e], scene, cx, cy);
        let o = TransformOpts {
            maintain_aspect_ratio: shift,
            ..Default::default()
        };
        transform_elements(
            &original,
            h,
            &[id.to_string()],
            scene,
            o,
            [cx + mv[0] - off[0], cy + mv[1] - off[1]],
            [0., 0.],
            M,
            &NO_BINDING_HOOKS,
        );
    }

    #[test]
    fn keeps_width_when_editing_a_wrapped_text() {
        setup();
        let t = text_el("Excalidraw\nEditor", |_, _| {});
        let id = t.id.clone();
        let mut scene = Scene::new(vec![t]);
        let (pw, ph, pt) = (
            get(&scene, &id).width,
            get(&scene, &id).height,
            txt(&scene, &id).text.clone(),
        );
        ui_resize(&mut scene, &id, HandleType::E, [-20., 0.], false);
        let e = get(&scene, &id);
        assert!(
            e.width != pw
                && e.height != ph
                && txt(&scene, &id).text != pt
                && !txt(&scene, &id).auto_resize
        );
        let (ww, wh, wt) = (e.width, e.height, txt(&scene, &id).text.clone());
        let next = format!("{wt} is great!");
        let mut s = edit(&mut scene, &id, true);
        type_text(&mut scene, &mut s, &next);
        exit(&mut scene, &mut s);
        assert_eq!(get(&scene, &id).width, ww);
        assert!(get(&scene, &id).height > wh);
        let mut s = edit(&mut scene, &id, true);
        type_text(&mut scene, &mut s, "");
        type_text(&mut scene, &mut s, &next);
        exit(&mut scene, &mut s);
        assert_eq!(get(&scene, &id).width, ww);
    }

    #[test]
    fn restores_original_text_after_unwrapping() {
        setup();
        let original = "Excalidraw\neditor\nis great!";
        let t = text_el(original, |_, _| {});
        let id = t.id.clone();
        let mut scene = Scene::new(vec![t]);
        ui_resize(&mut scene, &id, HandleType::E, [-40., 0.], false);
        let mut s = edit(&mut scene, &id, true);
        exit(&mut scene, &mut s);
        ui_resize(&mut scene, &id, HandleType::E, [40., 0.], false);
        assert_eq!(txt(&scene, &id).text, original);
        ui_resize(&mut scene, &id, HandleType::E, [-30., 0.], false);
        // upstream types into the editor it got before the first exit, which
        // is detached by then: the two edits open and close the editor only
        for _ in 0..2 {
            let mut s = edit(&mut scene, &id, true);
            exit(&mut scene, &mut s);
        }
        ui_resize(&mut scene, &id, HandleType::E, [30., 0.], false);
        assert_eq!(txt(&scene, &id).text, original);
    }

    #[test]
    fn label_respects_text_alignment_when_resizing() {
        setup();
        let (mut scene, rid) = rect_scene();
        let mut s = start_label(&mut scene, &rid);
        let tid = s.element_id.clone();
        type_text(&mut scene, &mut s, "Hello");
        exit(&mut scene, &mut s);
        let grow = |scene: &mut Scene| {
            let r = get(scene, &rid).clone();
            ui_resize(scene, &rid, HandleType::Ne, [r.x + 100., r.y - 100.], false);
        };
        let at = |scene: &Scene| (get(scene, &tid).x, get(scene, &tid).y);
        grow(&mut scene);
        assert_eq!(at(&scene).0, 85.);
        assert!((at(&scene).1 - 5.).abs() < 1e-5);
        for (align, valign, x, y) in [
            (TextAlign::Left, VerticalAlign::Bottom, 15., 65.),
            (TextAlign::Right, VerticalAlign::Top, 375., -535.),
        ] {
            scene.mutate_element(&tid, true, |e| {
                if let Some(t) = e.text_mut() {
                    (t.text_align, t.vertical_align) = (align, valign);
                }
            });
            let t = get(&scene, &tid).clone();
            redraw_text_bounding_box(&mut scene, &t, Some(&rid), M);
            grow(&mut scene);
            assert!(
                (at(&scene).0 - x).abs() < 1e-5 && (at(&scene).1 - y).abs() < 1e-5,
                "{:?}",
                at(&scene)
            );
        }
    }

    #[test]
    fn label_font_scales_when_resizing_with_shift() {
        setup();
        let (mut scene, rid) = rect_scene();
        let mut s = start_label(&mut scene, &rid);
        let tid = s.element_id.clone();
        type_text(&mut scene, &mut s, "Hello");
        exit(&mut scene, &mut s);
        assert_eq!(
            (
                get(&scene, &rid).width,
                get(&scene, &rid).height,
                txt(&scene, &tid).font_size
            ),
            (90., 75., 20.)
        );
        let r = get(&scene, &rid).clone();
        ui_resize(
            &mut scene,
            &rid,
            HandleType::Ne,
            [r.x + 100., r.y - 50.],
            true,
        );
        assert_eq!(
            (
                get(&scene, &rid).width,
                get(&scene, &rid).height,
                txt(&scene, &tid).font_size
            ),
            (200., 166.66666666666669, 47.5)
        );
    }

    fn overflowing() -> String {
        vec!["abcdefghijklmnopqrstuvwx"; 40].join("\n")
    }
    fn snapshot(scene: &Scene) -> Vec<Element> {
        scene.non_deleted_elements().cloned().collect()
    }
    fn resize1(
        scene: &mut Scene,
        nid: &str,
        w: f64,
        h: f64,
        orig: &[Element],
        handle: HandleType,
        maintain: bool,
        from_center: bool,
    ) {
        let o = orig.iter().find(|e| e.id == nid).unwrap().clone();
        resize_single_element(
            w,
            h,
            nid,
            &o,
            &orig.to_vec(),
            scene,
            handle,
            SingleOpts {
                maintain_aspect_ratio: maintain,
                resize_from_center: from_center,
            },
            M,
            &NO_BINDING_HOOKS,
        );
    }
    fn resize_n(scene: &mut Scene, handle: HandleType, orig: &[Element], o: MultiOpts) {
        let ids: Vec<String> = scene.non_deleted_elements().map(|e| e.id.clone()).collect();
        resize_multiple_elements(
            &ids,
            handle,
            scene,
            &orig.to_vec(),
            &o,
            M,
            &NO_BINDING_HOOKS,
        );
    }
    fn tdata<'a>(scene: &'a Scene, id: &str) -> &'a TextData {
        txt(scene, id)
    }

    #[test]
    fn sticky_north_resize_content_pinned_keeps_bottom() {
        setup();
        let (mut scene, nid, _) = sticky_with_text(&overflowing());
        let orig = snapshot(&scene);
        let o = get(&scene, &nid).clone();
        resize1(
            &mut scene,
            &nid,
            o.width,
            o.height - 100.,
            &orig,
            HandleType::N,
            false,
            false,
        );
        let n = get(&scene, &nid);
        assert!((n.height - o.height).abs() < 0.01 && (n.y - o.y).abs() < 0.01);
        assert!((base_height(n) - (o.height - 100.)).abs() < 0.01);
    }

    #[test]
    fn sticky_corner_resize_content_pinned_keeps_requested_base() {
        setup();
        let (mut scene, nid, tid) = sticky_with_text(&overflowing());
        let orig = snapshot(&scene);
        let mut c = get(&scene, &nid).clone();
        (c.width, c.height) = (120., DEFAULT_STICKY_NOTE_SIZE);
        if let Kind::StickyNote { base_height } = &mut c.kind {
            *base_height = DEFAULT_STICKY_NOTE_SIZE;
        }
        let expected = get_sticky_note_layout(
            &c,
            Some(get(&scene, &tid)),
            &StickyNoteLayoutOpts::default(),
            M,
        );
        let (oy, of, ob) = (
            get(&scene, &nid).y,
            tdata(&scene, &tid).font_size,
            tdata(&scene, &tid).base_font_size,
        );
        resize1(
            &mut scene,
            &nid,
            120.,
            DEFAULT_STICKY_NOTE_SIZE,
            &orig,
            HandleType::Se,
            false,
            false,
        );
        let n = get(&scene, &nid);
        assert_eq!((n.width, base_height(n)), (120., DEFAULT_STICKY_NOTE_SIZE));
        assert!(
            (n.height - expected.container.height).abs() < 0.01
                && n.height > DEFAULT_STICKY_NOTE_SIZE
        );
        assert!((n.y - oy).abs() < 0.01);
        assert_eq!(
            (
                tdata(&scene, &tid).font_size,
                tdata(&scene, &tid).base_font_size
            ),
            (of, ob)
        );
    }

    #[test]
    fn sticky_proportional_resize_scales_note_base_and_ceiling() {
        setup();
        let (mut scene, nid, tid) = sticky_with_text("short");
        let orig = snapshot(&scene);
        resize1(
            &mut scene,
            &nid,
            500.,
            500.,
            &orig,
            HandleType::E,
            true,
            false,
        );
        let n = get(&scene, &nid);
        assert_eq!((n.width, n.height, base_height(n)), (500., 500., 500.));
        assert_eq!(
            (
                tdata(&scene, &tid).base_font_size,
                tdata(&scene, &tid).font_size
            ),
            (Some(STICKY_FONT_SIZE * 2.), STICKY_FONT_SIZE * 2.)
        );
    }

    #[test]
    fn sticky_width_only_drag_keeps_base_of_grown_note() {
        setup();
        let (mut scene, nid, _) = sticky_with_text(&overflowing());
        let orig = snapshot(&scene);
        let h = get(&scene, &nid).height;
        assert!(h > base_height(get(&scene, &nid)));
        resize1(
            &mut scene,
            &nid,
            400.,
            h,
            &orig,
            HandleType::E,
            false,
            false,
        );
        let n = get(&scene, &nid);
        assert_eq!(
            (n.width, base_height(n), n.y),
            (400., DEFAULT_STICKY_NOTE_SIZE, 100.)
        );
        assert!(n.height > base_height(n));
    }

    #[test]
    fn sticky_shift_release_restores_gesture_start_base_and_ceiling() {
        setup();
        let (mut scene, nid, tid) = sticky_with_text("short");
        let orig = snapshot(&scene);
        resize1(
            &mut scene,
            &nid,
            500.,
            500.,
            &orig,
            HandleType::Se,
            true,
            false,
        );
        assert_eq!(
            (
                base_height(get(&scene, &nid)),
                tdata(&scene, &tid).base_font_size
            ),
            (500., Some(STICKY_FONT_SIZE * 2.))
        );
        resize1(
            &mut scene,
            &nid,
            400.,
            300.,
            &orig,
            HandleType::Se,
            false,
            false,
        );
        assert_eq!(
            (get(&scene, &nid).width, base_height(get(&scene, &nid))),
            (400., 300.)
        );
        assert_eq!(
            (
                tdata(&scene, &tid).base_font_size,
                tdata(&scene, &tid).font_size
            ),
            (Some(STICKY_FONT_SIZE), STICKY_FONT_SIZE)
        );
        resize1(
            &mut scene,
            &nid,
            350.,
            DEFAULT_STICKY_NOTE_SIZE,
            &orig,
            HandleType::E,
            false,
            false,
        );
        assert_eq!(base_height(get(&scene, &nid)), DEFAULT_STICKY_NOTE_SIZE);
    }

    #[test]
    fn sticky_rotated_flip_keeps_grown_height_and_label_angle() {
        setup();
        let (mut scene, nid, tid) = sticky_with_text(&overflowing());
        scene.mutate_element(&nid, true, |e| e.angle = 0.5);
        scene.mutate_element(&tid, true, |e| e.angle = 0.5);
        let grown = get(&scene, &nid).height;
        assert!(grown > base_height(get(&scene, &nid)));
        let orig = snapshot(&scene);
        resize_n(
            &mut scene,
            HandleType::Nw,
            &orig,
            MultiOpts {
                flip_by_x: true,
                resize_from_center: true,
                maintain_aspect_ratio: true,
                ..Default::default()
            },
        );
        let (n, t) = (get(&scene, &nid), get(&scene, &tid));
        assert_eq!(base_height(n), DEFAULT_STICKY_NOTE_SIZE);
        assert!((n.height - grown).abs() < 0.01);
        assert_eq!(tdata(&scene, &tid).base_font_size, Some(STICKY_FONT_SIZE));
        assert!((n.angle - 0.5).abs() > 0.01);
        assert!((t.angle - n.angle).abs() < 0.01);
    }

    fn empty_note_and_rect(rect_h: f64) -> (Scene, String) {
        let n = new_sticky_note_element(
            ElementOpts {
                width: DEFAULT_STICKY_NOTE_SIZE,
                height: DEFAULT_STICKY_NOTE_SIZE,
                ..Default::default()
            },
            Some(DEFAULT_STICKY_NOTE_SIZE),
        );
        let r = new_element(
            ElementType::Rectangle,
            ElementOpts {
                x: 300.,
                width: 100.,
                height: rect_h,
                ..Default::default()
            },
        );
        let id = n.id.clone();
        (Scene::new(vec![n, r]), id)
    }

    #[test]
    fn sticky_empty_note_syncs_base_on_multi_resize() {
        setup();
        let (mut scene, nid) = empty_note_and_rect(100.);
        let orig = snapshot(&scene);
        resize_n(
            &mut scene,
            HandleType::Se,
            &orig,
            MultiOpts {
                next_width: Some(800.),
                next_height: Some(500.),
                ..Default::default()
            },
        );
        assert_eq!(
            (get(&scene, &nid).height, base_height(get(&scene, &nid))),
            (500., 500.)
        );
        // free resize: the requested height is the base
        setup();
        let (mut scene, nid) = empty_note_and_rect(DEFAULT_STICKY_NOTE_SIZE);
        let orig = snapshot(&scene);
        resize_n(
            &mut scene,
            HandleType::Se,
            &orig,
            MultiOpts {
                next_width: Some(800.),
                next_height: Some(375.),
                ..Default::default()
            },
        );
        let n = get(&scene, &nid);
        assert_eq!((n.width, n.height, base_height(n)), (500., 375., 375.));
    }

    #[test]
    fn sticky_center_resize_content_pinned_keeps_center() {
        setup();
        let (mut scene, nid, _) = sticky_with_text(&overflowing());
        let orig = snapshot(&scene);
        let o = get(&scene, &nid).clone();
        let cy = o.y + o.height / 2.;
        for h in [HandleType::N, HandleType::S] {
            resize1(
                &mut scene,
                &nid,
                o.width,
                o.height - 100.,
                &orig,
                h,
                false,
                true,
            );
            let n = get(&scene, &nid);
            assert!((n.height - o.height).abs() < 0.01 && (n.y + n.height / 2. - cy).abs() < 0.01);
            assert!((base_height(n) - (o.height - 100.)).abs() < 0.01);
        }
    }

    #[test]
    fn sticky_proportional_multi_resize_scales_ceiling() {
        setup();
        let (mut scene, nid, tid) = sticky_with_text("short");
        scene.insert_element(new_element(
            ElementType::Rectangle,
            ElementOpts {
                x: 400.,
                y: 100.,
                width: 100.,
                height: DEFAULT_STICKY_NOTE_SIZE,
                ..Default::default()
            },
        ));
        let orig = snapshot(&scene);
        resize_n(
            &mut scene,
            HandleType::Se,
            &orig,
            MultiOpts {
                next_width: Some(800.),
                next_height: Some(500.),
                maintain_aspect_ratio: true,
                ..Default::default()
            },
        );
        let n = get(&scene, &nid);
        assert_eq!((n.width, n.height, base_height(n)), (500., 500., 500.));
        assert_eq!(
            (
                tdata(&scene, &tid).base_font_size,
                tdata(&scene, &tid).font_size
            ),
            (Some(STICKY_FONT_SIZE * 2.), STICKY_FONT_SIZE * 2.)
        );
    }

    #[test]
    fn sticky_proportional_gesture_back_to_scale_one_restores() {
        setup();
        let (mut scene, nid, tid) = sticky_with_text("short");
        let orig = snapshot(&scene);
        resize1(
            &mut scene,
            &nid,
            500.,
            500.,
            &orig,
            HandleType::Se,
            true,
            false,
        );
        resize1(
            &mut scene,
            &nid,
            DEFAULT_STICKY_NOTE_SIZE,
            DEFAULT_STICKY_NOTE_SIZE,
            &orig,
            HandleType::Se,
            true,
            false,
        );
        let n = get(&scene, &nid);
        assert_eq!(
            (n.width, base_height(n)),
            (DEFAULT_STICKY_NOTE_SIZE, DEFAULT_STICKY_NOTE_SIZE)
        );
        assert_eq!(
            (
                tdata(&scene, &tid).base_font_size,
                tdata(&scene, &tid).font_size
            ),
            (Some(STICKY_FONT_SIZE), STICKY_FONT_SIZE)
        );
    }

    #[test]
    fn sticky_never_resizes_below_one_line_plus_footer() {
        setup();
        let (mut scene, nid, _) = sticky_with_text("A");
        let orig = snapshot(&scene);
        let min = get_sticky_note_min_size(STICKY_FONT_SIZE, font_family::EXCALIFONT);
        assert_eq!(min, (STICKY_NOTE_MIN_SIZE, 35. + STICKY_NOTE_BODY_INSET_Y));
        resize1(
            &mut scene,
            &nid,
            40.,
            40.,
            &orig,
            HandleType::Se,
            false,
            false,
        );
        let n = get(&scene, &nid);
        assert_eq!((n.width, base_height(n), n.height), (min.0, min.1, min.1));
    }

    #[test]
    fn sticky_proportional_corner_flips_over_the_far_side() {
        setup();
        let (mut scene, nid, tid) = sticky_with_text("A");
        let orig = snapshot(&scene);
        resize1(
            &mut scene,
            &nid,
            400.,
            -400.,
            &orig,
            HandleType::Se,
            true,
            false,
        );
        let (n, t) = (get(&scene, &nid), get(&scene, &tid));
        assert_eq!(
            (n.width, n.height, n.x, n.y),
            (400., 400., 100., 100. - 400.)
        );
        assert!(
            (tdata(&scene, &tid).base_font_size.unwrap() - STICKY_FONT_SIZE * 400. / 250.).abs()
                < 0.01
        );
        assert_eq!(t.angle, 0.);
        assert!(t.y > n.y && t.y + t.height < n.y + n.height);
    }

    #[test]
    fn sticky_proportional_shrink_stays_proportional_at_minimum() {
        setup();
        let (mut scene, nid, _) = sticky_with_text("A");
        let orig = snapshot(&scene);
        resize1(
            &mut scene,
            &nid,
            60.,
            60.,
            &orig,
            HandleType::Se,
            true,
            false,
        );
        let n = get(&scene, &nid);
        assert!((n.width - n.height).abs() < 0.01 && n.height >= 35. + STICKY_NOTE_BODY_INSET_Y);
    }

    #[test]
    fn sticky_free_edge_resize_flips_and_clamps_magnitude() {
        setup();
        let (mut scene, nid, _) = sticky_with_text("A");
        let orig = snapshot(&scene);
        let h = get(&scene, &nid).height;
        resize1(
            &mut scene,
            &nid,
            -300.,
            h,
            &orig,
            HandleType::E,
            false,
            false,
        );
        let n = get(&scene, &nid);
        assert_eq!(
            (n.width, n.height, n.x),
            (300., DEFAULT_STICKY_NOTE_SIZE, 100. - 300.)
        );
        setup();
        let (mut scene, nid, _) = sticky_with_text("A");
        let orig = snapshot(&scene);
        resize1(
            &mut scene,
            &nid,
            -10.,
            h,
            &orig,
            HandleType::E,
            false,
            false,
        );
        let n = get(&scene, &nid);
        assert_eq!(
            (n.width, n.x),
            (STICKY_NOTE_MIN_SIZE, 100. - STICKY_NOTE_MIN_SIZE)
        );
    }
}
