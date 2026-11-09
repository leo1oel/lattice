use super::render::{check_svg_links, convert_args};
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
    assert_eq!(refresh(&fixture.root, "figures/a.svg", &fake_render), Ok(true));
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
    fixture.write("figures/plain.svg", "<svg/>");
    assert_eq!(refresh_figure_source(&fixture.root, "figures/plain.svg"), Ok(false));
    fixture.write("figures/a.tex", "\\section{Not a figure}");
    fixture.write("figures/a.svg", "<svg/>");
    assert_eq!(refresh_figure_source(&fixture.root, "figures/a.svg"), Ok(false));
    assert!(refresh_figure_source(&fixture.root, "../a.svg").is_err());
    assert!(refresh_figure_source(&fixture.root, "figures/a.tex").is_err());
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
        assert_eq!(check_svg_links(root, "figures", &svg(safe)), Ok(()), "{safe}");
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
        assert!(check_svg_links(root, "figures", &svg(unsafe_link)).is_err(), "{unsafe_link}");
    }
    let entity =
        "<!DOCTYPE svg [<!ENTITY x SYSTEM \"file:///etc/passwd\">]><svg><text>&x;</text></svg>";
    assert!(check_svg_links(root, "figures", entity).is_err());
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
        assert!(check_svg_links(&fixture.root, "figures", svg).is_err());
        symlink(fixture.parent.clone(), fixture.path("figures/up")).unwrap();
        let svg = "<svg><image href=\"up/secret.png#x\"/></svg>";
        assert!(check_svg_links(&fixture.root, "figures", svg).is_err());
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
        assert_eq!(refresh(&fixture.root, "figures/a.svg", &fake_render), Ok(true));
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
