//! SyncTeX lookups between the compiled PDF and its sources.

use super::{default_root_document, synctex_missing};
use crate::commands;
use crate::latex::PdfSyncTarget;
use crate::models::SyncTexTarget;
use crate::project;
use std::path::{Path, PathBuf};
use std::str::FromStr;

/// Shown for either direction: without the map there is nothing to match.
const NO_SYNCTEX_DATA: &str = "This PDF has no SyncTeX data, so Lattice cannot match it to the \
    source. A PDF compiled outside Lattice leaves it out, and latexmk then reports nothing to do \
    — press Build once to write it.";

pub fn inverse_search(root: &Path, page: u32, x: f64, y: f64) -> Result<SyncTexTarget, String> {
    if page == 0 || !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
        return Err("Invalid PDF source position.".to_string());
    }
    let (_, pdf) = synced_pdf(root, "Build the project before locating PDF source.")?;
    let output = run_synctex(
        root,
        &["edit".into(), "-o".into(), format!("{page}:{x:.3}:{y:.3}:{}", pdf.display())],
        "SyncTeX could not locate this PDF position.",
    )?;
    let (input, line) = parse_synctex_edit(&output)?;
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical_input = root.join(&input).canonicalize().map_err(|error| error.to_string())?;
    let relative = canonical_input
        .strip_prefix(&canonical_root)
        .map_err(|_| "SyncTeX returned a source file outside this project.".to_string())?;
    // Clicking a reference lands in the generated .bbl; redirect to the .bib entry
    // the writer can actually edit. Fall through to the .bbl if we can't resolve it.
    if relative.extension().and_then(|value| value.to_str()) == Some("bbl") {
        if let Ok(Some(target)) = project::bib_target_for_bbl(root, relative, line) {
            return Ok(target);
        }
    }
    Ok(SyncTexTarget { path: relative.to_string_lossy().to_string(), line })
}

