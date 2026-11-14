//! The Tauri backend commands the Agent's page invokes (`tauri:invoke`), each
//! answered as the Tauri app's command answers it, through lattice-core.
//!
//! These are the host brokers of the Agent: what it may do in the project
//! only through Lattice, because the sidecar runs where it cannot do it
//! itself (`runtime.rs`). The bibliography is the boundary: the sandbox
//! denies every `.bib` write from the Agent's processes, and the only ways a
//! reference reaches or leaves a bibliography are the three mutations here,
//! as closed as the Tauri app's (`ipc/bibliography.rs`):
//!
//! - `agent_bibliography_mutation`: `cite` (a reference resolved and
//!   verified by lattice-core, never text the Agent wrote) and
//!   `upgrade_bibliography` (preprints to their published records), parsed
//!   by lattice-core's `AgentBibliographyMutation`, which accepts nothing
//!   else;
//! - `remove_reference`: a preview, then the removal only once the writer
//!   confirmed it in the app's dialog (`agent-reference-removal.ts` asks).
//!
//! Every command naming a project is refused unless it names the panel's own
//! (the Tauri app's `pinned_root`): a page cannot reach another project, even
//! one open in another window.
//!
//! The project documents the Tauri app's window keeps for the Agent are read
//! and written here as its commands do: the paper library (`list_papers`),
//! the annotations and their revision rounds the annotation tools record
//! into, the Overleaf threads its comments view reads, and the one file the
//! page itself writes, a closed spreadsheet the range tools changed
//! (`write_project_file`, refused for anything but a `.lattice-sheet`).

use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use base64::Engine as _;
use gpui::{App, AppContext as _, Task};
use lattice_core::{
    agent_literature::AgentBibliographyMutation,
    papers::{self, CitationRemovalMode},
    project,
};
use serde_json::{Value, json};

use super::runtime::AgentRuntime;

/// The commands answered here; the surface answers the ones that need a
/// window (the save panel) or the app (the browser, the clipboard).
pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "synara_ensure_ready"
            | "synara_restart"
            | "synara_open_log_folder"
            | "synara_open_skills_folder"
            | "synara_agent_environment"
            | "agent_bibliography_mutation"
            | "remove_reference"
            | "read_project_file"
            | "prepare_latex_figure"
            | "preview_latex_figure"
            | "save_agent_visual"
            | "agent_text_task"
            | "set_agent_turn_running"
            | "get_model_endpoint"
            | "list_papers"
            | "list_annotations"
            | "save_annotations"
            | "read_annotation_round"
            | "save_annotation_round"
            | "write_project_file"
            | "overleaf_threads"
            | "overleaf_comment_anchors"
    )
}

