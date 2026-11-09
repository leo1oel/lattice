use super::render::convert_args;
use super::svg_links::check_svg_links;
use super::*;
use crate::project::test_support::Fixture;
use std::ffi::OsString;

/// Stands in for the installed program: writes what it would, beside `pdf`.
fn fake_render(tool: Tool, _source: &Path, pdf: &Path, _page: u32) -> Result<(), String> {
    fs::write(pdf, "%PDF /MediaBox [0 0 300 200]").unwrap();
    if tool == Tool::Inkscape {
        let mut pdf_tex = pdf.as_os_str().to_owned();
        pdf_tex.push("_tex");
        fs::write(pdf_tex, "\\setlength{\\unitlength}{300bp}%\n\\begin{picture}(1,0.5)%\n")
            .unwrap();
    }
    Ok(())
}

#[test]
fn knows_each_drawing_format_and_no_other() {
    assert_eq!(tool_for(Path::new("a.SVG")), Some(Tool::Inkscape));
    assert_eq!(tool_for(Path::new("a.drawio")), Some(Tool::DrawIo));
    assert_eq!(tool_for(Path::new("a.dio")), Some(Tool::DrawIo));
    assert_eq!(tool_for(Path::new("a.reactio")), None);
    assert_eq!(tool_for(Path::new("a")), None);
}

#[test]
fn builds_each_command_with_paths_as_single_arguments() {
    let args = convert_args(Tool::Inkscape, Path::new("/p/a b.svg"), Path::new("/p/a_b.pdf"), 1);
    assert_eq!(args[0], "/p/a b.svg");
    assert!(args.contains(&OsString::from("--export-latex")));
    assert!(args.contains(&OsString::from("--export-area-drawing")));
    assert!(args.contains(&OsString::from("--export-filename=/p/a_b.pdf")));
    let args = convert_args(Tool::DrawIo, Path::new("/p/a.drawio"), Path::new("/p/a.pdf"), 3);
    assert_eq!(args.last().unwrap(), "/p/a.drawio");
    assert!(args.windows(2).any(|pair| pair[0] == "-o" && pair[1] == "/p/a.pdf"));
    assert!(args.windows(2).any(|pair| pair[0] == "-p" && pair[1] == "3"));
}

#[test]
fn a_file_named_like_an_option_reaches_the_program_as_a_path() {
    let fixture = Fixture::project("figure-dash-name");
    fixture.write("figures/--export-type=png.svg", "<svg/>");
    let figure = figure_of(&fixture.root, "figures/--export-type=png.svg").unwrap();
    assert!(figure.source.is_absolute());
    assert_eq!(figure.stem, "export-type_png");
    for tool in [Tool::Inkscape, Tool::DrawIo] {
        let args = convert_args(tool, &figure.source, Path::new("/s/x.pdf"), 1);
        assert!(args.iter().all(|arg| !arg.to_string_lossy().starts_with("--export-type=png")));
    }
}

#[test]
fn the_page_line_gives_only_a_number() {
    let entry = |line: &str| {
        format!("% editable-figure source: a.drawio\n% editable-figure page: {line}\n")
    };
    assert_eq!(chosen_page(&entry("2 --remote-debugging-port=9222")), 2);
    assert_eq!(chosen_page(&entry("-x 3")), 1);
    assert_eq!(chosen_page(&entry("0")), 1);
    assert_eq!(chosen_page(&entry("99999999999")), 1);
}

#[test]
fn a_page_name_cannot_end_the_comment_line() {
    let drawing = "<mxfile><diagram name=\"A\n\\input{/etc/passwd}\"></diagram><diagram name=\"B\u{2028}x\"></diagram></mxfile>";
    let line = page_line(1, &diagram_names(drawing));
    assert_eq!(line.matches('\n').count(), 1);
    assert!(line.ends_with('\n') && !line.contains('\u{2028}'));
}

