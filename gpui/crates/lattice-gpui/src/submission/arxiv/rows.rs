//! The arXiv export sheet's rows, ported from the Tauri app's
//! `src/project/arxiv-export.ts`: the pack and checks lattice-core reports
//! (`latex::check_arxiv`), and how each check reads as a row.
//!
//! A row's state is the backend's finding put as the sheet shows it: a
//! warning never blocks the export; a failure does.

use lattice_core::latex::{ArxivPackage, Bibliography, CommentLine, CompileOutcome};
use lattice_i18n::{join_phrases, t};

use crate::submission::format_size;

/// Names shown before the rest are counted.
const LISTED_NAMES: usize = 4;

/// A check's state as a row shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckState {
    Pending,
    Running,
    Ok,
    Warn,
    Fail,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckId {
    Figures,
    Bibliography,
    Compile,
    Comments,
    Size,
}

/// One row of the checks.
#[derive(Clone, Debug)]
pub struct CheckRow {
    pub id: CheckId,
    pub state: CheckState,
    pub label: String,
    pub detail: String,
    /// The row's own disclosure: the comments it found.
    pub review: Option<Vec<CommentLine>>,
}

fn row(
    id: CheckId,
    state: CheckState,
    label: impl Into<String>,
    detail: impl Into<String>,
) -> CheckRow {
    CheckRow {
        id,
        state,
        label: label.into(),
        detail: detail.into(),
        review: None,
    }
}

fn engine_name(engine: &str) -> &'static str {
    match engine.trim().to_ascii_lowercase().as_str() {
        "xelatex" => "XeLaTeX",
        "lualatex" => "LuaLaTeX",
        _ => "pdfLaTeX",
    }
}

/// The pack's top level: files by name, folders as `figures/`, files first.
pub fn top_level_names<S: AsRef<str>>(paths: &[S]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for path in paths {
        let path = path.as_ref();
        let name = match path.find('/') {
            Some(slash) => path[..=slash].to_string(),
            None => path.to_string(),
        };
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names.sort_by(|a, b| {
        a.ends_with('/')
            .cmp(&b.ends_with('/'))
            .then_with(|| a.cmp(b))
    });
    names
}

/// The archive's suggested name: the project's, as a file name can carry it.
pub fn archive_name(project_name: &str) -> String {
    let mut base = String::new();
    let mut in_run = false;
    for ch in project_name.trim().chars() {
        if matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            if !in_run {
                base.push('-');
            }
            in_run = true;
        } else {
            base.push(ch);
            in_run = false;
        }
    }
    if base.is_empty() {
        base = "paper".into();
    }
    format!("{base}-arxiv.zip")
}

pub fn summary_line(pack: &ArxivPackage) -> String {
    let count = pack.files.len();
    let files = if count == 1 {
        t!("1 file").to_string()
    } else {
        t!("{count} files", count = count)
    };
    let names = top_level_names(
        &pack
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
    );
    let mut shown = names
        .iter()
        .take(LISTED_NAMES)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if names.len() > LISTED_NAMES {
        shown.push_str(", …");
    }
    join_phrases(&[files, format_size(pack.total_bytes), shown])
}

pub fn left_out_line(left_out: &[String]) -> String {
    let names = left_out
        .iter()
        .take(LISTED_NAMES)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let hidden = left_out.len().saturating_sub(LISTED_NAMES);
    if hidden > 0 {
        t!(
            "Left out: {names} and {hidden} more",
            names = names,
            hidden = hidden
        )
    } else {
        t!("Left out: {names}", names = names)
    }
}

pub fn pending_rows() -> Vec<CheckRow> {
    vec![
        row(
            CheckId::Figures,
            CheckState::Pending,
            t!("Every figure is included"),
            "",
        ),
        row(
            CheckId::Bibliography,
            CheckState::Pending,
            t!("Bibliography travels as a .bbl"),
            "",
        ),
        row(
            CheckId::Compile,
            CheckState::Pending,
            t!("Builds from the package alone"),
            "",
        ),
        row(
            CheckId::Comments,
            CheckState::Pending,
            t!("Comments removed"),
            "",
        ),
        row(
            CheckId::Size,
            CheckState::Pending,
            t!("Under arXiv’s size limit"),
            "",
        ),
    ]
}