fn text(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

/// The project a request names, which must be the panel's (`pinned_root`).
fn pinned(root: &Path, args: &Value, action: &str) -> Result<PathBuf, String> {
    let asked = text(args, "projectRoot").ok_or_else(|| "No project".to_string())?;
    if !same_root(Path::new(&asked), root) {
        return Err(format!("The project changed before {action}."));
    }
    Ok(root.to_path_buf())
}

/// A request that may leave its project unnamed (`maybe_pinned_root`).
fn maybe_pinned(root: &Path, args: &Value, action: &str) -> Result<PathBuf, String> {
    match args.get("projectRoot").and_then(Value::as_str) {
        Some(_) => pinned(root, args, action),
        None => Ok(root.to_path_buf()),
    }
}

pub(super) fn same_root(a: &Path, b: &Path) -> bool {
    let canonical = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    canonical(a) == canonical(b)
}

fn json<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

/// Answer `command` for the panel showing `root`, off the main thread.
pub fn invoke(
    root: &Path,
    command: &str,
    payload: &Value,
    cx: &mut App,
) -> Task<Result<Value, String>> {
    let args = payload.get("args").cloned().unwrap_or(Value::Null);
    let runtime = AgentRuntime::get(cx);
    match command {
        "synara_ensure_ready" => runtime.ensure_ready(cx),
        "synara_restart" => {
            let restart = runtime.restart(cx);
            cx.background_spawn(async move {
                restart.await;
                Ok(Value::Null)
            })
        }
        // Reveal the logs a startup failure quotes from; nothing is created,
        // so a runtime that wrote none says so (`Ok(false)`).
        "synara_open_log_folder" => {
            let log_dir = runtime.supervisor().sidecar_log_dir();
            if !log_dir.is_dir() {
                return Task::ready(Ok(Value::Bool(false)));
            }
            cx.reveal_path(&log_dir);
            Task::ready(Ok(Value::Bool(true)))
        }
        "synara_open_skills_folder" => {
            let skills = super::agent_home().join("skills");
            match std::fs::create_dir_all(&skills) {
                Ok(()) => {
                    cx.open_with_system(&skills);
                    Task::ready(Ok(Value::Null))
                }
                Err(error) => Task::ready(Err(error.to_string())),
            }
        }
        "synara_agent_environment" => {
            let supervisor = runtime.supervisor().clone();
            cx.background_spawn(async move { json(supervisor.agent_environment()) })
        }
        "get_model_endpoint" => cx.background_spawn(async move {
            lattice_core::runtime::block_on(lattice_core::model_endpoint::get_model_endpoint(
                super::agent_home(),
            ))
            .and_then(json)
        }),
        // The Tauri app keeps a running turn from an app restart; the GPUI
        // app restarts nothing under the writer.
        "set_agent_turn_running" => Task::ready(Ok(Value::Null)),
        "agent_text_task" => {
            let action = text(&args, "action").unwrap_or_default();
            // Status and cancel may name the outgoing project.
            let checked = if action == "start" {
                pinned(root, &args, "the agent task could start").map(|_| ())
            } else {
                Ok(())
            };
            let supervisor = runtime.supervisor().clone();
            cx.background_spawn(async move {
                checked?;
                lattice_core::synara::task_relay_request(
                    &supervisor,
                    lattice_core::synara::TEXT_TASK_ROUTE,
                    &action,
                    args.get("taskId").and_then(Value::as_str),
                    json!({ "workspaceRoot": args.get("projectRoot"), "prompt": args.get("prompt") }),
                )
            })
        }
        // An Agent visual's HTML, which the panel cannot download itself
        // (WebKit cancels a frame's download), where the writer chose.
        "save_agent_visual" => {
            let request = binary_save(
                payload,
                "x-html-destination",
                "Choose where to save the visual.",
                "The visual was not sent as binary data.",
            );
            cx.background_spawn(async move {
                let (path, bytes) = request?;
                lattice_core::export::save(&path, &bytes, &lattice_core::export::HTML)
                    .map(Value::String)
            })
        }
        // The page numbers its saves from 1 each time it loads, but
        // lattice-core keeps the newest save written for a project for the
        // whole process and drops an older one: a reloaded page's saves would
        // all be dropped. The broker numbers them instead, as they arrive.
        "save_annotations" => {
            let save = ANNOTATION_SAVES.fetch_add(1, Ordering::Relaxed) + 1;
            let root = root.to_path_buf();
            cx.background_spawn(async move { save_annotations(&root, &args, save) })
        }
        _ => {
            let root = root.to_path_buf();
            let command = command.to_string();
            cx.background_spawn(async move { project_command(&root, &command, &args) })
        }
    }
}

/// The annotation saves this process has sent, across every page.
static ANNOTATION_SAVES: AtomicU64 = AtomicU64::new(0);

/// `save_annotations`: the whole list and its rounds, as save `save`.
fn save_annotations(root: &Path, args: &Value, save: u64) -> Result<Value, String> {
    let root = pinned(root, args, "saving the annotations")?;
    let field = |key: &str| args.get(key).cloned().unwrap_or(Value::Null);
    let annotations: Vec<project::EditorComment> = serde_json::from_value(field("annotations"))
        .map_err(|error| format!("Invalid annotations: {error}"))?;
    let rounds: Vec<project::AnnotationRound> = serde_json::from_value(field("rounds"))
        .map_err(|error| format!("Invalid revision rounds: {error}"))?;
    project::write_annotations(&root, annotations, rounds, save).map(|()| Value::Null)
}

/// A revision round's number.
fn round_number(args: &Value) -> Result<u32, String> {
    args.get("number")
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok())
        .ok_or_else(|| "No revision round".to_string())
}

