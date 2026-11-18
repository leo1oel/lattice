//! Reading what a plugin returns. The plugin is untrusted and may be newer
//! than this host, so parsing is lenient where the contract allows growth
//! and strict where the host acts:
//!
//! - an unknown result kind degrades to a message (its summary, or a notice),
//!   so a new kind never breaks an older Lattice;
//! - an unknown or invalid action is dropped, never shown as a button that
//!   would do something else;
//! - every string is capped, and every path, URL and BibTeX argument is
//!   checked before the shell ever sees it.

use super::protocol::{Action, ActionKind, CommandResult, Diagnostic, Item};
use serde_json::Value;

const MAX_ITEMS: usize = 500;
const MAX_ACTIONS: usize = 8;
const MAX_BADGES: usize = 4;
const SHORT: usize = 300;
const LONG: usize = 4_000;
const MARKDOWN: usize = 64_000;
const BIBTEX: usize = 32_000;

/// The notice an older host shows for a result kind it does not know.
pub const UNKNOWN_KIND: &str = "This plugin returned a kind of result this version of Lattice cannot show. Updating Lattice may help.";

/// `value` as a result the shells can render and act on.
pub fn parse(value: Value) -> Result<CommandResult, String> {
    let Some(kind) = value.get("kind").and_then(Value::as_str) else {
        return Err("The plugin's result has no kind.".into());
    };
    let summary = value.get("summary").and_then(Value::as_str).map(|s| cap(s, LONG));
    let list =
        |field: &str| value.get(field).and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(match kind {
        "message" => CommandResult::Message {
            summary,
            markdown: cap(value.get("markdown").and_then(Value::as_str).unwrap_or(""), MARKDOWN),
        },
        "items" => {
            let items = list("items").into_iter().take(MAX_ITEMS).enumerate();
            CommandResult::Items { summary, items: items.filter_map(|(i, v)| item(i, v)).collect() }
        }
        "diagnostics" => {
            let items = list("items").into_iter().take(MAX_ITEMS).enumerate();
            CommandResult::Diagnostics {
                summary,
                items: items.filter_map(|(i, v)| diagnostic(i, v)).collect(),
            }
        }
        _ => CommandResult::Message {
            markdown: summary.clone().unwrap_or_else(|| UNKNOWN_KIND.into()),
            summary,
        },
    })
}

fn item(index: usize, value: Value) -> Option<Item> {
    let text =
        |field: &str, max: usize| value.get(field).and_then(Value::as_str).map(|s| cap(s, max));
    let title = text("title", SHORT).filter(|t| !t.trim().is_empty())?;
    let badges = value.get("badges").and_then(Value::as_array).cloned().unwrap_or_default();
    Some(Item {
        id: id(&value, index),
        title,
        subtitle: text("subtitle", SHORT),
        detail: text("detail", LONG),
        badges: badges
            .iter()
            .filter_map(Value::as_str)
            .take(MAX_BADGES)
            .map(|b| cap(b, 40))
            .collect(),
        actions: actions(value.get("actions")),
    })
}

fn diagnostic(index: usize, value: Value) -> Option<Diagnostic> {
    let file = value.get("file").and_then(Value::as_str).filter(|f| relative_path(f))?.to_string();
    let message = value.get("message").and_then(Value::as_str).filter(|m| !m.trim().is_empty())?;
    let severity = serde_json::from_value(value.get("severity")?.clone()).ok()?;
    Some(Diagnostic {
        id: id(&value, index),
        file,
        line: value.get("line").and_then(Value::as_u64).and_then(|l| u32::try_from(l).ok()),
        severity,
        code: value.get("code").and_then(Value::as_str).map(|c| cap(c, 80)),
        message: cap(message, LONG),
        fixes: actions(value.get("fixes")),
    })
}

fn id(value: &Value, index: usize) -> String {
    value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map_or_else(|| index.to_string(), |id| cap(id, 200))
}

fn actions(value: Option<&Value>) -> Vec<Action> {
    let Some(list) = value.and_then(Value::as_array) else { return Vec::new() };
    list.iter()
        .filter_map(|v| serde_json::from_value::<Action>(v.clone()).ok())
        .filter_map(checked)
        .take(MAX_ACTIONS)
        .collect()
}

/// `action` with its arguments capped, or `None` when the host would refuse
/// to perform it anyway.
fn checked(action: Action) -> Option<Action> {
    let kind = match action.kind {
        ActionKind::InsertCitation { key } => crate::bib_document::valid_citation_key(&key)
            .then_some(ActionKind::InsertCitation { key })?,
        ActionKind::AddBibEntry { bibtex, file } => {
            single_entry(&bibtex)?;
            ActionKind::AddBibEntry { bibtex, file: bib_file(file)? }
        }
        ActionKind::ReplaceBibEntry { key, bibtex, file } => {
            (single_entry(&bibtex)? == key).then_some(())?;
            ActionKind::ReplaceBibEntry { key, bibtex, file: bib_file(file)? }
        }
        ActionKind::Reveal { file, line } => {
            relative_path(&file).then_some(ActionKind::Reveal { file, line })?
        }
        ActionKind::OpenUrl { url } => web_url(&url).then_some(ActionKind::OpenUrl { url })?,
        ActionKind::Copy { text } => ActionKind::Copy { text: cap(&text, BIBTEX) },
    };
    Some(Action { title: action.title.map(|t| cap(&t, 60)), kind })
}

