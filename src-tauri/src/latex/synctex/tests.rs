use super::*;
use crate::test_support::TempDir;
use std::fs;

#[test]
fn parses_inverse_synctex_locations() {
    let output = "SyncTeX result begin\nOutput:main.pdf\nInput:/tmp/paper/main.tex\nLine:33\nColumn:-1\nSyncTeX result end\n";
    assert_eq!(parse_synctex_edit(output).unwrap(), ("/tmp/paper/main.tex".to_string(), 33));
}

/// A `synctex view` result block for `page`, `v` points down the page.
fn view_block(page: &str, v: &str) -> String {
    format!(
        "SyncTeX result begin\nOutput:main.pdf\nPage:{page}\nx:154.230\ny:{v}\nh:154.230\n\
         v:{v}\nW:306.142\nH:11.200\nbefore:\noffset:0\nmiddle:\nafter:\nSyncTeX result end\n"
    )
}

/// `synctex view` output listing `records` (`[x, y, h, v, W, H]`, all on
/// page 1) in one block, the way synctex 1.5 prints several results.
fn view_output(records: &[[f64; 6]]) -> String {
    let mut output =
        "This is SyncTeX command line utility, version 1.5\nSyncTeX result begin\n".to_string();
    for [x, y, h, v, width, height] in records {
        output += &format!(
            "Output:main.pdf\nPage:1\nx:{x}\ny:{y}\nh:{h}\nv:{v}\nW:{width}\nH:{height}\n\
             before:\noffset:-1\nmiddle:\nafter:\n"
        );
    }
    output + "SyncTeX result end\n"
}

/// The view-only target, with no raw SyncTeX records to measure by.
fn view_target(output: &str) -> Result<Option<PdfSyncTarget>, String> {
    first_synctex_view_target(output, |_| Vec::new())
}

fn assert_rect(target: &PdfSyncTarget, [x, y, width, height]: [f64; 4]) {
    let actual = [target.x, target.y, target.width, target.height];
    assert!(
        actual
            .iter()
            .zip([x, y, width, height])
            .all(|(actual, expected)| (actual - expected).abs() < 0.001),
        "expected {:?}, got {actual:?}",
        [x, y, width, height]
    );
}

#[test]
fn parses_forward_synctex_results() {
    let target = view_target(&view_block("3", "487.120")).unwrap().unwrap();
    assert_eq!(target.page, 3);
    // The box rises from its baseline `v` by `H`.
    assert_rect(&target, [154.230, 487.120 - 11.2, 306.142, 11.2]);
    // Page 0 is no match; the first real result wins.
    let several = view_block("0", "0.0") + &view_block("2", "200.0") + &view_block("4", "9.0");
    assert_eq!(view_target(&several).unwrap().unwrap().page, 2);

    // A successful run that printed only its banner, and a zero page, are
    // both "no match"; an unreadable result block is an error.
    let banner = "This is SyncTeX command line utility, version 1.5\n";
    assert!(view_target(banner).unwrap().is_none());
    assert!(view_target(&view_block("0", "0.0")).unwrap().is_none());
    assert!(view_target(&view_block("not-a-page", "1.0")).is_err());
}

#[test]
fn a_tall_enclosing_box_is_drawn_from_its_top_not_its_baseline() {
    // pdfLaTeX + subcaption, the caret on the second of two
    // `\begin{subfigure}[t]{0.315\linewidth}` lines: SyncTeX's only answer
    // is the box around both panels, whose origin is on the captions'
    // baseline. Drawn downward from there, it covered the text below the
    // figure instead of the figure.
    let output = view_output(&[[219.421127, 277.078125, 71.999985, 294.014618, 468.0, 176.33873]]);
    let target = view_target(&output).unwrap().unwrap();
    assert_rect(&target, [71.999985, 294.014618 - 176.33873, 468.0, 176.33873]);
}