/// Answer a command that reads or changes the project at `root` and needs
/// nothing of the app, on the thread it is called from.
fn project_command(root: &Path, command: &str, args: &Value) -> Result<Value, String> {
    match command {
        "agent_bibliography_mutation" => {
            let root = pinned(root, args, "the action could start")?;
            let mutation = args.get("mutation").cloned().unwrap_or(Value::Null);
            let mutation: AgentBibliographyMutation = serde_json::from_value(mutation)
                .map_err(|error| format!("Invalid bibliography request: {error}"))?;
            mutation.into_request()?.run(&root)
        }
        "remove_reference" => {
            let root = pinned(root, args, "the action could start")?;
            let key = text(args, "key").unwrap_or_default();
            let mode = match args.get("citationMode").and_then(Value::as_str) {
                None => CitationRemovalMode::Block,
                Some("preview") => CitationRemovalMode::Preview,
                Some("keep") => CitationRemovalMode::Keep,
                Some("remove") => CitationRemovalMode::Remove,
                Some(_) => {
                    return Err(
                        "Choose whether to keep or remove manuscript citations.".to_string()
                    );
                }
            };
            json(papers::remove_reference(&root, &key, mode)?)
        }
        "read_project_file" => {
            let root = maybe_pinned(root, args, "the file could be read")?;
            let path = text(args, "path").unwrap_or_default();
            lattice_core::project::read_file(&root, &path).map(Value::String)
        }
        "prepare_latex_figure" => {
            let root = pinned(root, args, "the figure could be prepared")?;
            let path = text(args, "path").unwrap_or_default();
            lattice_core::project::prepare_latex_figure(&root, &path).map(Value::String)
        }
        "preview_latex_figure" => {
            let root = pinned(root, args, "the figure could be previewed")?;
            let request = args.get("request").cloned().unwrap_or(Value::Null);
            let request: lattice_core::latex::FigurePreviewRequest =
                serde_json::from_value(request)
                    .map_err(|error| format!("Invalid figure preview: {error}"))?;
            json(lattice_core::latex::preview_figure(&root, &request)?)
        }
        "list_papers" => json(papers::list_papers(root)?),
        "list_annotations" => json(project::read_annotations(root)?),
        "read_annotation_round" => json(project::read_annotation_round(root, round_number(args)?)?),
        "save_annotation_round" => {
            let root = pinned(root, args, "saving the revision round")?;
            let files: Vec<lattice_core::models::FileChange> =
                serde_json::from_value(args.get("files").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Invalid revision round: {error}"))?;
            let settled = args
                .get("settled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            json(project::save_annotation_round(
                &root,
                round_number(args)?,
                files,
                settled,
            )?)
        }
        // A spreadsheet the range tools changed while it was not open
        // (`use-agent-spreadsheet-resolver.ts`); nothing else is the page's
        // to write, and never a bibliography.
        "write_project_file" => {
            let root = pinned(root, args, "the file could be written")?;
            let path = text(args, "path").unwrap_or_default();
            if !path.to_lowercase().ends_with(".lattice-sheet") {
                return Err(format!(
                    "The Agent's page writes only spreadsheets, not {path}."
                ));
            }
            let content = text(args, "content").unwrap_or_default();
            json(project::apply_editor_transaction(
                &root,
                path,
                content,
                text(args, "baseContent"),
                text(args, "expectedContent"),
            )?)
        }
        "overleaf_threads" => {
            let root = pinned(root, args, "the comments could be read")?;
            json(lattice_core::overleaf::threads(
                &crate::overleaf::config_dir(),
                &root,
            )?)
        }
        "overleaf_comment_anchors" => {
            let root = pinned(root, args, "the comments could be read")?;
            json(lattice_core::overleaf::comment_anchors(
                &crate::overleaf::config_dir(),
                &root,
            )?)
        }
        _ => Err(format!("{command} is not an Agent command")),
    }
}

