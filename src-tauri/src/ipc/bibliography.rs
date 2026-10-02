//! The project's bibliography: citations, BibTeX entries, the citation audit,
//! and the agent's bibliography mutations.

use super::{current_root, in_project, run_blocking, scoped_root};
use crate::agent_literature::AgentBibliographyMutation;
use crate::app_state::{AppState, Lease};
use crate::models::{CitationInfo, ResolvedCitation};
use crate::papers::{self, CitationRemovalMode, HistoryMode};
use crate::{citation_audit, project};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State, Window};

#[tauri::command]
pub async fn list_citations(
    state: State<'_, AppState>, window: Window,
) -> Result<Vec<CitationInfo>, String> {
    in_project(&state, &window, "Citation scan", project::citations).await
}

#[tauri::command]
pub async fn read_bib_entry(
    state: State<'_, AppState>, window: Window, key: String,
) -> Result<Option<ResolvedCitation>, String> {
    let root = current_root(&state, &window)?;
    run_blocking("Bibliography read", move || project::read_bib_entry(&root, &key)).await
}

#[tauri::command]
pub async fn save_bib_entry(
    state: State<'_, AppState>, window: Window, key: String, bibtex: String,
) -> Result<(), String> {
    let root = current_root(&state, &window)?;
    run_blocking("Bibliography save", move || project::save_bib_entry(&root, &key, &bibtex)).await
}

#[tauri::command]
pub async fn resolve_citation_query(query: String) -> Result<ResolvedCitation, String> {
    run_blocking("Citation lookup", move || project::resolve_citation_query(&query)).await
}

#[tauri::command]
pub async fn remove_reference(
    state: State<'_, AppState>, window: Window, key: String, citation_mode: Option<String>,
    project_root: String,
) -> Result<papers::RemoveResult, String> {
    let root = scoped_root(&state, &window, &project_root)?;
    run_blocking("Reference removal", move || {
        let mode = match citation_mode.as_deref() {
            None => CitationRemovalMode::Block,
            Some("preview") => CitationRemovalMode::Preview,
            Some("keep") => CitationRemovalMode::Keep,
            Some("remove") => CitationRemovalMode::Remove,
            Some(_) => return Err("Choose whether to keep or remove manuscript citations.".into()),
        };
        papers::remove_reference(&root, &key, HistoryMode::Record, mode)
    })
    .await
}

#[tauri::command]
pub async fn agent_bibliography_mutation(
    state: State<'_, AppState>, window: Window, project_root: String,
    mutation: AgentBibliographyMutation,
) -> Result<Value, String> {
    let root = scoped_root(&state, &window, &project_root)?;
    run_blocking("The bibliography task", move || mutation.into_request()?.run(&root)).await
}

fn audit_report_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn bibliography_audit_scan(
    state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<citation_audit::AuditScan, String> {
    // A sync writes pulled and conflicted bibliographies one file at a time;
    // scanning in between reads a half-applied project.
    let _lease = state.lease(&project_root, Lease::Shared).await;
    let root = scoped_root(&state, &window, &project_root)?;
    run_blocking("Bibliography audit scan", move || citation_audit::scan(&root)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn bibliography_audit_report_load(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
) -> Result<Option<Vec<(String, Value)>>, String> {
    let root = scoped_root(&state, &window, &project_root)?;
    let data_dir = audit_report_dir(&app)?;
    run_blocking("Bibliography audit report load", move || {
        citation_audit::load_report(&data_dir, &root)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn bibliography_audit_report_save(
    app: AppHandle, state: State<'_, AppState>, window: Window, project_root: String,
    report: Vec<(String, serde_json::Value)>,
) -> Result<(), String> {
    let root = scoped_root(&state, &window, &project_root)?;
    let data_dir = audit_report_dir(&app)?;
    run_blocking("Bibliography audit report save", move || {
        citation_audit::save_report(&data_dir, &root, report)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn bibliography_audit_batch(
    state: State<'_, AppState>, window: Window, project_root: String,
    entries: Vec<citation_audit::AuditEntry>,
) -> Result<citation_audit::BatchAudit, String> {
    let root = scoped_root(&state, &window, &project_root)?;
    run_blocking("Bibliography audit batch", move || citation_audit::check_batch(&root, entries))
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn bibliography_audit_entry(
    state: State<'_, AppState>, window: Window, project_root: String,
    entry: citation_audit::AuditEntry, s2_batch_status: Option<String>,
) -> Result<citation_audit::AuditResult, String> {
    let root = scoped_root(&state, &window, &project_root)?;
    run_blocking("Bibliography audit entry", move || {
        citation_audit::check_entry(&root, entry, s2_batch_status.as_deref())
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn bibliography_audit_apply(
    state: State<'_, AppState>, window: Window, project_root: String, path: String, key: String,
    before: String, after: String,
) -> Result<(), String> {
    // Like an editor save: the write must land entirely before or after a
    // sync, never between its snapshot and its merge.
    let _lease = state.lease(&project_root, Lease::Shared).await;
    let root = scoped_root(&state, &window, &project_root)?;
    run_blocking("Bibliography audit apply", move || {
        citation_audit::apply(&root, &path, &key, &before, &after)
    })
    .await
}