#[test]
fn a_result_without_a_box_marks_its_point_on_the_baseline() {
    let output =
        "SyncTeX result begin\nOutput:main.pdf\nPage:2\nx:100.5\ny:300.25\nSyncTeX result end\n";
    let target = view_target(output).unwrap().unwrap();
    assert_eq!(target.page, 2);
    assert_rect(
        &target,
        [100.5, 300.25 - POINT_MARKER_HEIGHT, POINT_MARKER_WIDTH, POINT_MARKER_HEIGHT],
    );
    // A zero-sized box is no box either.
    let empty = view_output(&[[50.0, 80.0, 40.0, 82.0, 0.0, 10.0]]);
    assert_rect(
        &view_target(&empty).unwrap().unwrap(),
        [50.0, 80.0 - POINT_MARKER_HEIGHT, POINT_MARKER_WIDTH, POINT_MARKER_HEIGHT],
    );
}

#[test]
fn the_tightest_box_around_the_matched_point_is_the_highlight() {
    // A display equation's line: the whole display row (number included),
    // then the equation itself; the point lies in both.
    let equation = view_output(&[
        [286.253876, 190.743561, 286.253876, 193.234222, 191.225571, 11.098411],
        [320.524597, 186.630066, 286.253876, 190.743561, 38.740086, 8.607751],
    ]);
    assert_rect(
        &view_target(&equation).unwrap().unwrap(),
        [286.253876, 190.743561 - 8.607751, 38.740086, 8.607751],
    );

    // A line inside a subfigure: the caption's line, then the panel's box,
    // which the point is not in.
    let subfigure = view_output(&[
        [91.800934, 268.09201, 91.800934, 271.3797, 134.946442, 10.958904],
        [91.800934, 254.443207, 91.800934, 254.443207, 134.946442, 159.402237],
    ]);
    assert_rect(
        &view_target(&subfigure).unwrap().unwrap(),
        [91.800934, 271.3797 - 10.958904, 134.946442, 10.958904],
    );

    // A text line with a footnote: the footnote's small boxes at the foot
    // of the page are smaller, but not where the line is.
    let footnote = view_output(&[
        [156.184311, 134.764618, 133.768356, 136.701797, 343.71106, 10.046797],
        [144.860382, 669.890442, 133.768356, 672.703186, 15.24307, 6.664993],
    ]);
    assert_rect(
        &view_target(&footnote).unwrap().unwrap(),
        [133.768356, 136.701797 - 10.046797, 343.71106, 10.046797],
    );
}

/// pdfLaTeX's SyncTeX for, by line: a figure holding
/// `\includegraphics[height=32mm]` of an 835.5 x 663 bp PDF (6), a text
/// line with the same PDF inline at 12mm (8), and a 100 x 50 bp PDF
/// enlarged to 32mm (10).
const GRAPHICS_SYNCTEX: &str =
    include_str!("../../../tests/fixtures/synctex-includegraphics.synctex");

/// A box recorded in that file as `h,v:W,H,D` (scaled points), as a
/// highlight in PDF points.
fn recorded(h: f64, v: f64, width: f64, height: f64, depth: f64) -> [f64; 4] {
    const SP_PER_BP: f64 = 65781.76;
    [h / SP_PER_BP, (v - height) / SP_PER_BP, width / SP_PER_BP, (height + depth) / SP_PER_BP]
}

fn graphics_target(output: &str) -> PdfSyncTarget {
    first_synctex_view_target(output, |page| records::corrections(GRAPHICS_SYNCTEX, page))
        .unwrap()
        .unwrap()
}

