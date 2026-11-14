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

use std::path::{Path, PathBuf};

use base64::Engine as _;
use gpui::{App, AppContext as _, Task};
use lattice_core::{
    agent_literature::AgentBibliographyMutation,
    papers::{self, CitationRemovalMode},
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
        "agent_bibliography_mutation" => {
            let checked = pinned(root, &args, "the action could start");
            let mutation = args.get("mutation").cloned().unwrap_or(Value::Null);
            cx.background_spawn(async move {
                let root = checked?;
                let mutation: AgentBibliographyMutation = serde_json::from_value(mutation)
                    .map_err(|error| format!("Invalid bibliography request: {error}"))?;
                mutation.into_request()?.run(&root)
            })
        }
        "remove_reference" => {
            let checked = pinned(root, &args, "the action could start");
            let key = text(&args, "key").unwrap_or_default();
            let mode = match args.get("citationMode").and_then(Value::as_str) {
                None => Ok(CitationRemovalMode::Block),
                Some("preview") => Ok(CitationRemovalMode::Preview),
                Some("keep") => Ok(CitationRemovalMode::Keep),
                Some("remove") => Ok(CitationRemovalMode::Remove),
                Some(_) => {
                    Err("Choose whether to keep or remove manuscript citations.".to_string())
                }
            };
            cx.background_spawn(async move {
                let root = checked?;
                json(papers::remove_reference(&root, &key, mode?)?)
            })
        }
        "read_project_file" => {
            let checked = maybe_pinned(root, &args, "the file could be read");
            let path = text(&args, "path").unwrap_or_default();
            cx.background_spawn(async move {
                lattice_core::project::read_file(&checked?, &path).map(Value::String)
            })
        }
        "prepare_latex_figure" => {
            let checked = pinned(root, &args, "the figure could be prepared");
            let path = text(&args, "path").unwrap_or_default();
            cx.background_spawn(async move {
                lattice_core::project::prepare_latex_figure(&checked?, &path).map(Value::String)
            })
        }
        "preview_latex_figure" => {
            let checked = pinned(root, &args, "the figure could be previewed");
            let request = args.get("request").cloned().unwrap_or(Value::Null);
            cx.background_spawn(async move {
                let root = checked?;
                let request: lattice_core::latex::FigurePreviewRequest =
                    serde_json::from_value(request)
                        .map_err(|error| format!("Invalid figure preview: {error}"))?;
                json(lattice_core::latex::preview_figure(&root, &request)?)
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
        _ => Task::ready(Err(format!("{command} is not an Agent command"))),
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

    #[test]
    fn a_request_reaches_only_the_panels_project() {
        let dir = project();
        let other = tempfile::tempdir().unwrap();
        let root = dir.path();
        let own = json!({ "projectRoot": root.to_string_lossy() });
        assert_eq!(pinned(root, &own, "x").unwrap(), root);
        let elsewhere = json!({ "projectRoot": other.path().to_string_lossy() });
        assert!(pinned(root, &elsewhere, "x").is_err());
        assert!(pinned(root, &json!({}), "x").is_err());
        // A read may leave its project unnamed, but not name another one.
        assert_eq!(maybe_pinned(root, &json!({}), "x").unwrap(), root);
        assert!(maybe_pinned(root, &elsewhere, "x").is_err());
    }

    #[test]
    fn the_bibliography_takes_only_the_closed_mutations() {
        // Anything beyond cite and upgrade_bibliography, or an extra field,
        // is not a mutation lattice-core accepts.
        for refused in [
            json!({ "action": "write_bib", "path": "references.bib", "text": "@misc{x}" }),
            json!({ "action": "cite", "query": "x", "path": "references.bib" }),
            json!({ "action": "delete", "key": "kept" }),
        ] {
            assert!(
                serde_json::from_value::<AgentBibliographyMutation>(refused.clone()).is_err(),
                "{refused}"
            );
        }
        assert!(
            serde_json::from_value::<AgentBibliographyMutation>(
                json!({ "action": "upgrade_bibliography", "dryRun": true })
            )
            .is_ok()
        );
    }

    #[test]
    fn a_removal_is_previewed_before_anything_is_written() {
        let dir = project();
        let preview = papers::remove_reference(dir.path(), "kept", CitationRemovalMode::Preview)
            .map(|result| serde_json::to_value(result).unwrap())
            .unwrap();
        assert_eq!(preview["key"], "kept");
        assert!(
            std::fs::read_to_string(dir.path().join("references.bib"))
                .unwrap()
                .contains("@article{kept,")
        );
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

    #[test]
    fn every_command_the_agent_page_invokes_is_answered() {
        // What `src/agent` and `use-synara-host.ts` invoke (the surface
        // answers the window's and the app's: the save panel, the browser
        // and the clipboard).
        for command in [
            "synara_ensure_ready",
            "synara_restart",
            "synara_open_log_folder",
            "agent_bibliography_mutation",
            "remove_reference",
            "read_project_file",
            "prepare_latex_figure",
            "preview_latex_figure",
            "save_agent_visual",
            "set_agent_turn_running",
            "get_model_endpoint",
        ] {
            assert!(handles(command), "{command}");
        }
        assert!(!handles("write_project_file"));
        assert!(!handles("delete_entry"));
    }
}