#[test]
fn names_that_would_break_the_entry_are_refused() {
    // Windows cannot name a file so.
    #[cfg(unix)]
    {
        let fixture = Fixture::project("figure-unsafe-names");
        fixture.write("figures/a\nb.svg", "<svg/>");
        assert!(figure_of(&fixture.root, "figures/a\nb.svg").unwrap_err().starts_with("Rename "));
        fixture.write("x}\\def{/a.svg", "<svg/>");
        assert!(figure_of(&fixture.root, "x}\\def{/a.svg").is_err());
    }
    assert!(!stays_on_line("a\nb.svg") && !tex_safe("x}\\def{"));
    assert_eq!(copy_name("-R&D {draft}\u{2028}.SVG"), "R_D _draft__.svg");
    assert_eq!(copy_name(".hidden.drawio"), "hidden.drawio");
}

#[test]
fn writes_the_entry_for_each_tool() {
    assert_eq!(
        entry_text(Tool::DrawIo, "a.drawio", "figures", "a", "", None),
        "% editable-figure source: a.drawio\n\\includegraphics{a.pdf}\n"
    );
    assert_eq!(
        entry_text(Tool::Inkscape, "my a.svg", "figures", "my_a", "", None),
        "% editable-figure source: my a.svg\n\\input{figures/my_a.pdf_tex}\n"
    );
    assert_eq!(figure_stem(OsStr::new("My scheme.v2.drawio")), "My_scheme.v2");
}

#[test]
fn makes_a_figure_from_what_the_program_wrote() {
    let fixture = Fixture::project("figure-convert");
    fixture.write("figures/a.svg", "<svg/>");
    let figure = convert(&fixture.root, "figures/a.svg", &fake_render).unwrap();
    assert_eq!((figure.directory.as_str(), figure.entry.as_str()), ("figures", "a.tex"));
    assert!(fixture.read("figures/a.tex").starts_with("% editable-figure source: a.svg\n"));
    assert!(fixture.path("figures/a.pdf").is_file() && fixture.path("figures/a.pdf_tex").is_file());
    // The second time it is the figure's own: the same files, rendered again.
    let again = convert(&fixture.root, "figures/a.svg", &fake_render).unwrap();
    assert_eq!(again.entry, "a.tex");
    assert_eq!(refresh(&fixture.root, "figures/a.svg", &fake_render), Ok(FigureRefresh::Rendered));
    assert_eq!(fixture.read("figures/a.svg"), "<svg/>");
    let leftovers = fs::read_dir(fixture.path("figures")).unwrap().count();
    assert_eq!(leftovers, 4, "no .part files stay behind");
}

#[test]
fn a_pasted_file_must_be_a_drawing_with_a_plain_name() {
    let fixture = Fixture::project("figure-paste-file");
    assert!(import_drawing_file(&fixture.root, "run.command", "eA==").is_err());
    assert!(import_drawing_file(&fixture.root, "../a.svg", "eA==").is_err());
    assert!(!fixture.root.join("figures/run.command").exists());
    let huge = "A".repeat((MAX_DRAWING_BYTES as usize) / 3 * 4 + 64);
    assert_eq!(import_drawing_file(&fixture.root, "a.svg", &huge).unwrap_err(), TOO_LARGE);
}

#[test]
fn a_dropped_file_must_be_a_drawing() {
    let fixture = Fixture::project("figure-drop");
    let script = fixture.outside("run.command", "#!/bin/sh");
    assert!(import_drawing_path(&fixture.root, &script.to_string_lossy()).is_err());
    assert!(!fixture.root.join("figures/run.command").exists());
    assert!(import_drawing_path(&fixture.root, "figures/a.svg").is_err(), "relative");
    fs::create_dir_all(fixture.parent.join("folder.svg")).unwrap();
    assert!(import_drawing_path(
        &fixture.root,
        &fixture.parent.join("folder.svg").to_string_lossy()
    )
    .is_err());
}

