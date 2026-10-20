//! The agent's tools, each served by the same domain code as the app: file
//! reads and history-backed edits from `project`, the build and SyncTeX from
//! `latex`, unused symbols and the word count from the reference panel and
//! the status bar. Observations stay short and windowed (SWE-agent's lesson):
//! a diff, not the whole file; a log tail, not the log.

use super::protocol::Action;
use crate::latex::{self, BuildResult, PinnedBuild};
use crate::{commands, project, texcount};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::time::Duration;

/// Longest file window, PDF text and log tail an observation carries.
const MAX_READ_LINES: usize = 400;
const MAX_TEXT_CHARS: usize = 12_000;
const MAX_LOG_CHARS: usize = 4_000;
const MAX_DIAGNOSTICS: usize = 20;

/// What a build needs from the task and the episode.
pub(crate) struct BuildSettings<'a> {
    pub root: &'a str,
    pub engine: &'a str,
    pub epoch: u64,
    pub home: &'a Path,
    pub timeout: Duration,
}

/// Run one action that is not `submit` or `defer`, returning its public
/// observation and, for a compile, the build. A failed action is an
/// observation (`{"error": ...}`) the agent can read, not a protocol error.
pub(crate) fn run(
    workspace: &Path, action: &Action, settings: &BuildSettings,
) -> (Value, Option<BuildResult>) {
    let result = match action {
        Action::ListFiles {} => list_files(workspace).map(|files| json!({ "files": files })),
        Action::Read { path, from_line, to_line } => read(workspace, path, *from_line, *to_line),
        Action::Search { query } => project::search_files(workspace, query)
            .map(|results| json!({ "results": results.into_iter().take(50).collect::<Vec<_>>() })),
        Action::Edit { path, old, new } => edit(workspace, path, old, new),
        Action::Write { path, text } => write(workspace, path, text),
        Action::Compile {} => {
            return match compile(workspace, settings) {
                Ok(build) => (build_observation(&build), Some(build)),
                Err(error) => (json!({ "error": error }), None),
            }
        }
        Action::PdfText { page } => pdf_text(workspace, settings.root, *page),
        Action::Synctex { path, line } => latex::forward_search(workspace, path, *line, 0)
            .map(|target| json!({ "target": target })),
        Action::SynctexInverse { page, x, y } => latex::inverse_search(workspace, *page, *x, *y)
            .map(|target| json!({ "source": target })),
        Action::Check {} => check(workspace),
        Action::Submit { .. } | Action::Defer { .. } => {
            Err("submit and defer end the episode; the episode handles them".to_string())
        }
    };
    (result.unwrap_or_else(|error| json!({ "error": error })), None)
}

/// Project files as relative paths: Lattice's own state left out, build
/// artifacts kept (the agent may want to read `main.log`).
pub(crate) fn list_files(workspace: &Path) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(workspace).sort_by_file_name() {
        let entry = entry.map_err(|error| error.to_string())?;
        let relative = entry.path().strip_prefix(workspace).map_err(|error| error.to_string())?;
        if relative.starts_with(".research") || !entry.file_type().is_file() {
            continue;
        }
        files.push(relative.to_string_lossy().replace('\\', "/"));
    }
    Ok(files)
}

fn read(workspace: &Path, path: &str, from: Option<u32>, to: Option<u32>) -> Result<Value, String> {
    let text = project::read_file(workspace, path)?;
    let lines: Vec<&str> = text.lines().collect();
    let first = from.unwrap_or(1).max(1) as usize;
    let last = to.map(|to| to as usize).unwrap_or(lines.len()).min(lines.len());
    let last = last.min(first + MAX_READ_LINES - 1);
    let window = if first <= last { lines[first - 1..last].join("\n") } else { String::new() };
    Ok(
        json!({ "path": path, "fromLine": first, "toLine": last, "totalLines": lines.len(), "text": window }),
    )
}

fn current(workspace: &Path, path: &str) -> Result<Option<String>, String> {
    let absolute = project::safe_path(workspace, path)?;
    match fs::read_to_string(&absolute) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{path} could not be read: {error}")),
    }
}

fn edit(workspace: &Path, path: &str, old: &str, new: &str) -> Result<Value, String> {
    let before = current(workspace, path)?.ok_or_else(|| format!("{path} does not exist."))?;
    let count = if old.is_empty() { 0 } else { before.matches(old).count() };
    if count != 1 {
        return Err(format!(
            "The text to replace occurs {count} times in {path}; give a unique stretch of it."
        ));
    }
    save(workspace, path, Some(before.clone()), before.replacen(old, new, 1))
}

fn write(workspace: &Path, path: &str, text: &str) -> Result<Value, String> {
    let before = current(workspace, path)?;
    save(workspace, path, before, text.to_string())
}