#[test]
fn a_scaled_graphic_is_highlighted_at_the_size_it_is_drawn() {
    // `synctex view` for the figure's `\includegraphics` line: every box
    // grows to the graphic's unscaled 835.5 x 663 bp from its lower-left
    // corner, so the highlight ran off the top of the page.
    let figure = view_output(&[
        [248.471527, 215.510635, 248.471527, 215.510635, 835.499939, 663.0],
        [248.471527, 215.510635, 133.768356, 215.510635, 950.203125, 663.0],
        [248.471527, 215.510635, 248.471527, 215.510635, 835.499939, 663.0],
        [248.471527, 215.510635, 248.471527, 215.510635, 835.499939, 663.0],
        [248.471527, 215.510635, 248.471527, 215.510635, 835.499939, 663.0],
        [248.471527, 215.510635, 248.471527, 215.510635, 835.499939, 663.0],
    ]);
    assert_rect(&view_target(&figure).unwrap().unwrap(), [248.471527, 0.0, 835.499939, 663.0]);
    // TeX reserved the 32mm box `(1,6:16344895,14176669:7519166,5966975,0`.
    assert_rect(
        &graphics_target(&figure),
        recorded(16344895.0, 14176669.0, 7519166.0, 5966975.0, 0.0),
    );

    // The same graphic at 12mm in a text line: the line's box grew to
    // 663 bp tall. Its point is a word before the graphic, so the line
    // is the highlight, at the height TeX gave it.
    let inline = view_output(&[
        [155.907562, 269.45166, 133.768356, 269.45166, 873.690125, 663.0],
        [171.958496, 269.45166, 133.768356, 269.45166, 873.690125, 663.0],
        [171.958496, 269.45166, 171.958496, 269.45166, 835.499939, 663.0],
        [171.958496, 269.45166, 171.958496, 269.45166, 835.499939, 663.0],
        [171.958496, 269.45166, 171.958496, 269.45166, 835.499939, 663.0],
        [171.958496, 269.45166, 171.958496, 269.45166, 835.499939, 663.0],
        [171.958496, 269.45166, 171.958496, 269.45166, 835.499939, 663.0],
    ]);
    assert_rect(
        &graphics_target(&inline),
        recorded(8799518.0, 17725004.0, 22609920.0, 2237615.0, 0.0),
    );

    // Enlarged, the unscaled 100 x 50 bp original is the tightest box
    // around the point, and sat in the 32mm graphic's lower-left corner.
    let enlarged = view_output(&[
        [148.712311, 361.156586, 148.712311, 361.156586, 181.445312, 90.722656],
        [148.712311, 361.156586, 133.768356, 361.156586, 343.71106, 90.722656],
        [148.712311, 361.156586, 148.712311, 361.156586, 100.0, 90.722656],
        [148.712311, 361.156586, 148.712311, 361.156586, 181.445312, 90.722656],
        [148.712311, 361.156586, 148.712311, 361.156586, 181.445312, 90.722656],
        [148.712311, 361.156586, 148.712311, 361.156586, 100.0, 50.0],
    ]);
    assert_rect(&view_target(&enlarged).unwrap().unwrap(), [148.712311, 311.156586, 100.0, 50.0]);
    // graphicx's box around it, `(1,10:9782558,23757515:11935792,5967896,0`.
    assert_rect(
        &graphics_target(&enlarged),
        recorded(9782558.0, 23757515.0, 11935792.0, 5967896.0, 0.0),
    );
}

#[test]
fn boxes_laid_out_where_synctex_records_them_are_left_alone() {
    let corrections = records::corrections(GRAPHICS_SYNCTEX, 1);
    let laid_out = |[x, y, width, height]: [f64; 4]| {
        let reported = PdfSyncTarget { page: 1, x, y, width, height };
        corrections
            .iter()
            .find(|correction| correction.reported.same_box(&reported))
            .map(|correction| correction.laid_out.clone())
            .expect("a recorded box")
    };
    // The page number's line holds nothing drawn elsewhere.
    let foot = recorded(8799518.0, 46220574.0, 22609920.0, 422343.0, 0.0);
    assert_rect(&laid_out(foot), foot);
    // The inline graphic's text line is the line TeX set, 12mm tall.
    assert_rect(
        &laid_out([133.768356, 269.45166 - 663.0, 873.690125, 663.0]),
        recorded(8799518.0, 17725004.0, 22609920.0, 2237615.0, 0.0),
    );
    // Only the page asked for.
    assert!(records::corrections(GRAPHICS_SYNCTEX, 2).is_empty());
}