#[test]
fn asks_for_colour_packages_only_when_the_text_uses_them() {
    let fallback = "  \\providecommand\\color[2][]{%\n  \\providecommand\\transparent[1]{%\n";
    assert_eq!(pdf_tex_packages(fallback), ["graphicx"]);
    let used = format!("{fallback}\\put(0,0){{\\color[rgb]{{1,0,0}}\\transparent{{0.5}}A}}\n");
    assert_eq!(pdf_tex_packages(&used), ["graphicx", "xcolor", "transparent"]);
}

#[test]
fn reads_a_drawings_pages_and_the_chosen_one() {
    let drawing =
        r#"<mxfile><diagram id="1" name="First"></diagram><diagram name="Two"></diagram></mxfile>"#;
    let names = diagram_names(drawing);
    assert_eq!(names, ["First", "Two"]);
    let line = page_line(2, &names);
    assert_eq!(line, "% editable-figure page: 2 (of 2: First, Two)\n");
    assert_eq!(chosen_page(&format!("% editable-figure source: a.drawio\n{line}x")), 2);
    assert_eq!(chosen_page("% editable-figure source: a.svg\n\\input{a}"), 1);
    assert_eq!(page_line(1, &names[..1]), "");
}

#[test]
fn keeps_a_figure_inside_the_line_and_the_page() {
    let size = pdf_tex_size("\\setlength{\\unitlength}{600bp}%\n\\begin{picture}(1,1.5)%").unwrap();
    assert_eq!(size, NaturalSize { width: 600.0, height: 900.0 });
    assert_eq!(pdf_tex_size("nothing"), None);
    assert_eq!(pdf_tex_size("\\setlength{\\unitlength}{600bp}%\n\\begin{picture}(1,0)%"), None);
    assert_eq!(
        pdf_size(b"x /MediaBox [0 0 612 792] y"),
        Some(NaturalSize { width: 612.0, height: 792.0 })
    );
    assert_eq!(pdf_size(b"nothing"), None);
    assert_eq!(pdf_size(b"/MediaBox [0 0 inf 1]"), None);
    let inkscape = entry_text(Tool::Inkscape, "a.svg", "f", "a", "", Some(size));
    assert!(inkscape
        .contains("\\ifdim\\linewidth<0.5333\\textheight\\linewidth\\else0.5333\\textheight\\fi"));
    assert!(inkscape.contains(
        "\\ifdim 600bp>\\figuremaxwidth\\let\\svgwidth\\figuremaxwidth\\fi\n\\input{f/a.pdf_tex}"
    ));
    let drawio = entry_text(Tool::DrawIo, "a.drawio", "f", "a", "", Some(size));
    assert!(drawio.contains(
        "\\includegraphics[width=\\figuremaxwidth]{a.pdf}\\else\\includegraphics{a.pdf}\\fi"
    ));
}

#[test]
fn leaves_files_of_the_same_name_alone() {
    let fixture = Fixture::project("figure-taken");
    let root = &fixture.root;
    let folder = fixture.root.join("figures");
    fixture.write("figures/a.svg", "<svg/>");
    assert_eq!(figure_slot(root, &folder, "a", "a.svg"), Ok(("a".to_string(), false)));
    for foreign in ["a.pdf", "a.tex", "a.pdf_tex"] {
        fixture.write(&format!("figures/{foreign}"), "someone else's");
        assert_eq!(figure_slot(root, &folder, "a", "a.svg"), Ok(("a-2".to_string(), false)));
    }
    fixture.write("figures/a-2.tex", "% editable-figure source: a.svg\nx\n");
    assert_eq!(figure_slot(root, &folder, "a", "a.svg"), Ok(("a-2".to_string(), true)));
    // LaTeX finds the project root's b.pdf before figures/b.pdf.
    fixture.write("b.pdf", "x");
    assert_eq!(figure_slot(root, &folder, "b", "b.svg"), Ok(("b-2".to_string(), false)));
    fixture.write("figures/c.pdf", "x");
    assert!(save_drawing(root, "c.svg", b"<svg/>").unwrap().ends_with("c-2.svg"));
}

