// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! The board's fonts: `FONT_METADATA` metrics and the alphabetic baseline
//! (`packages/common/src/font-metadata.ts` `getVerticalOffset`, used by
//! `renderElement` / `staticSvgScene` @ 3a317b5), family strings
//! (`getFontFamilyString`), and SVG export's inlined fonts
//! (`Fonts.generateFontFaceDeclarations`) with our TrueType subsetter
//! standing in for upstream's HarfBuzz one. Expected values are worked out
//! by hand from upstream's formulas and the font files.

mod board {
    use lattice_board_core::board::consts::{
        DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, font_family as ff,
    };
    use lattice_board_core::board::display::{Paint, text_run};
    use lattice_board_core::board::export_svg::{SvgExportOpts, export_to_svg};
    use lattice_board_core::board::font_subset::{covers, mapped_chars, subset};
    use lattice_board_core::board::new_element::{ElementOpts, TextOpts, new_text_element};
    use lattice_board_core::board::text_measure::*;
    use lattice_board_core::board::types::TextAlign;

    // Lattice bundles the fonts with the view crate, and not Xiaolai.
    static EXCALIFONT: &[u8] =
        include_bytes!("../../lattice-board/assets/fonts/excalidraw/Excalifont-Regular.ttf");
    static NUNITO: &[u8] =
        include_bytes!("../../lattice-board/assets/fonts/excalidraw/Nunito-Medium.ttf");