#[test]
fn names_the_cause_instead_of_reprinting_the_synctex_manual() {
    // What synctex actually writes when the PDF has no companion data.
    let stderr = "SyncTeX ERROR: No SyncTeX available for lambda_gpu_proposal.pdf\n\
         usage: synctex <subcommand> [options] [args]\n\
         -o page:x:y:file\n       specify the page and coordinates\n";
    let message = synctex_failure(stderr, "SyncTeX could not locate this PDF position.");
    assert!(
        !message.contains("usage:") && !message.contains("page:x:y:file"),
        "must not paste synctex's manual into the UI: {message}"
    );
    assert!(message.contains("Build"), "must say how to fix it: {message}");

    let stderr = "SyncTeX ERROR: cannot open the file\nusage: synctex <subcommand>\n-o page";
    assert_eq!(
        synctex_failure(stderr, "SyncTeX could not locate this source line."),
        "SyncTeX could not locate this source line. SyncTeX ERROR: cannot open the file"
    );
}

#[test]
#[ignore = "requires a local latexmk and pdfLaTeX installation"]
fn forward_search_highlights_a_subfigure_row_where_the_figure_is() {
    let parent = TempDir::new("latex");
    let root = project::create(&parent, "Subfigure sync").unwrap();
    fs::write(
        root.join("main.tex"),
        "\\documentclass{article}\n\
         \\usepackage{subcaption}\n\
         \\begin{document}\n\
         \\begin{figure}[t]\n\
         \\begin{subfigure}[t]{0.315\\linewidth}\n\
         \\rule{\\linewidth}{160pt}\n\
         \\caption{Left panel}\n\
         \\end{subfigure}\\hfill\n\
         \\begin{subfigure}[t]{0.315\\linewidth}\n\
         \\rule{\\linewidth}{90pt}\n\
         \\caption{Right panel}\n\
         \\end{subfigure}\n\
         \\caption{Two panels.}\n\
         \\end{figure}\n\
         Alpha paragraph.\n\
         \\end{document}\n",
    )
    .unwrap();

    let result = super::super::build(
        &root,
        true,
        &Default::default(),
        None,
        &super::super::BuildSteps::silent(),
    )
    .unwrap();
    assert!(result.success, "{}", result.log);
    let at = |line| forward_search(&root, "main.tex", line, 0).unwrap().expect("a PDF position");
    let (row, caption, paragraph) = (at(9), at(13), at(15));
    // The second `\begin{subfigure}` names the row of panels: it sits
    // wholly above the figure's caption, which sits above the paragraph.
    assert!(row.height > 80.0, "{row:?}");
    assert!(row.y + row.height <= caption.y + 0.5, "{row:?} reaches into {caption:?}");
    assert!(
        caption.y + caption.height <= paragraph.y + 0.5,
        "{caption:?} reaches into {paragraph:?}"
    );
}

#[test]
#[ignore = "requires a local latexmk, pdfLaTeX and the mwe package"]
fn forward_search_highlights_a_scaled_graphic_where_it_is_drawn() {
    let parent = TempDir::new("latex");
    let root = project::create(&parent, "Graphic sync").unwrap();
    fs::write(
        root.join("main.tex"),
        "\\documentclass{article}\n\
         \\usepackage{graphicx}\n\
         \\begin{document}\n\
         \\begin{figure}[t]\n\
         \\centering\n\
         \\includegraphics[height=32mm]{example-image}\n\
         \\caption{A graphic.}\n\
         \\end{figure}\n\
         Alpha paragraph.\n\
         \\end{document}\n",
    )
    .unwrap();

    let result = super::super::build(
        &root,
        true,
        &Default::default(),
        None,
        &super::super::BuildSteps::silent(),
    )
    .unwrap();
    assert!(result.success, "{}", result.log);
    let at = |line| forward_search(&root, "main.tex", line, 0).unwrap().expect("a PDF position");
    let (graphic, caption) = (at(6), at(7));
    // example-image is 320 x 240 bp; drawn 32mm (90.71 bp) tall.
    assert!((graphic.height - 90.71).abs() < 0.5, "{graphic:?}");
    assert!((graphic.width - 120.95).abs() < 0.5, "{graphic:?}");
    assert!(graphic.y + graphic.height <= caption.y + 0.5, "{graphic:?} reaches into {caption:?}");
}