/// A binary save's destination (a base64 UTF-8 header) and its bytes (the
/// request body, base64 over the bridge), as `ipc/files.rs`'s `binary_save`.
fn binary_save(
    payload: &Value,
    header: &str,
    no_destination: &str,
    not_binary: &str,
) -> Result<(PathBuf, Vec<u8>), String> {
    let engine = base64::engine::general_purpose::STANDARD;
    let destination = payload
        .get("headers")
        .and_then(|headers| headers.get(header))
        .and_then(Value::as_str)
        .and_then(|encoded| engine.decode(encoded).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|path| !path.is_empty())
        .ok_or_else(|| no_destination.to_string())?;
    let bytes = payload
        .get("base64")
        .and_then(Value::as_str)
        .and_then(|encoded| engine.decode(encoded).ok())
        .ok_or_else(|| not_binary.to_string())?;
    Ok((PathBuf::from(destination), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("main.tex"), "\\documentclass{article}").unwrap();
        std::fs::write(
            dir.path().join("references.bib"),
            "@article{kept,\n  title = {Kept},\n  author = {A. Author},\n  year = {2020}\n}\n",
        )
        .unwrap();
        lattice_core::project::open(dir.path()).unwrap();
        dir
    }

    fn bib(dir: &tempfile::TempDir) -> String {
        std::fs::read_to_string(dir.path().join("references.bib")).unwrap()
    }

    #[test]
    fn a_request_reaches_only_the_panels_project() {
        let dir = project();
        let other = tempfile::tempdir().unwrap();
        let root = dir.path();
        let read = |args: Value| project_command(root, "read_project_file", &args);
        let own = json!({ "projectRoot": root.to_string_lossy(), "path": "main.tex" });
        assert_eq!(read(own).unwrap(), "\\documentclass{article}");
        // A read may leave its project unnamed, but not name another one.
        assert_eq!(
            read(json!({ "path": "main.tex" })).unwrap(),
            "\\documentclass{article}"
        );
        let elsewhere =
            json!({ "projectRoot": other.path().to_string_lossy(), "path": "main.tex" });
        assert!(read(elsewhere).is_err());
        // A change must name the panel's project.
        let removal = json!({ "key": "kept", "citationMode": "remove" });
        assert!(project_command(root, "remove_reference", &removal).is_err());
        let removal = json!({
            "projectRoot": other.path().to_string_lossy(),
            "key": "kept",
            "citationMode": "remove",
        });
        assert!(project_command(root, "remove_reference", &removal).is_err());
        assert!(bib(&dir).contains("@article{kept,"));
    }

    #[test]
    fn the_bibliography_takes_only_the_closed_mutations() {
        // Anything beyond cite and upgrade_bibliography, or an extra field,
        // is not a mutation lattice-core accepts.
        let dir = project();
        let before = bib(&dir);
        for refused in [
            json!({ "action": "write_bib", "path": "references.bib", "text": "@misc{x}" }),
            json!({ "action": "cite", "query": "x", "path": "references.bib" }),
            json!({ "action": "delete", "key": "kept" }),
        ] {
            let args = json!({ "projectRoot": dir.path().to_string_lossy(), "mutation": refused });
            assert!(
                project_command(dir.path(), "agent_bibliography_mutation", &args).is_err(),
                "{args}"
            );
        }
        // Nor does the Agent reach a command the page has no business with.
        let write =
            json!({ "projectRoot": dir.path().to_string_lossy(), "path": "references.bib" });
        assert!(project_command(dir.path(), "write_project_file", &write).is_err());
        assert_eq!(bib(&dir), before);
    }

    #[test]
    fn a_removal_is_previewed_before_anything_is_written() {
        let dir = project();
        let before = bib(&dir);
        let args = |mode: &str| json!({ "projectRoot": dir.path().to_string_lossy(), "key": "kept", "citationMode": mode });
        let preview = project_command(dir.path(), "remove_reference", &args("preview")).unwrap();
        assert_eq!(preview["key"], "kept");
        assert_eq!(bib(&dir), before);
        assert!(project_command(dir.path(), "remove_reference", &args("purge")).is_err());
        assert_eq!(bib(&dir), before);
        // The writer's choice is what removes it.
        project_command(dir.path(), "remove_reference", &args("remove")).unwrap();
        assert!(!bib(&dir).contains("@article{kept,"));
    }

    #[test]
    fn a_visual_save_names_its_destination_and_carries_its_bytes() {
        let engine = base64::engine::general_purpose::STANDARD;
        let payload = json!({
            "headers": { "x-html-destination": engine.encode("/tmp/图.html") },
            "base64": engine.encode(b"<html></html>"),
        });
        let (path, bytes) = binary_save(&payload, "x-html-destination", "a", "b").unwrap();
        assert_eq!(path, PathBuf::from("/tmp/图.html"));
        assert_eq!(bytes, b"<html></html>");
        assert!(binary_save(&json!({ "base64": "" }), "x-html-destination", "a", "b").is_err());
    }
}