pub fn check_rows(pack: &ArxivPackage) -> Vec<CheckRow> {
    vec![
        figures_row(pack),
        bibliography_row(pack),
        compile_row(pack),
        comments_row(pack),
        size_row(pack),
    ]
}

fn figures_row(pack: &ArxivPackage) -> CheckRow {
    if let Some(first) = pack.missing.first() {
        let more = pack.missing.len() - 1;
        let detail = if more > 0 {
            t!(
                "{first} and {more} more; build again",
                first = first,
                more = more
            )
        } else {
            t!("{first}; build again", first = first)
        };
        return row(
            CheckId::Figures,
            CheckState::Fail,
            t!("Files the last build used are missing"),
            detail,
        );
    }
    // The test build runs on this Mac and passes; arXiv's TeX runs on Linux
    // and cannot find a folder named in another case, so this is the place
    // to say it.
    if let Some(first) = pack.miscased.first() {
        let more = pack.miscased.len() - 1;
        let (written, file) = (&first.written, &first.file);
        let detail = if more > 0 {
            t!(
                "{written} is {file} on disk, and {more} more; arXiv can fail to find them",
                written = written,
                file = file,
                more = more
            )
        } else {
            t!(
                "{written} is {file} on disk; arXiv can fail to find it",
                written = written,
                file = file
            )
        };
        return row(
            CheckId::Figures,
            CheckState::Warn,
            t!("The source spells file names in another case"),
            detail,
        );
    }
    let count = pack.figures.len();
    let detail = match count {
        0 => t!("The paper has no figures").to_string(),
        1 => t!("1 figure").to_string(),
        _ => t!("{count} figures", count = count),
    };
    row(
        CheckId::Figures,
        CheckState::Ok,
        t!("Every figure is included"),
        detail,
    )
}

fn bibliography_row(pack: &ArxivPackage) -> CheckRow {
    match &pack.bibliography {
        Bibliography::Included { file } => row(
            CheckId::Bibliography,
            CheckState::Ok,
            t!("Bibliography travels as {file}", file = file),
            "",
        ),
        Bibliography::Missing => row(
            CheckId::Bibliography,
            CheckState::Fail,
            t!("The bibliography has no .bbl"),
            t!("Build the paper so it has one; arXiv doesn’t run BibTeX"),
        ),
        Bibliography::None => row(
            CheckId::Bibliography,
            CheckState::Ok,
            t!("No bibliography to include"),
            "",
        ),
    }
}

fn compile_row(pack: &ArxivPackage) -> CheckRow {
    let label = t!("Builds from the package alone");
    let engine = engine_name(&pack.engine);
    let compile = match &pack.compile {
        Some(compile) if compile.outcome != CompileOutcome::Cancelled => compile,
        _ => {
            return row(
                CheckId::Compile,
                CheckState::Running,
                label,
                t!("{engine} in a clean folder…", engine = engine),
            );
        }
    };
    match compile.outcome {
        CompileOutcome::TimedOut => row(
            CheckId::Compile,
            CheckState::Fail,
            t!("The package did not finish building"),
            t!("Stopped after 2 minutes"),
        ),
        CompileOutcome::Failed => {
            let detail = match &compile.error {
                Some(error) => {
                    let place = match (&error.file, error.line) {
                        (Some(file), Some(line)) => format!("{file}:{line}: "),
                        (Some(file), None) => format!("{file}: "),
                        _ => String::new(),
                    };
                    format!("{place}{}", error.message)
                }
                None => t!("See the log for why").to_string(),
            };
            row(
                CheckId::Compile,
                CheckState::Fail,
                t!("The package does not build alone"),
                detail,
            )
        }
        _ => {
            let seconds = format!("{:.1}", compile.duration_ms as f64 / 1000.);
            let pages = match compile.pages {
                None => String::new(),
                Some(1) => t!("1 page").to_string(),
                Some(count) => t!("{count} pages", count = count),
            };
            let built = join_phrases(&[
                engine.to_string(),
                pages,
                t!("{seconds} s", seconds = seconds),
            ]);
            if engine != "pdfLaTeX" {
                row(
                    CheckId::Compile,
                    CheckState::Warn,
                    label,
                    t!("{built}; arXiv builds with pdfLaTeX", built = built),
                )
            } else {
                row(CheckId::Compile, CheckState::Ok, label, built)
            }
        }
    }
}