pub fn forward_search(
    root: &Path, path: &str, line: u32, column: u32,
) -> Result<Option<PdfSyncTarget>, String> {
    if line == 0 {
        return Err("Choose a source line before locating it in the PDF.".to_string());
    }
    let relative = project::safe_path(root, path)?
        .strip_prefix(root)
        .map_err(|_| "Source path is outside this project.".to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let (document, pdf) = synced_pdf(root, "Build the project before locating source in the PDF.")?;
    // A .bib entry reaches the PDF through the generated .bbl, so look that up.
    let (lookup_path, lookup_line, lookup_column) =
        if Path::new(&relative).extension().and_then(|value| value.to_str()) == Some("bib") {
            let bbl = Path::new(&document).with_extension("bbl");
            let target = project::bbl_target_for_bib(root, Path::new(&relative), &bbl, line)?
                .ok_or_else(|| {
                    "This bibliography entry is not included in the compiled PDF.".to_string()
                })?;
            (target.path, target.line, 0)
        } else {
            (relative, line, column.saturating_sub(1))
        };
    let output = run_synctex(
        root,
        &[
            "view".into(),
            "-i".into(),
            format!("{lookup_line}:{lookup_column}:{lookup_path}"),
            "-o".into(),
            pdf.display().to_string(),
        ],
        "SyncTeX could not locate this source line.",
    )?;
    first_synctex_view_target(&output)
}

/// The default root document and its PDF (relative to `root`), once that PDF
/// exists and has SyncTeX data to search.
fn synced_pdf(root: &Path, unbuilt: &str) -> Result<(String, PathBuf), String> {
    let manifest = project::read_manifest(root)?;
    let document = default_root_document(&manifest)?.path.clone();
    let pdf = Path::new(&document).with_extension("pdf");
    if !root.join(&pdf).is_file() {
        return Err(unbuilt.to_string());
    }
    // Missing SyncTeX data is not "this line is not in the PDF": the whole map
    // is absent, and every line would answer the same. Say so once here rather
    // than sending the reader looking for a paragraph that is on the page.
    if synctex_missing(root) {
        return Err(NO_SYNCTEX_DATA.to_string());
    }
    Ok((document, pdf))
}

/// Run `synctex` and return its stdout, or a readable failure led by `lead`.
fn run_synctex(root: &Path, args: &[String], lead: &str) -> Result<String, String> {
    let output = commands::command("synctex")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|error| format!("Could not start SyncTeX: {error}"))?;
    if !output.status.success() {
        return Err(synctex_failure(&String::from_utf8_lossy(&output.stderr), lead));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Turn a failed `synctex` run into one sentence a writer can act on.
///
/// synctex answers every failure by printing its entire command-line manual to
/// stderr — around fifty lines of `-o page:x:y:file` grammar. The one failure
/// that actually happens has a cause worth naming instead: a PDF built by
/// another tool carries no `.synctex.gz`, because Lattice's own build is what
/// passes `-synctex=1`.
fn synctex_failure(stderr: &str, lead: &str) -> String {
    if stderr.contains("No SyncTeX available") {
        return NO_SYNCTEX_DATA.to_string();
    }
    let reason = stderr
        .lines()
        .take_while(|line| !line.trim_start().starts_with("usage:"))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if reason.is_empty() {
        return lead.to_string();
    }
    // Any other synctex failure is still a tool message, not prose: keep it
    // short enough to read at a glance in the editor's error strip.
    format!("{lead} {}", crate::util::truncate_chars(&reason, 200))
}

fn parse_synctex_edit(output: &str) -> Result<(String, u32), String> {
    let input = output
        .lines()
        .find_map(|line| line.strip_prefix("Input:"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "No LaTeX source was found for this PDF position.".to_string())?;
    let line = field(output, "Line:")
        .filter(|value| *value > 0)
        .ok_or_else(|| "SyncTeX returned an invalid source line.".to_string())?;
    Ok((input.to_string(), line))
}

/// Where a forward search lands in `synctex view` output. Every result must
/// parse; results on page 0 are no match.
///
/// SyncTeX answers one source line with every box it fed, its best guess
/// first, and that first box can be far larger than the place it names: a
/// `\begin{subfigure}` line answers with the box around the whole row of
/// panels. The point the first result gives is the place; the tightest box
/// around that point is the highlight, so a structural line lands on the
/// panel or caption it names when SyncTeX knows one, and only an enclosing
/// box with nothing tighter inside it is shown whole. A box elsewhere on the
/// page (a footnote the line also fed) never wins.
fn first_synctex_view_target(output: &str) -> Result<Option<PdfSyncTarget>, String> {
    // A successful `synctex view` prints only its version banner when the
    // source line has no PDF node (common for declarations in .sty files).
    // That is a valid no-match, not malformed SyncTeX data.
    let mut results = Vec::new();
    for block in output.split("SyncTeX result begin").skip(1) {
        let body = block.split("SyncTeX result end").next().unwrap_or(block);
        // One block lists every result, each opening with its `Output:` line.
        for record in body.split("\nOutput:").filter(|record| !record.trim().is_empty()) {
            results.push(view_result(record)?);
        }
    }
    let Some(first) = results.iter().find(|result| result.target.page != 0) else {
        return Ok(None);
    };
    let (page, (x, y)) = (first.target.page, first.point);
    let tightest = results
        .iter()
        .filter(|result| result.boxed && result.target.page == page && result.target.contains(x, y))
        // `min_by` keeps the earliest of equal areas: SyncTeX's own order.
        .min_by(|left, right| left.target.area().total_cmp(&right.target.area()));
    Ok(Some(tightest.unwrap_or(first).target.clone()))
}

/// One `synctex view` result: the rectangle to highlight, whose `y` is its
/// top edge; the point SyncTeX matched; and whether the rectangle is a real
/// box rather than a marker drawn around that point.
struct ViewResult {
    target: PdfSyncTarget,
    point: (f64, f64),
    boxed: bool,
}

/// `h`/`v` is a box's origin: on its baseline, with the height `H` running up
/// the page from there (`synctex help view`). Drawing from `v` put a tall box
/// — a whole figure — below the place it encloses, so a box starts at `v - H`.
/// A result with no usable box falls back to its `x`/`y` point, also on a
/// baseline, under a line-sized marker that sits on it.
fn view_result(record: &str) -> Result<ViewResult, String> {
    let missing = |prefix: &str| format!("SyncTeX output is missing {prefix}");
    let page: u32 = field(record, "Page:").ok_or_else(|| missing("Page:"))?;
    let (h, v) = (coordinate(record, "h:"), coordinate(record, "v:"));
    let x = coordinate(record, "x:").or(h).ok_or_else(|| missing("x:"))?;
    let y = coordinate(record, "y:").or(v).ok_or_else(|| missing("y:"))?;
    let extent = |prefix: &str| coordinate(record, prefix).filter(|value| *value > 0.0);
    let (target, boxed) = match (h, v, extent("W:"), extent("H:")) {
        (Some(left), Some(baseline), Some(width), Some(height)) => {
            (PdfSyncTarget { page, x: left, y: baseline - height, width, height }, true)
        }
        _ => {
            let (width, height) = (POINT_MARKER_WIDTH, POINT_MARKER_HEIGHT);
            (PdfSyncTarget { page, x, y: y - height, width, height }, false)
        }
    };
    Ok(ViewResult {
        target: PdfSyncTarget { y: target.y.max(0.0), ..target },
        point: (x, y),
        boxed,
    })
}

/// The marker for a result that names only a point: about one word of text.
const POINT_MARKER_WIDTH: f64 = 24.0;
const POINT_MARKER_HEIGHT: f64 = 12.0;

impl PdfSyncTarget {
    fn area(&self) -> f64 {
        self.width * self.height
    }

    /// Whether the point lies in this rectangle. SyncTeX reports no depth, so
    /// a point on (or a hair under) the baseline still counts as inside.
    fn contains(&self, x: f64, y: f64) -> bool {
        const SLACK: f64 = 0.5;
        x >= self.x - SLACK
            && x <= self.x + self.width + SLACK
            && y >= self.y - SLACK
            && y <= self.y + self.height + SLACK
    }
}

/// The value on the first `prefix` line of a SyncTeX record.
fn field<T: FromStr>(block: &str, prefix: &str) -> Option<T> {
    block.lines().find_map(|line| line.strip_prefix(prefix))?.trim().parse().ok()
}

fn coordinate(block: &str, prefix: &str) -> Option<f64> {
    field(block, prefix).filter(|value: &f64| value.is_finite())
}

#[cfg(test)]
mod tests {
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
        let target = first_synctex_view_target(&view_block("3", "487.120")).unwrap().unwrap();
        assert_eq!(target.page, 3);
        // The box rises from its baseline `v` by `H`.
        assert_rect(&target, [154.230, 487.120 - 11.2, 306.142, 11.2]);
        // Page 0 is no match; the first real result wins.
        let several = view_block("0", "0.0") + &view_block("2", "200.0") + &view_block("4", "9.0");
        assert_eq!(first_synctex_view_target(&several).unwrap().unwrap().page, 2);

        // A successful run that printed only its banner, and a zero page, are
        // both "no match"; an unreadable result block is an error.
        let banner = "This is SyncTeX command line utility, version 1.5\n";
        assert!(first_synctex_view_target(banner).unwrap().is_none());
        assert!(first_synctex_view_target(&view_block("0", "0.0")).unwrap().is_none());
        assert!(first_synctex_view_target(&view_block("not-a-page", "1.0")).is_err());
    }

    #[test]
    fn a_tall_enclosing_box_is_drawn_from_its_top_not_its_baseline() {
        // pdfLaTeX + subcaption, the caret on the second of two
        // `\begin{subfigure}[t]{0.315\linewidth}` lines: SyncTeX's only answer
        // is the box around both panels, whose origin is on the captions'
        // baseline. Drawn downward from there, it covered the text below the
        // figure instead of the figure.
        let output =
            view_output(&[[219.421127, 277.078125, 71.999985, 294.014618, 468.0, 176.33873]]);
        let target = first_synctex_view_target(&output).unwrap().unwrap();
        assert_rect(&target, [71.999985, 294.014618 - 176.33873, 468.0, 176.33873]);
    }

    #[test]
    fn a_result_without_a_box_marks_its_point_on_the_baseline() {
        let output = "SyncTeX result begin\nOutput:main.pdf\nPage:2\nx:100.5\ny:300.25\nSyncTeX result end\n";
        let target = first_synctex_view_target(output).unwrap().unwrap();
        assert_eq!(target.page, 2);
        assert_rect(
            &target,
            [100.5, 300.25 - POINT_MARKER_HEIGHT, POINT_MARKER_WIDTH, POINT_MARKER_HEIGHT],
        );
        // A zero-sized box is no box either.
        let empty = view_output(&[[50.0, 80.0, 40.0, 82.0, 0.0, 10.0]]);
        assert_rect(
            &first_synctex_view_target(&empty).unwrap().unwrap(),
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
            &first_synctex_view_target(&equation).unwrap().unwrap(),
            [286.253876, 190.743561 - 8.607751, 38.740086, 8.607751],
        );

        // A line inside a subfigure: the caption's line, then the panel's box,
        // which the point is not in.
        let subfigure = view_output(&[
            [91.800934, 268.09201, 91.800934, 271.3797, 134.946442, 10.958904],
            [91.800934, 254.443207, 91.800934, 254.443207, 134.946442, 159.402237],
        ]);
        assert_rect(
            &first_synctex_view_target(&subfigure).unwrap().unwrap(),
            [91.800934, 271.3797 - 10.958904, 134.946442, 10.958904],
        );

        // A text line with a footnote: the footnote's small boxes at the foot
        // of the page are smaller, but not where the line is.
        let footnote = view_output(&[
            [156.184311, 134.764618, 133.768356, 136.701797, 343.71106, 10.046797],
            [144.860382, 669.890442, 133.768356, 672.703186, 15.24307, 6.664993],
        ]);
        assert_rect(
            &first_synctex_view_target(&footnote).unwrap().unwrap(),
            [133.768356, 136.701797 - 10.046797, 343.71106, 10.046797],
        );
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
        // The temporary directory sits behind a symlink on macOS (/var).
        let root = project::create(&parent, "Subfigure sync").unwrap().canonicalize().unwrap();
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

        let result = super::super::build(&root, true, &Default::default(), None).unwrap();
        assert!(result.success, "{}", result.log);
        let at =
            |line| forward_search(&root, "main.tex", line, 0).unwrap().expect("a PDF position");
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

        let result = super::super::build(&root, true, &Default::default(), None).unwrap();
        assert!(result.success, "{}", result.log);
        let target = forward_search(&root, "references.bib", 3, 0)
            .unwrap()
            .expect("the generated bibliography item should have a PDF position");
        assert_eq!(target.page, 1);
        assert!(target.x.is_finite() && target.y.is_finite());
    }
}