/// The key of the one entry `bibtex` holds; `None` for anything else.
fn single_entry(bibtex: &str) -> Option<String> {
    if bibtex.len() > BIBTEX {
        return None;
    }
    let document = crate::bib_document::parse(bibtex).ok()?;
    match document.entries.as_slice() {
        [entry] if crate::bib_document::valid_citation_key(&entry.key) => Some(entry.key.clone()),
        _ => None,
    }
}

/// An optional target bibliography: `Some(None)` lets the host choose.
fn bib_file(file: Option<String>) -> Option<Option<String>> {
    match file {
        None => Some(None),
        Some(f) if relative_path(&f) && f.to_ascii_lowercase().ends_with(".bib") => Some(Some(f)),
        Some(_) => None,
    }
}

/// A project-relative, `/`-separated path that stays inside the project.
pub(crate) fn relative_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains(':')
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

fn web_url(url: &str) -> bool {
    url.len() <= 4096
        && url::Url::parse(url)
            .is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some())
}

fn cap(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_unknown_kind_degrades_to_its_summary() {
        let result = parse(json!({"kind": "table", "summary": "3 rows", "rows": []})).unwrap();
        assert_eq!(
            result,
            CommandResult::Message { summary: Some("3 rows".into()), markdown: "3 rows".into() }
        );
        let bare = parse(json!({"kind": "chart"})).unwrap();
        assert!(
            matches!(bare, CommandResult::Message { markdown, .. } if markdown == UNKNOWN_KIND)
        );
    }

    #[test]
    fn unknown_and_unsafe_actions_are_dropped() {
        let result = parse(json!({"kind": "items", "items": [{
            "title": "Paper",
            "unknownField": 1,
            "actions": [
                {"type": "insertCitation", "key": "knuth1984"},
                {"type": "runShell", "command": "rm -rf ~"},
                {"type": "openUrl", "url": "file:///etc/passwd"},
                {"type": "openUrl", "url": "javascript:alert(1)"},
                {"type": "reveal", "file": "../outside.tex"},
                {"type": "reveal", "file": "/etc/hosts"},
                {"type": "addBibEntry", "bibtex": "@article{a, title={A}}\n@article{b, title={B}}"},
                {"type": "addBibEntry", "bibtex": "@article{a, title={A}}", "file": "notes.txt"},
                {"type": "replaceBibEntry", "key": "other", "bibtex": "@article{a, title={A}}"},
                {"type": "openUrl", "url": "https://doi.org/10.1/x", "title": "DOI"},
                {"type": "addBibEntry", "bibtex": "@article{a, title={A}}", "file": "refs/main.bib"}
            ]
        }]}))
        .unwrap();
        let CommandResult::Items { items, .. } = result else { panic!("items") };
        let kinds: Vec<_> = items[0].actions.iter().map(|a| &a.kind).collect();
        assert_eq!(
            kinds,
            [
                &ActionKind::InsertCitation { key: "knuth1984".into() },
                &ActionKind::OpenUrl { url: "https://doi.org/10.1/x".into() },
                &ActionKind::AddBibEntry {
                    bibtex: "@article{a, title={A}}".into(),
                    file: Some("refs/main.bib".into())
                },
            ]
        );
        assert_eq!(items[0].id, "0");
    }

    #[test]
    fn diagnostics_need_a_project_file_and_a_message() {
        let result = parse(json!({"kind": "diagnostics", "items": [
            {"id": "d1", "file": "refs.bib", "line": 3, "severity": "warning", "code": "duplicate-key", "message": "Duplicate key a"},
            {"file": "/abs.bib", "severity": "error", "message": "x"},
            {"file": "refs.bib", "severity": "fatal", "message": "x"},
            {"file": "refs.bib", "severity": "info", "message": " "}
        ]}))
        .unwrap();
        let CommandResult::Diagnostics { items, .. } = result else { panic!("diagnostics") };
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].code.as_deref(), Some("duplicate-key"));
    }

    #[test]
    fn long_text_is_capped() {
        let long = "x".repeat(SHORT + 10);
        let result = parse(json!({"kind": "items", "items": [{"title": long}]})).unwrap();
        let CommandResult::Items { items, .. } = result else { panic!("items") };
        assert_eq!(items[0].title.chars().count(), SHORT + 1);
    }
}
