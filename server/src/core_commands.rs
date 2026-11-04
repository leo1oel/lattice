//! Desktop-independent project operations with the native IPC names and shapes.
use crate::{dispatch::Core, latex, project};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
pub const COMMANDS: &[&str] = &[
    "synctex_view",
    "synctex_edit",
    "synctex_body_pages",
    "synctex_heading_pages",
    "revert_transaction",
    "revert_history_file",
    "delete_history_entry",
    "write_project_bytes",
    "save_annotations",
    "save_annotation_round",
    "read_annotation_round",
    "restore_annotation_round",
    "set_project_deadline",
    "set_submission_items",
    "set_project_spelling_words",
    "set_project_grammar_ignores",
    "preview_replace_in_project",
    "replace_in_project",
    "find_symbol_occurrences",
    "rename_symbol",
    "list_citation_usages",
    "find_moved_project_file",
    "export_project_zip",
    "import_project_zip",
];
fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|_| format!("Invalid or missing argument: {key}"))
}
fn output<T: Serialize>(value: Result<T, String>) -> Result<Value, String> {
    value.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}
fn target(core: &Core, path: &str) -> Result<PathBuf, String> {
    let input = Path::new(path);
    if !input
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Err("Choose a .zip destination for the source archive.".into());
    }
    let canonical;
    let path = if input.is_absolute() {
        canonical = input
            .parent()
            .ok_or("Invalid destination")?
            .canonicalize()
            .map_err(|e| e.to_string())?
            .join(input.file_name().ok_or("Invalid destination")?);
        canonical.as_path()
    } else {
        input
    };
    let relative = if path.is_absolute() {
        path.strip_prefix(&core.root)
            .map_err(|_| "Destination is outside this project".to_string())?
    } else {
        path
    };
    if relative.components().any(|part| {
        matches!(part, std::path::Component::Normal(name) if name == ".research" || name == ".git")
    }) {
        return Err("Source archives cannot replace project control files.".into());
    }
    project::creation_path(&core.root, &relative.to_string_lossy())
}
pub fn invoke(core: &Arc<Core>, command: &str, args: &Value) -> Result<Value, String> {
    // Use the same project mutation lock as ordinary editor writes.
    let _lease =
        core.mutations.lock().map_err(|_| "Project mutation state unavailable".to_string())?;
    let root = &core.root;
    let string = |key: &str| arg::<String>(args, key);
    let flag = |key: &str, default| args.get(key).and_then(Value::as_bool).unwrap_or(default);
    match command {
        "synctex_view" => output(latex::forward_search(
            root,
            &string("path")?,
            arg(args, "line")?,
            arg(args, "column")?,
        )),
        "synctex_edit" => output(latex::inverse_search(
            root,
            arg(args, "page")?,
            arg(args, "x")?,
            arg(args, "y")?,
        )),
        "synctex_body_pages" => {
            output(latex::body_pages(root, &arg::<Vec<latex::BodySpan>>(args, "spans")?))
        }
        "synctex_heading_pages" => {
            output(latex::heading_pages(root, &arg::<Vec<latex::SourceLine>>(args, "headings")?))
        }
        "revert_transaction" => {
            output(project::revert(root, &string("transactionId")?, None).map(|record| record.id))
        }
        "revert_history_file" => output(
            project::revert(root, &string("transactionId")?, Some(&string("path")?))
                .map(|record| record.id),
        ),
        "delete_history_entry" => output(project::delete_history(root, &string("transactionId")?)),
        "write_project_bytes" => {
            output(project::write_bytes(root, &string("path")?, &string("base64Data")?))
        }
        "save_annotations" => output(project::write_annotations(
            root,
            arg(args, "annotations")?,
            arg(args, "rounds")?,
            arg(args, "save")?,
        )),
        "save_annotation_round" => output(project::save_annotation_round(
            root,
            arg(args, "number")?,
            arg(args, "files")?,
            flag("settled", false),
        )),
        "read_annotation_round" => {
            output(project::read_annotation_round(root, arg(args, "number")?))
        }
        "restore_annotation_round" => {
            let files = arg::<Vec<crate::models::FileChange>>(args, "files")?;
            let edits = files
                .into_iter()
                .filter_map(|file| file.after.map(|after| (file.path, after)))
                .collect::<Vec<_>>();
            output(project::apply_annotation_restore(root, &string("label")?, edits).map(|_| ()))
        }
        "set_project_deadline" => output(project::set_deadline(root, arg(args, "deadline")?)),
        "set_submission_items" => output(project::set_submission_items(root, arg(args, "items")?)),
        "set_project_spelling_words" => {
            output(project::set_spelling_words(root, arg(args, "words")?))
        }
        "set_project_grammar_ignores" => {
            output(project::set_grammar_ignores(root, arg(args, "rules")?, arg(args, "sentences")?))
        }
        "preview_replace_in_project" => output(project::preview_replace_in_project(
            root,
            &string("query")?,
            flag("matchCase", true),
            flag("useRegex", false),
        )),
        "replace_in_project" => output(project::replace_in_project(
            root,
            &string("query")?,
            &string("replacement")?,
            flag("matchCase", true),
            flag("useRegex", false),
        )),
        "find_symbol_occurrences" => {
            output(arg::<project::Symbol>(args, "kind")?.occurrences(root, &string("name")?))
        }
        "rename_symbol" => output(arg::<project::Symbol>(args, "kind")?.rename(
            root,
            &string("oldName")?,
            &string("newName")?,
        )),
        "list_citation_usages" => output(project::citation_usages(root)),
        "find_moved_project_file" => output(project::find_moved_file(
            root,
            &string("fileId")?,
            arg::<Option<String>>(args, "text")?.as_deref(),
        )),
        "export_project_zip" => {
            // Native exports may follow Zotero/other symlinks. A server export is
            // confined to project-owned bytes, so reject links before invoking it.
            for entry in
                walkdir::WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| {
                    e.depth() == 0 || !matches!(e.file_name().to_str(), Some(".research" | ".git"))
                })
            {
                if entry.map_err(|e| e.to_string())?.file_type().is_symlink() {
                    return Err("Headless ZIP exports do not follow project symlinks.".into());
                }
            }
            output(project::export_project_zip(root, &target(core, &string("zipPath")?)?))
        }
        "import_project_zip" => output(project::import_project_zip(
            &core.confined(&string("zipPath")?)?,
            &core.confined(&string("parent")?)?,
        )),
        _ => Err("unsupported_command: shared project operation unavailable".into()),
    }
}