#[test]
fn refreshes_only_a_drawing_an_entry_names_inside_the_project() {
    let fixture = Fixture::project("figure-converters");
    let refreshed = |source| refresh(&fixture.root, source, &fake_render);
    fixture.write("figures/plain.svg", "<svg/>");
    assert_eq!(refreshed("figures/plain.svg"), Ok(FigureRefresh::NoFigure));
    fixture.write("figures/a.tex", "\\section{Not a figure}");
    fixture.write("figures/a.svg", "<svg/>");
    assert_eq!(refreshed("figures/a.svg"), Ok(FigureRefresh::NoFigure));
    assert!(refreshed("../a.svg").is_err());
    assert!(refreshed("figures/a.tex").is_err());
}

#[test]
fn an_svg_reads_nothing_outside_the_project() {
    let fixture = Fixture::project("figure-svg-links");
    let root = &fixture.root;
    fixture.write("figures/inside.png", "png");
    let svg =
        |body: &str| format!("<svg xmlns:xlink=\"http://www.w3.org/1999/xlink\">{body}</svg>");
    for safe in [
        "<use xlink:href=\"#shape\"/>",
        "<image href=\"inside.png\"/>",
        "<image href='./inside.png'/>",
        "<image href=\"missing/new.png\"/>",
        "<image xlink:href=\"data:image/png;base64,iVBOR\"/>",
        "<rect style=\"fill:url(#grad)\"/>",
        "<a xlink:href=\"https://example.com\"><text>a link, not a fetch</text></a>",
    ] {
        assert_eq!(check_svg_links(root, "figures", svg(safe).as_bytes()), Ok(()), "{safe}");
    }
    for unsafe_link in [
        "<image href=\"/Users/me/.ssh/id_rsa.png\"/>",
        "<image xlink:href=\"file:///etc/passwd\"/>",
        "<image xlink:href=\"https://tracker.example/p.png\"/>",
        "<image href=\"../../secret.png\"/>",
        "<image href=\"~/secret.png\"/>",
        "<image href=\"%2e%2e/%2e%2e/secret.png\"/>",
        "<image href=\"C:\\secret.png\"/>",
        "<image href=\"&#102;ile:///etc/passwd\"/>",
        "<image href=\"x.png\" sodipodi:absref=\"/etc/passwd\"/>",
        "<image href=\"data:image/svg+xml;base64,PHN2Zz4=\"/>",
        "<rect style=\"fill:url('file:///etc/passwd')\"/>",
        "<style>@import \"/etc/x.css\";</style>",
        "<style>@import url(https://example.com/x.css);</style>",
    ] {
        assert!(check_svg_links(root, "figures", svg(unsafe_link).as_bytes()).is_err(), "{unsafe_link}");
    }
    let entity =
        "<!DOCTYPE svg [<!ENTITY x SYSTEM \"file:///etc/passwd\">]><svg><text>&x;</text></svg>";
    assert!(check_svg_links(root, "figures", entity.as_bytes()).is_err());
}

#[cfg(unix)]
mod links {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn an_svg_link_through_a_project_symlink_is_refused() {
        let fixture = Fixture::project("figure-svg-symlink");
        let secret = fixture.outside("secret.png", "secret");
        fs::create_dir_all(fixture.path("figures")).unwrap();
        symlink(&secret, fixture.path("figures/leak.png")).unwrap();
        let svg = "<svg><image href=\"leak.png\"/></svg>";
        assert!(check_svg_links(&fixture.root, "figures", svg.as_bytes()).is_err());
        symlink(fixture.parent.clone(), fixture.path("figures/up")).unwrap();
        let svg = "<svg><image href=\"up/secret.png#x\"/></svg>";
        assert!(check_svg_links(&fixture.root, "figures", svg.as_bytes()).is_err());
    }

