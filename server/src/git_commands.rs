//! The human version timeline over the same Git domain as desktop IPC.
//! This is not part of the agent iframe command allowlist or Git writeback.
use crate::{dispatch::Core, git};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub const COMMANDS: &[&str] = &[
    "git_user_name",
    "git_show_diff",
    "git_compare_files",
    "git_compare_file",
    "git_restore_file",
    "git_restore_project",
    "git_auto_commit",
];

fn string<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| format!("Missing string argument: {key}"))
}
fn optional<'a>(args: &'a Value, key: &str) -> Result<Option<&'a str>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        _ => Err(format!("Invalid string argument: {key}")),
    }
}
fn output<T: Serialize>(value: Result<T, String>) -> Result<Value, String> {
    value.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

pub fn invoke(core: &Arc<Core>, command: &str, args: &Value) -> Result<Value, String> {
    // Also serialize reads with editor writes so a two-sided diff is a single
    // project observation, and a restore's recovery snapshot cannot race a save.
    let _lease = core.mutations.lock().map_err(|_| "Project mutation state unavailable")?;
    let root = &core.root;
    // Native revision paths are relative to the repository. Until those domain
    // reads/restores support a folder prefix, do not let a server project read
    // a sibling's blob or restore the wrong set of tracked paths.
    if matches!(
        command,
        "git_show_diff"
            | "git_compare_files"
            | "git_compare_file"
            | "git_restore_file"
            | "git_restore_project"
    ) && !git::project_prefix(root)?.is_empty()
    {
        return Err(
            "Git comparison and restore require opening the repository root as the project.".into(),
        );
    }
    if matches!(command, "git_auto_commit" | "git_restore_file" | "git_restore_project") {
        if let Some(expected) = optional(args, "expectedHead")? {
            let current = git::log(root, 1)?.first().map(|entry| entry.hash.clone());
            if current.as_deref() != Some(expected) {
                return Err(
                    "The Git version changed. Refresh the timeline before trying again.".into()
                );
            }
        }
    }
    let value = match command {
        "git_user_name" => json!(git::user_name(root)),
        "git_show_diff" => {
            output(git::show_diff(root, string(args, "rev")?, string(args, "path")?))?
        }
        "git_compare_files" => {
            output(git::compare_files(root, string(args, "from")?, optional(args, "to")?))?
        }
        "git_compare_file" => output(git::compare_file(
            root,
            string(args, "from")?,
            optional(args, "to")?,
            string(args, "path")?,
            optional(args, "fromPath")?,
        ))?,
        "git_auto_commit" => {
            output(git::auto_commit(root, string(args, "message")?, optional(args, "author")?))?
        }
        "git_restore_file" => {
            let (rev, path) = (string(args, "rev")?, string(args, "path")?);
            git::validate_restore(root, rev, Some(path))?;
            if let Some(expected) = optional(args, "expectedContent")? {
                if crate::project::read_file(root, path)? != expected {
                    return Err(
                        "The file changed. Refresh the comparison before restoring it.".into()
                    );
                }
            }
            git::auto_commit(root, "Before restoring a file", None)?;
            output(git::restore_file(root, rev, path))?
        }
        "git_restore_project" => {
            let rev = string(args, "rev")?;
            git::validate_restore(root, rev, None)?;
            git::auto_commit(root, "Before restoring the project", None)?;
            output(git::restore_project(root, rev))?
        }
        _ => return Err("unsupported_command: Git operation unavailable".into()),
    };
    if matches!(command, "git_restore_file" | "git_restore_project" | "git_auto_commit") {
        let _ = core
            .events
            .send(json!({"event":"project-fs-changed","payload":{"root":root,"paths":null}}));
    }
    Ok(value)
}
