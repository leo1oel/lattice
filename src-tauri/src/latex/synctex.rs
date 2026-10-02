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

/// The first PDF position in `synctex view` output. Every result block must
/// parse; blocks on page 0 are no match.
fn first_synctex_view_target(output: &str) -> Result<Option<PdfSyncTarget>, String> {
    // A successful `synctex view` prints only its version banner when the
    // source line has no PDF node (common for declarations in .sty files).
    // That is a valid no-match, not malformed SyncTeX data.
    let missing = |prefix: &str| format!("SyncTeX output is missing {prefix}");
    let mut first = None;
    for block in output.split("SyncTeX result begin").skip(1) {
        let body = block.split("SyncTeX result end").next().unwrap_or(block);
        let page: u32 = field(body, "Page:").ok_or_else(|| missing("Page:"))?;
        let x = coordinate(body, "h:")
            .or_else(|| coordinate(body, "x:"))
            .ok_or_else(|| missing("x:"))?;
        let y = coordinate(body, "v:")
            .or_else(|| coordinate(body, "y:"))
            .ok_or_else(|| missing("y:"))?;
        let width = coordinate(body, "W:").unwrap_or(24.0).max(1.0);
        let height = coordinate(body, "H:").unwrap_or(12.0).max(1.0);
        if page != 0 && first.is_none() {
            first = Some(PdfSyncTarget { page, x, y, width, height });
        }
    }
    Ok(first)
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

    #[test]
    fn parses_forward_synctex_results() {
        let target = first_synctex_view_target(&view_block("3", "487.120")).unwrap().unwrap();
        assert_eq!(target.page, 3);
        assert!((target.x - 154.230).abs() < 0.001);
        assert!((target.y - 487.120).abs() < 0.001);
        assert!((target.width - 306.142).abs() < 0.001);
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