fn comments_row(pack: &ArxivPackage) -> CheckRow {
    let comments = &pack.comments;
    if comments.count == 0 {
        return row(
            CheckId::Comments,
            CheckState::Ok,
            t!("No comments in the source"),
            "",
        );
    }
    let counted = if comments.count == 1 {
        t!("1 comment line").to_string()
    } else {
        t!("{count} comment lines", count = comments.count)
    };
    let detail = match comments.todos {
        0 => counted,
        1 => t!("{counted}, 1 of them a TODO", counted = counted),
        todos => t!(
            "{counted}, {todos} of them TODOs",
            counted = counted,
            todos = todos
        ),
    };
    let (state, label) = if !comments.removed {
        (CheckState::Warn, t!("Comments will be published"))
    } else if comments.todos > 0 {
        (CheckState::Warn, t!("Comments removed"))
    } else {
        (CheckState::Ok, t!("Comments removed"))
    };
    CheckRow {
        review: Some(comments.lines.clone()),
        ..row(CheckId::Comments, state, label, detail)
    }
}

fn size_row(pack: &ArxivPackage) -> CheckRow {
    let size = format_size(pack.total_bytes);
    let limit = format_size(pack.size_limit_bytes);
    if pack.total_bytes <= pack.size_limit_bytes {
        row(
            CheckId::Size,
            CheckState::Ok,
            t!("Under arXiv’s size limit"),
            t!("{size} of {limit}", size = size, limit = limit),
        )
    } else {
        row(
            CheckId::Size,
            CheckState::Fail,
            t!("Over arXiv’s size limit"),
            t!(
                "{size} of {limit}; leave out large figures",
                size = size,
                limit = limit
            ),
        )
    }
}

/// The line beside the buttons: what the checks came to.
pub fn status_line(running: bool, has_pack: bool, rows: &[CheckRow]) -> String {
    let failures = rows
        .iter()
        .filter(|row| row.state == CheckState::Fail)
        .count();
    let warnings = rows
        .iter()
        .filter(|row| row.state == CheckState::Warn)
        .count();
    if running {
        t!("Checking…").to_string()
    } else if failures > 0 {
        if failures == 1 {
            t!("1 to fix").to_string()
        } else {
            t!("{failures} to fix", failures = failures)
        }
    } else if warnings > 0 {
        if warnings == 1 {
            t!("Ready, 1 to look at").to_string()
        } else {
            t!("Ready, {warnings} to look at", warnings = warnings)
        }
    } else if has_pack {
        t!("Ready").to_string()
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_archive_after_the_project() {
        assert_eq!(archive_name("My Paper"), "My Paper-arxiv.zip");
        assert_eq!(archive_name("a/b:c"), "a-b-c-arxiv.zip");
        assert_eq!(archive_name("  "), "paper-arxiv.zip");
    }

    #[test]
    fn lists_the_top_level_files_first() {
        let names = top_level_names(&[
            "main.tex",
            "figures/a.pdf",
            "figures/b.pdf",
            "main.bbl",
            "sec/intro.tex",
        ]);
        assert_eq!(names, ["main.bbl", "main.tex", "figures/", "sec/"]);
    }

    #[test]
    fn says_what_the_checks_came_to() {
        let mut rows = pending_rows();
        assert_eq!(status_line(true, false, &rows), "Checking…");
        assert_eq!(status_line(false, false, &rows), "");
        rows[0].state = CheckState::Warn;
        assert_eq!(status_line(false, true, &rows), "Ready, 1 to look at");
        rows[1].state = CheckState::Fail;
        rows[2].state = CheckState::Fail;
        assert_eq!(status_line(false, true, &rows), "2 to fix");
    }

    #[test]
    fn names_the_engine_as_arxiv_does() {
        assert_eq!(engine_name("pdf"), "pdfLaTeX");
        assert_eq!(engine_name(" XeLaTeX "), "XeLaTeX");
        assert_eq!(engine_name("lualatex"), "LuaLaTeX");
    }
}