#[test]
#[ignore = "requires a local latexmk and bibtex installation"]
fn forward_searches_from_a_bib_entry_through_the_generated_bbl() {
    let parent = TempDir::new("latex");
    let root = project::create(&parent, "Bibliography sync").unwrap();
    fs::write(
        root.join("main.tex"),
        "\\documentclass{article}\n\
         \\begin{document}\n\
         See \\cite{smith2020}.\n\
         \\bibliographystyle{plain}\n\
         \\bibliography{references}\n\
         \\end{document}\n",
    )
    .unwrap();
    fs::write(
        root.join("references.bib"),
        "@article{smith2020,\n\
         title = {A Useful Paper},\n\
         author = {Smith, Jane},\n\
         year = {2020}\n\
         }\n",
    )
    .unwrap();

    let result = super::super::build(
        &root,
        true,
        &Default::default(),
        None,
        &super::super::BuildSteps::silent(),
    )
    .unwrap();
    assert!(result.success, "{}", result.log);
    let target = forward_search(&root, "references.bib", 3, 0)
        .unwrap()
        .expect("the generated bibliography item should have a PDF position");
    assert_eq!(target.page, 1);
    assert!(target.x.is_finite() && target.y.is_finite());
}

/// A project at `real`, opened through a symlink to it, as macOS's /var and
/// /tmp and a writer's own link to a folder are.
fn linked_project(parent: &Path, name: &str) -> PathBuf {
    fs::create_dir(parent.join("real")).unwrap();
    let real = project::create(&parent.join("real"), name).unwrap();
    let link = parent.join("link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    link
}

#[test]
fn a_project_reached_through_a_symlink_keeps_its_sources_inside() {
    let parent = TempDir::new("synctex-link");
    let root = linked_project(&parent, "Linked");
    // Past the path check: what is missing is the build.
    assert_eq!(
        forward_search(&root, "main.tex", 1, 0).unwrap_err(),
        "Build the project before locating source in the PDF."
    );
    // A path that really leaves the project is still refused.
    fs::write(parent.join("real/outside.tex"), "").unwrap();
    let escape = forward_search(&root, "../outside.tex", 1, 0).unwrap_err();
    assert!(escape.contains("outside the project"), "{escape}");
}

#[test]
#[ignore = "requires a local latexmk and pdfLaTeX installation"]
fn searches_both_ways_in_a_project_reached_through_a_symlink() {
    let parent = TempDir::new("synctex-link");
    let root = linked_project(&parent, "Linked sync");
    fs::write(
        root.join("main.tex"),
        "\\documentclass{article}\n\\begin{document}\nAlpha paragraph.\n\nBeta paragraph.\n\\end{document}\n",
    )
    .unwrap();
    let result = super::super::build(
        &root,
        true,
        &Default::default(),
        None,
        &super::super::BuildSteps::silent(),
    )
    .unwrap();
    assert!(result.success, "{}", result.log);
    let beta = forward_search(&root, "main.tex", 5, 0).unwrap().expect("a PDF position");
    let back =
        inverse_search(&root, beta.page, beta.x + beta.width / 2.0, beta.y + beta.height / 2.0)
            .unwrap();
    assert_eq!((back.path.as_str(), back.line), ("main.tex", 5));
}

/// A project whose default root document sits in a subfolder beside a PDF
/// compiled there by hand, with no SyncTeX map — the shape of a CV folder
/// next to a paper. It reads one file beside it and one in a sibling folder.
fn subfolder_project(engine: &str) -> (TempDir, Vec<u8>) {
    let root = TempDir::new("synctex-subfolder");
    let mut manifest = project::default_manifest("Subfolder");
    manifest.engine = engine.to_string();
    for document in &mut manifest.root_documents {
        document.is_default = false;
    }
    manifest.root_documents.push(crate::models::RootDocument {
        path: "cv/sop/sop.tex".to_string(),
        name: "sop".to_string(),
        is_default: true,
    });
    project::write_manifest(&root, &manifest).unwrap();
    root.write(
        "main.tex",
        "\\documentclass{article}\n\\begin{document}\nPaper.\n\\end{document}\n",
    );
    root.write("cv/sop/intro.tex", "An introduction beside the statement.\\par\n");
    root.write("cv/shared/closing.tex", "A closing shared with the CV.\\par\n");
    root.write(
        "cv/sop/sop.tex",
        "\\documentclass{article}\n\\begin{document}\nStale outside build.\n\\end{document}\n",
    );
    let outside = crate::commands::command("latexmk")
        .current_dir(root.join("cv/sop"))
        .args([project::latexmk_engine_arg(engine), "-interaction=nonstopmode", "sop.tex"])
        .output()
        .unwrap();
    assert!(outside.status.success(), "{}", crate::commands::combined_output(&outside));
    let stale = fs::read(root.join("cv/sop/sop.pdf")).unwrap();
    assert!(!root.join("cv/sop/sop.synctex.gz").exists());
    root.write(
        "cv/sop/sop.tex",
        "\\documentclass{article}\n\
         \\begin{document}\n\
         \\section{Purpose}\n\
         A statement of purpose.\\par\n\
         \n\
         \\input{intro}\n\
         \n\
         \\input{../shared/closing}\n\
         \\end{document}\n",
    );
    (root, stale)
}

#[test]
#[ignore = "requires a local latexmk, pdfLaTeX and LuaLaTeX installation"]
fn a_root_document_in_a_subfolder_previews_and_syncs_its_own_fresh_build() {
    for engine in ["pdf", "lualatex"] {
        let (root, stale) = subfolder_project(engine);
        let result = super::super::build(
            &root,
            false,
            &Default::default(),
            None,
            &super::super::BuildSteps::silent(),
        )
        .unwrap();
        assert!(result.success && result.has_pdf, "{engine}: {}", result.log);
        assert_eq!(result.root_document, "cv/sop/sop.tex");
        assert_eq!(result.synctex, Some(true), "{engine}: the fresh PDF has its map");
        // The preview reads this build, not the PDF compiled there by hand,
        // and nothing is written beside the project's own paper.
        let preview = super::super::read_compiled_pdf(&root).unwrap();
        assert_ne!(preview, stale, "{engine}: the preview shows the stale PDF");
        assert!(!root.join("sop.pdf").exists(), "{engine}: output went to the project root");

        for (path, line) in
            [("cv/sop/sop.tex", 4), ("cv/sop/intro.tex", 1), ("cv/shared/closing.tex", 1)]
        {
            let target = forward_search(&root, path, line, 0)
                .unwrap()
                .unwrap_or_else(|| panic!("{engine}: {path}:{line} has no PDF position"));
            let back = inverse_search(
                &root,
                target.page,
                target.x + target.width / 2.0,
                target.y + target.height / 2.0,
            )
            .unwrap();
            assert_eq!((back.path.as_str(), back.line), (path, line), "{engine}");
        }
        let span = BodySpan { path: "cv/sop/sop.tex".to_string(), before: None };
        assert_eq!(body_pages(&root, &[span]).unwrap(), Some(1), "{engine}");
        let heading = SourceLine { path: "cv/sop/sop.tex".to_string(), line: 3 };
        assert_eq!(heading_pages(&root, &[heading]).unwrap(), vec![Some(1)], "{engine}");

        super::super::clean(&root).unwrap();
        assert!(!root.join("cv/sop/sop.aux").exists(), "{engine}: clean left the build's aux");
    }
}