    #[test]
    fn a_linked_drawing_is_never_rendered() {
        let fixture = Fixture::project("figure-linked-source");
        let outside = fixture.outside("elsewhere.svg", "<svg/>");
        fs::create_dir_all(fixture.path("figures")).unwrap();
        symlink(&outside, fixture.path("figures/a.svg")).unwrap();
        assert!(convert(&fixture.root, "figures/a.svg", &fake_render).is_err());
        assert!(!fixture.path("figures/a.pdf").exists());
    }

    #[test]
    fn a_dangling_link_in_the_way_is_never_written_through() {
        let fixture = Fixture::project("figure-dangling");
        fixture.write("figures/a.svg", "<svg/>");
        let target = fixture.parent.join("planted.pdf");
        symlink(&target, fixture.path("figures/a.pdf")).unwrap();
        let figure = convert(&fixture.root, "figures/a.svg", &fake_render).unwrap();
        assert_eq!(figure.entry, "a-2.tex");
        assert!(!target.exists(), "the link's target was created");
    }

    #[test]
    fn a_linked_entry_is_not_the_figures_own() {
        let fixture = Fixture::project("figure-linked-entry");
        fixture.write("figures/a.svg", "<svg/>");
        let victim = fixture.outside("victim.tex", "% editable-figure source: a.svg\nkeep\n");
        symlink(&victim, fixture.path("figures/a.tex")).unwrap();
        let figure = convert(&fixture.root, "figures/a.svg", &fake_render).unwrap();
        assert_eq!(figure.entry, "a-2.tex");
        assert_eq!(fs::read_to_string(&victim).unwrap(), "% editable-figure source: a.svg\nkeep\n");
    }

    #[test]
    fn rendering_again_replaces_a_link_rather_than_writing_through_it() {
        let fixture = Fixture::project("figure-replace-link");
        fixture.write("figures/a.svg", "<svg/>");
        convert(&fixture.root, "figures/a.svg", &fake_render).unwrap();
        let victim = fixture.outside("victim.pdf", "keep");
        fs::remove_file(fixture.path("figures/a.pdf")).unwrap();
        symlink(&victim, fixture.path("figures/a.pdf")).unwrap();
        assert_eq!(refresh(&fixture.root, "figures/a.svg", &fake_render), Ok(FigureRefresh::Rendered));
        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep");
        assert!(!fixture.path("figures/a.pdf").symlink_metadata().unwrap().is_symlink());
    }

    #[test]
    fn a_linked_figures_folder_is_refused() {
        let fixture = Fixture::project("figure-linked-folder");
        let elsewhere = fixture.parent.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        let _ = fs::remove_dir_all(fixture.path("figures"));
        symlink(&elsewhere, fixture.path("figures")).unwrap();
        assert!(import_drawing_file(&fixture.root, "a.svg", "PHN2Zy8+").is_err());
        let dropped = fixture.outside("d.drawio", "<mxfile/>");
        assert!(import_drawing_path(&fixture.root, &dropped.to_string_lossy()).is_err());
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0);
    }
}

/// Every way a drawing was found to slip past the reference check before it
/// read the document as XML. Each of these reached the drawing program.
mod refused_drawings {
    use super::*;

    const OUTSIDE: &str = "<image href=\"/Users/me/Pictures/private.png\"/>";

    fn svg(body: &str) -> String {
        format!("<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\">{body}</svg>")
    }

    /// Whether a drawing of these bytes is rendered at all.
    fn renders(label: &str, bytes: &[u8]) -> bool {
        let fixture = Fixture::project(&format!("figure-refused-{label}"));
        fixture.write("figures/a.svg", bytes);
        let rendered = convert(&fixture.root, "figures/a.svg", &fake_render).is_ok();
        assert_eq!(fixture.path("figures/a.pdf").exists(), rendered);
        rendered
    }

    fn utf16(text: &str) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn a_drawing_with_no_links_outside_still_renders() {
        assert!(renders("plain", svg("<rect width=\"10\" height=\"10\"/>").as_bytes()));
        assert!(renders("inline", svg("<image href=\"data:image/png;base64,iVBOR\"/>").as_bytes()));
    }