    fn close(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "{a} != {b}");
    }

    fn u16_at(d: &[u8], o: usize) -> u16 {
        u16::from_be_bytes([d[o], d[o + 1]])
    }
    /// A table of a font file.
    fn table<'a>(font: &'a [u8], tag: &[u8; 4]) -> &'a [u8] {
        let n = u16_at(font, 4) as usize;
        let r = (0..n)
            .map(|i| 12 + i * 16)
            .find(|&r| &font[r..r + 4] == tag)
            .expect("table");
        let at = |o: usize| u32::from_be_bytes(font[o..o + 4].try_into().unwrap()) as usize;
        &font[at(r + 8)..at(r + 8) + at(r + 12)]
    }

    #[test]
    fn defaults_are_upstreams() {
        assert_eq!(
            (DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE),
            (ff::EXCALIFONT, 20.)
        );
    }

    /// The bundled fonts carry the `hhea` / `head` metrics `FONT_METADATA`
    /// lists for them (Assistant excepted: upstream lists 2048 units per em
    /// for a 1000-unit font, and is followed).
    #[test]
    fn metadata_matches_the_fonts() {
        for (font, family) in [(EXCALIFONT, ff::EXCALIFONT), (NUNITO, ff::NUNITO)] {
            let m = font_metrics(family);
            let (head, hhea) = (table(font, b"head"), table(font, b"hhea"));
            assert_eq!(u16_at(head, 18) as f64, m.units_per_em);
            assert_eq!(u16_at(hhea, 4) as i16 as f64, m.ascender);
            assert_eq!(u16_at(hhea, 6) as i16 as f64, m.descender);
        }
        assert_eq!(
            font_metrics(ff::ASSISTANT),
            FontMetrics {
                units_per_em: 2048.,
                ascender: 1021.,
                descender: -287.,
                line_height: 1.25
            }
        );
    }

    #[test]
    fn vertical_offset() {
        // fontSize / unitsPerEm * ascender + (lineHeightPx - em * ascender + em * descender) / 2
        close(get_vertical_offset(ff::EXCALIFONT, 20., 25.), 17.62);
        close(get_vertical_offset(ff::VIRGIL, 20., 25.), 17.62);
        close(get_vertical_offset(ff::NUNITO, 20., 25.), 19.08);
        close(get_vertical_offset(ff::LILITA_ONE, 20., 23.), 18.53);
        close(get_vertical_offset(ff::HELVETICA, 20., 23.), 16.900390625);
        close(get_vertical_offset(ff::CASCADIA, 20., 24.), 18.93359375);
        close(get_vertical_offset(ff::COMIC_SHANNS, 20., 25.), 17.5);
        // unknown families take Excalifont's
        close(get_vertical_offset(42, 20., 25.), 17.62);
        assert_eq!(
            [ff::EXCALIFONT, ff::LILITA_ONE, ff::CASCADIA, ff::HELVETICA].map(get_line_height),
            [1.25, 1.15, 1.2, 1.15]
        );
    }

    /// Display lines sit at `i * lineHeightPx + verticalOffset`, as upstream's
    /// `fillText` calls.
    #[test]
    fn text_lines_take_the_baseline() {
        let run = text_run(
            "one\ntwo",
            100.,
            ff::EXCALIFONT,
            20.,
            1.25,
            TextAlign::Center,
            Paint::CanvasBackground,
        );
        let lines: Vec<_> = run.lines.iter().map(|l| (l.x, l.top, l.baseline)).collect();
        assert_eq!(lines.len(), 2);
        close(lines[0].0, 50.);
        close(lines[0].2, 17.62);
        close(lines[1].1, 25.);
        close(lines[1].2, 42.62);
    }

    #[test]
    fn family_strings() {
        assert_eq!(
            get_font_family_string(ff::EXCALIFONT),
            "Excalifont, Xiaolai, sans-serif, Segoe UI Emoji"
        );
        assert_eq!(
            get_font_family_string(ff::VIRGIL),
            "Virgil, sans-serif, Segoe UI Emoji"
        );
        assert_eq!(
            get_font_family_string(ff::CASCADIA),
            "Cascadia, monospace, Segoe UI Emoji"
        );
        assert_eq!(
            get_font_family_string(ff::COMIC_SHANNS),
            "Comic Shanns, monospace, Segoe UI Emoji"
        );
        assert_eq!(
            get_font_family_string(ff::LILITA_ONE),
            "Lilita One, sans-serif, Segoe UI Emoji"
        );
        assert_eq!(get_font_family_string(7777), "Segoe UI Emoji");
        assert_eq!(
            Font::new(20., ff::HELVETICA).css(),
            "20px Helvetica, sans-serif, Segoe UI Emoji"
        );
    }

    /// A subset maps exactly the asked characters, to the same outlines and
    /// advances; keeping the layout keeps glyph ids.
    #[test]
    fn subsets_keep_the_asked_glyphs() {
        for (font, chars, keep) in [
            (EXCALIFONT, "Hello, wörld!", true),
            (NUNITO, "Hello, wörld!", false),
        ] {
            let chars: Vec<char> = chars.chars().collect();
            let sub = subset(font, &chars, keep).unwrap();
            assert!(
                sub.len() < font.len() / 2,
                "{} of {}",
                sub.len(),
                font.len()
            );
            let mut got = mapped_chars(&sub);
            got.sort();
            let mut want: Vec<char> = chars.iter().copied().filter(|&c| covers(font, c)).collect();
            want.sort();
            want.dedup();
            assert_eq!(got, want);
            assert!(!covers(&sub, 'Z') && !covers(&sub, '中'));
            // advances survive
            let adv = |f: &[u8], c: char| {
                let g = cmap_glyph(f, c);
                let hm = u16_at(table(f, b"hhea"), 34) as usize;
                u16_at(table(f, b"hmtx"), g.min(hm - 1) * 4)
            };
            // (the source's advance through a one-character subset)
            for &c in &want {
                assert_eq!(
                    adv(&sub, c),
                    adv(&subset(font, &[c], false).unwrap(), c),
                    "{c}"
                );
            }
        }
        assert!(
            subset(EXCALIFONT, &['中'], true).is_none(),
            "nothing to keep"
        );
    }

    /// A character's glyph in a subset (its format 12 `cmap`).
    fn cmap_glyph(font: &[u8], c: char) -> usize {
        let cmap = table(font, b"cmap");
        let n = u16_at(cmap, 2) as usize;
        for i in 0..n {
            let off =
                u32::from_be_bytes(cmap[4 + i * 8 + 4..4 + i * 8 + 8].try_into().unwrap()) as usize;
            let t = &cmap[off..];
            if u16_at(t, 0) != 12 {
                continue;
            }
            let groups = u32::from_be_bytes(t[12..16].try_into().unwrap()) as usize;
            for g in 0..groups {
                let r = |k: usize| {
                    u32::from_be_bytes(t[16 + g * 12 + k..16 + g * 12 + k + 4].try_into().unwrap())
                };
                if (r(0)..=r(4)).contains(&(c as u32)) {
                    return (r(8) + c as u32 - r(0)) as usize;
                }
            }
        }
        panic!("{c} not mapped")
    }

    fn source(family: u32) -> Option<&'static [u8]> {
        match family {
            ff::EXCALIFONT => Some(EXCALIFONT),
            ff::NUNITO => Some(NUNITO),
            _ => None,
        }
    }

    /// `generateFontFaceDeclarations`: the families in scene order; local
    /// families, and Xiaolai, which Lattice doesn't bundle, left out.
    #[test]
    fn svg_export_inlines_fonts() {
        set_font_source(source);
        let text = |s: &str, family: u32, x: f64| {
            new_text_element(
                TextOpts {
                    text: s.into(),
                    font_family: Some(family),
                    ..Default::default()
                },
                ElementOpts {
                    x,
                    ..Default::default()
                },
                &TestMeasure,
            )
        };
        let els = vec![
            text("Hi 你好", ff::EXCALIFONT, 0.),
            text("Yo", ff::NUNITO, 100.),
            text("Helv", ff::HELVETICA, 200.),
        ];
        let svg = export_to_svg(
            &els,
            &Default::default(),
            &TestMeasure,
            &SvgExportOpts::default(),
        );
        let style = &svg
            [svg.find(r#"<style class="style-fonts">"#).unwrap()..svg.find("</style>").unwrap()];
        let names: Vec<&str> = style
            .match_indices("font-family: ")
            .map(|(i, _)| style[i + 13..].split(';').next().unwrap())
            .collect();
        assert_eq!(names, ["Excalifont", "Nunito"]);
        assert!(style.contains("src: url(data:font/ttf;base64,"));
        assert!(svg.contains(r#"font-family="Excalifont, Xiaolai, sans-serif, Segoe UI Emoji""#));
        // the style goes into <defs>; an SVG without text has an empty one
        let empty = export_to_svg(
            &[],
            &Default::default(),
            &TestMeasure,
            &SvgExportOpts::default(),
        );
        assert!(
            empty.contains("<defs><style class=\"style-fonts\">\n      </style></defs>"),
            "{empty}"
        );
    }
}