/// Through the editor's transaction, so the episode keeps Lattice's history.
fn save(
    workspace: &Path, path: &str, before: Option<String>, after: String,
) -> Result<Value, String> {
    let base = before.clone();
    project::apply_editor_transaction(workspace, path.to_string(), after.clone(), base, None)?;
    let diff = diffy::create_patch(before.as_deref().unwrap_or(""), &after).to_string();
    Ok(json!({ "path": path, "ok": true, "diff": truncate(&diff, MAX_TEXT_CHARS) }))
}

pub(crate) fn compile(workspace: &Path, settings: &BuildSettings) -> Result<BuildResult, String> {
    latex::build_pinned(
        workspace,
        &PinnedBuild {
            document: settings.root,
            engine: settings.engine,
            epoch: settings.epoch,
            home: settings.home,
            timeout: settings.timeout,
        },
    )
}

/// A build as the agent sees it: the outcome and the diagnostics, without
/// timings or the passes latexmk ran.
pub(crate) fn build_observation(build: &BuildResult) -> Value {
    let errors = build.diagnostics.iter().filter(|d| d.level == "error").count();
    json!({
        "success": build.success,
        "hasPdf": build.has_pdf,
        "pages": build.pages,
        "errors": errors,
        "warnings": build.diagnostics.len() - errors,
        "diagnostics": build.diagnostics.iter().take(MAX_DIAGNOSTICS).collect::<Vec<_>>(),
        "logTail": tail(&build.log, MAX_LOG_CHARS),
    })
}

fn pdf_text(workspace: &Path, root: &str, page: Option<u32>) -> Result<Value, String> {
    let pdf = project::safe_path(workspace, root)?.with_extension("pdf");
    if !pdf.is_file() {
        return Err("Compile the paper first: there is no PDF yet.".to_string());
    }
    let mut command = commands::command("pdftotext");
    command.arg("-layout").arg("-enc").arg("UTF-8");
    if let Some(page) = page {
        command.args(["-f", &page.to_string(), "-l", &page.to_string()]);
    }
    let output = command
        .arg(&pdf)
        .arg("-")
        .output()
        .map_err(|error| format!("Could not start pdftotext: {error}"))?;
    if !output.status.success() {
        return Err(commands::stderr_or(&output, "pdftotext could not read the PDF."));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(json!({ "page": page, "text": truncate(&text, MAX_TEXT_CHARS) }))
}

fn check(workspace: &Path) -> Result<Value, String> {
    let unused = project::unused_symbols(workspace)?;
    let words = texcount::count_project(workspace).ok();
    Ok(json!({ "unused": unused, "words": words }))
}

fn truncate(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((cut, _)) => format!("{}\n… ({} more characters)", &text[..cut], text.len() - cut),
        None => text.to_string(),
    }
}

fn tail(text: &str, limit: usize) -> String {
    let count = text.chars().count();
    if count <= limit {
        return text.to_string();
    }
    let start = text.char_indices().nth(count - limit).map(|(index, _)| index).unwrap_or(0);
    format!("…{}", &text[start..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn settings(home: &Path) -> BuildSettings<'_> {
        BuildSettings {
            root: "main.tex",
            engine: "pdf",
            epoch: 0,
            home,
            timeout: Duration::from_secs(5),
        }
    }

    #[test]
    fn edits_need_a_unique_target_and_answer_with_a_diff() {
        let root = TempDir::new("env-actions");
        let home = TempDir::new("env-home");
        project::open(&root).unwrap();
        root.write("main.tex", "\\citpe{a} and \\citpe{b}\n");
        let (ambiguous, _) = run(
            &root,
            &Action::Edit { path: "main.tex".into(), old: "\\citpe".into(), new: "\\citep".into() },
            &settings(&home),
        );
        assert!(ambiguous["error"].as_str().unwrap().contains("occurs 2 times"), "{ambiguous}");
        let (edited, _) = run(
            &root,
            &Action::Edit {
                path: "main.tex".into(),
                old: "\\citpe{a}".into(),
                new: "\\citep{a}".into(),
            },
            &settings(&home),
        );
        assert_eq!(edited["ok"], true, "{edited}");
        assert!(edited["diff"].as_str().unwrap().contains("+\\citep{a} and \\citpe{b}"));
        assert_eq!(
            fs::read_to_string(root.join("main.tex")).unwrap(),
            "\\citep{a} and \\citpe{b}\n"
        );
    }

    #[test]
    fn reads_are_windowed_and_paths_stay_inside_the_project() {
        let root = TempDir::new("env-actions");
        let home = TempDir::new("env-home");
        root.write("main.tex", "one\ntwo\nthree\n");
        let action = Action::Read { path: "main.tex".into(), from_line: Some(2), to_line: Some(2) };
        let (window, _) = run(&root, &action, &settings(&home));
        assert_eq!(
            (window["text"].as_str(), window["totalLines"].as_u64()),
            (Some("two"), Some(3))
        );
        let escape = Action::Read { path: "../outside.tex".into(), from_line: None, to_line: None };
        assert!(run(&root, &escape, &settings(&home)).0.get("error").is_some());
        let files = list_files(&root).unwrap();
        assert_eq!(files, vec!["main.tex".to_string()]);
    }
}