    /// What Inkscape itself writes goes through: its own namespaces, a named
    /// view, a gradient used by reference, a clip path and a UTF-8 label.
    #[test]
    fn inkscapes_own_file_is_not_refused() {
        let inkscape = r##"<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cc="http://creativecommons.org/ns#"
   xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:svg="http://www.w3.org/2000/svg"
   xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   width="80mm" height="40mm" viewBox="0 0 80 40" version="1.1" id="svg5"
   inkscape:version="1.3 (0e150ed, 2023-07-21)" sodipodi:docname="scheme.svg">
  <sodipodi:namedview id="namedview7" pagecolor="#ffffff" inkscape:zoom="2.8"
     inkscape:current-layer="layer1" showgrid="false"/>
  <defs id="defs2">
    <linearGradient id="grad"><stop style="stop-color:#ff0000;stop-opacity:1" offset="0"/></linearGradient>
    <clipPath id="clip"><rect width="10" height="10"/></clipPath>
  </defs>
  <style type="text/css">.label { font-family:sans-serif; fill:url(#grad) }</style>
  <metadata id="metadata1"><rdf:RDF><cc:Work rdf:about=""><dc:title>Schéma — 1</dc:title></cc:Work></rdf:RDF></metadata>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1" clip-path="url(#clip)">
    <rect style="fill:url(#grad);stroke:none" width="60" height="20" x="5" y="5" id="rect1"/>
    <text class="label" x="10" y="30" id="text1"><tspan sodipodi:role="line">a &lt; b &amp; c</tspan></text>
    <image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="8" height="8" x="60" y="5" id="image1"/>
    <a xlink:href="https://example.com/paper"><text x="10" y="38">source</text></a>
    <use xlink:href="#rect1" transform="translate(0,10)" id="use1"/>
  </g>
</svg>
"##;
        assert!(renders("inkscape", inkscape.as_bytes()));
    }

    #[test]
    fn a_drawing_lattice_cannot_read_as_xml_text_is_refused() {
        // UTF-16 and gzip hid every link from a scan of the bytes.
        assert!(!renders("utf16", &utf16(&svg(OUTSIDE))));
        assert!(!renders("utf16-plain", &utf16(&svg("<rect/>"))));
        let mut encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, svg(OUTSIDE).as_bytes()).unwrap();
        assert!(!renders("gzip", &encoder.finish().unwrap()));
        assert!(!renders("utf16-declared", svg(OUTSIDE).replace("1.0\"?", "1.0\" encoding=\"UTF-16\"?").as_bytes()));
        assert!(!renders("nul", b"<svg><text>\0</text></svg>"));
    }

    #[test]
    fn a_character_reference_of_any_length_is_decoded() {
        for reference in ["&#47;", "&#00000000047;", "&#x2F;", "&#x000000002F;"] {
            let body = format!("<image href=\"{reference}Users/me/private.png\"/>");
            assert!(!renders("reference", svg(&body).as_bytes()), "{reference}");
        }
    }

    #[test]
    fn only_a_real_hyperlink_element_may_name_an_address() {
        // `class="&lt;a "` made the scan read an <image> as a hyperlink.
        let body = "<image class=\"&lt;a \" href=\"/Users/me/private.png\"/>";
        assert!(!renders("fake-a", svg(body).as_bytes()));
        let link = "<a xlink:href=\"https://example.com\"><text>a link, not a fetch</text></a>";
        assert!(renders("real-a", svg(link).as_bytes()));
    }

    #[test]
    fn a_moved_base_a_doctype_and_a_style_sheet_instruction_are_refused() {
        let based = "<g xml:base=\"file:///Users/me/Pictures/\"><image href=\"private.png\"/></g>";
        assert!(!renders("xml-base", svg(based).as_bytes()));
        let doctype = "<!DOCTYPE svg><svg><rect/></svg>";
        assert!(!renders("doctype", doctype.as_bytes()));
        let instruction = "<?xml-stylesheet href=\"/etc/x.css\"?><svg><rect/></svg>";
        assert!(!renders("instruction", instruction.as_bytes()));
    }

    #[test]
    fn a_drawing_an_svg_in_the_project_links_to_is_checked_too() {
        let fixture = Fixture::project("figure-nested-svg");
        fixture.write("figures/inner.svg", svg(OUTSIDE));
        fixture.write("figures/a.svg", svg("<image href=\"inner.svg\"/>"));
        assert!(convert(&fixture.root, "figures/a.svg", &fake_render).is_err());
        assert!(!fixture.path("figures/a.pdf").exists());
        // The same chain with nothing outside at the end still renders.
        fixture.write("figures/inner.svg", svg("<rect/>"));
        assert!(convert(&fixture.root, "figures/a.svg", &fake_render).is_ok());
    }

    #[test]
    fn a_ring_of_drawings_does_not_loop() {
        let fixture = Fixture::project("figure-svg-ring");
        fixture.write("figures/a.svg", svg("<image href=\"b.svg\"/>"));
        fixture.write("figures/b.svg", svg("<image href=\"a.svg\"/>"));
        assert!(convert(&fixture.root, "figures/a.svg", &fake_render).is_ok());
    }

    #[test]
    fn a_style_sheet_in_the_document_is_read_where_it_sits() {
        let sheet = "<style>.a { fill: url('file:///etc/passwd') }</style>";
        assert!(!renders("style-url", svg(sheet).as_bytes()));
        let import = "<style>@import \"/etc/x.css\";</style>";
        assert!(!renders("style-import", svg(import).as_bytes()));
        let attribute = "<rect style=\"fill:url(/etc/passwd)\"/>";
        assert!(!renders("style-attribute", svg(attribute).as_bytes()));
        // A value with no end is no file name.
        let unterminated = format!("<style>.a {{ fill: url({} }}</style>", "x".repeat(8192));
        assert!(!renders("style-unterminated", svg(&unterminated).as_bytes()));
        let fragment = "<rect style=\"fill:url(#grad)\"/>";
        assert!(renders("style-fragment", svg(fragment).as_bytes()));
        // A presentation attribute takes a `url(…)` of its own.
        for attribute in ["fill", "stroke", "filter", "mask", "clip-path"] {
            let body = format!("<rect {attribute}=\"url(/etc/passwd)\"/>");
            assert!(!renders("presentation", svg(&body).as_bytes()), "{attribute}");
            let own = format!("<rect {attribute}=\"url(#own)\"/>");
            assert!(renders("presentation-own", svg(&own).as_bytes()), "{attribute}");
        }
    }

    /// The scan used to cost about four times as much for twice the document,
    /// so a 64 MB drawing (the cap) held a thread and the project's lease for
    /// hours. One pass over 4 MB is well under a second.
    #[test]
    fn the_scan_reads_a_large_drawing_once() {
        let fixture = Fixture::project("figure-scan-cost");
        let root = &fixture.root;
        for body in ["&".repeat(4 << 20), "href ".repeat(850_000), "url(".repeat(1 << 20)] {
            let text = format!("<svg {body}/>");
            let started = std::time::Instant::now();
            let _ = check_svg_links(root, "figures", text.as_bytes());
            let spent = started.elapsed();
            assert!(spent < std::time::Duration::from_secs(1), "{spent:?} for {} bytes", text.len());
        }
    }
}

/// Who may hand a changed drawing to a drawing program without being asked.
/// A drawing is untrusted input, and a project can be a clone or an Overleaf
/// collaborator's, so a change nobody here asked for waits for a click.
mod unattended {
    use super::*;
    use crate::project::manifest::{read_manifest, write_manifest};

    fn trust(root: &Path) {
        let mut manifest = read_manifest(root).unwrap();
        manifest.trusted = true;
        write_manifest(root, &manifest).unwrap();
    }

    /// A figure as a collaborator's push leaves it: a drawing and an entry
    /// naming it, neither of them rendered here.
    fn pushed(label: &str) -> Fixture {
        let fixture = Fixture::project(label);
        fixture.write("figures/a.svg", "<svg><rect/></svg>");
        fixture.write("figures/a.tex", "% editable-figure source: a.svg\n\\input{figures/a.pdf_tex}\n");
        fixture
    }

    #[test]
    fn a_pushed_drawing_waits_for_the_user_even_in_a_trusted_project() {
        let fixture = pushed("figure-pushed");
        let plan = |unattended| prepare(&fixture.root, "figures/a.svg", unattended, &fake_render);
        assert!(matches!(plan(true), Ok(RefreshPlan::AwaitingConsent)));
        assert!(!fixture.path("figures/a.pdf").exists());
        trust(&fixture.root);
        assert!(matches!(plan(true), Ok(RefreshPlan::AwaitingConsent)));
        assert!(!fixture.path("figures/a.pdf").exists());
        // The user's own click renders it, and records the drawing as theirs,
        // so the next change to it follows on its own.
        assert_eq!(refresh(&fixture.root, "figures/a.svg", &fake_render), Ok(FigureRefresh::Rendered));
        assert!(hand_rendered(&fixture.root).contains("figures/a.svg"));
        let plan = prepare(&fixture.root, "figures/a.svg", true, &fake_render);
        assert!(matches!(plan, Ok(RefreshPlan::Ready(_))));
    }

    #[test]
    fn an_untrusted_project_never_renders_a_change_on_its_own() {
        let fixture = Fixture::project("figure-untrusted");
        fixture.write("figures/a.svg", "<svg><rect/></svg>");
        convert(&fixture.root, "figures/a.svg", &fake_render).unwrap();
        remember_hand_rendered(&fixture.root, "figures/a.svg");
        let plan = prepare(&fixture.root, "figures/a.svg", true, &fake_render);
        assert!(matches!(plan, Ok(RefreshPlan::AwaitingConsent)));
    }

    #[test]
    fn a_figure_made_here_in_a_trusted_project_follows_its_drawing() {
        let fixture = Fixture::project("figure-trusted");
        trust(&fixture.root);
        fixture.write("figures/a.svg", "<svg><rect/></svg>");
        // What the project-tree action, a paste and a drop leave behind: the
        // figure, and the drawing recorded as one someone here rendered.
        convert(&fixture.root, "figures/a.svg", &fake_render).unwrap();
        remember_hand_rendered(&fixture.root, "figures/a.svg");
        let plan = prepare(&fixture.root, "figures/a.svg", true, &fake_render);
        assert!(matches!(plan, Ok(RefreshPlan::Ready(_))));
    }

    #[test]
    fn the_record_of_hand_rendered_drawings_stays_out_of_the_project() {
        let fixture = Fixture::project("figure-record");
        remember_hand_rendered(&fixture.root, "figures/a.svg");
        remember_hand_rendered(&fixture.root, "figures/a.svg");
        assert!(hand_rendered(&fixture.root).contains("figures/a.svg"));
        // `.research` is the project's own folder, and git ignores it.
        assert!(fixture.path(RENDERED_BY_HAND).is_file());
        assert!(fixture.read(".gitignore").contains(".research"));
    }

    /// Installing re-reads the figure, since the program ran without the
    /// project's lease and the project may have moved on.
    #[test]
    fn a_figure_that_changed_during_the_render_is_not_written_over() {
        let fixture = Fixture::project("figure-moved-on");
        fixture.write("figures/a.svg", "<svg><rect/></svg>");
        convert(&fixture.root, "figures/a.svg", &fake_render).unwrap();
        let Ok(RefreshPlan::Ready(prepared)) =
            prepare(&fixture.root, "figures/a.svg", false, &fake_render)
        else {
            panic!("the figure was ready to render")
        };
        // Someone renamed the entry away while the program was running.
        fs::remove_file(fixture.path("figures/a.tex")).unwrap();
        assert_eq!(install_prepared(&fixture.root, &prepared), Ok(FigureRefresh::NoFigure));
    }
}
