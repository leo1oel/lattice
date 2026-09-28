//! Literature operations requested by the agent, run through the same domain
//! code as the app's own interface.
//!
//! The agent runs in a sidecar process and cannot call into the app, so the
//! app offers a private JSON dispatcher through its own executable. Keeping
//! search, fetch, cite, upgrade, removal, and the library listing here avoids
//! a second TypeScript implementation drifting from the UI. The agent's
//! bibliography mutations inside the app go through the same dispatcher.

use crate::{literature, papers};
use papers::{CitationRemovalMode, HistoryMode};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::AtomicBool;

/// One request from the sidecar's literature gateway.
#[derive(serde::Deserialize)]
#[serde(tag = "tool", content = "params", rename_all = "snake_case")]
pub(crate) enum LiteratureRequest {
    SearchLiterature {
        query: String,
        #[serde(default)]
        precise: bool,
        #[serde(default)]
        page: u32,
    },
    FetchPaper {
        #[serde(rename = "arxivId")]
        arxiv_id: String,
    },
    ListPapers {},
    SearchLibrary {
        query: String,
    },
    FetchWebReference {
        url: String,
    },
    Cite {
        query: String,
    },
    UpgradeBibliography {
        #[serde(rename = "dryRun", default)]
        dry_run: bool,
    },
    RemoveReference {
        key: String,
    },
}

/// The only path from a sandboxed agent process to a bibliography mutation.
/// Keep this protocol closed over the three domain operations that validate
/// and resolve references; it must never accept an executable, file path, or
/// arbitrary literature request.
#[derive(serde::Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum AgentBibliographyMutation {
    Cite {
        query: String,
    },
    UpgradeBibliography {
        #[serde(rename = "dryRun", default)]
        dry_run: bool,
    },
    RemoveReference {
        key: String,
    },
}

impl AgentBibliographyMutation {
    /// Bound the agent-controlled strings, then express the mutation as the
    /// literature request that performs it.
    pub(crate) fn into_request(self) -> Result<LiteratureRequest, String> {
        Ok(match self {
            Self::Cite { query } => {
                LiteratureRequest::Cite { query: bounded_value(query, "Citation query", 4_096)? }
            }
            Self::UpgradeBibliography { dry_run } => {
                LiteratureRequest::UpgradeBibliography { dry_run }
            }
            Self::RemoveReference { key } => {
                LiteratureRequest::RemoveReference { key: bounded_value(key, "Citation key", 512)? }
            }
        })
    }
}

fn bounded_value(value: String, label: &str, max_chars: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max_chars {
        return Err(format!("{label} must contain between 1 and {max_chars} characters."));
    }
    Ok(value.to_string())
}

fn to_json<T: serde::Serialize>(result: Result<T, String>) -> Result<Value, String> {
    result.and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}

impl LiteratureRequest {
    /// Perform the request against the project at `root`. Bibliography
    /// mutations defer their history entry to the agent turn that asked.
    pub(crate) fn run(self, root: &Path) -> Result<Value, String> {
        match self {
            Self::SearchLiterature { query, precise, page } => {
                to_json(literature::search(&query, precise, page))
            }
            Self::FetchPaper { arxiv_id } => to_json(papers::fetch_paper(root, &arxiv_id, &|_| {})),
            // Wrapped in objects: the gateway rejects a bare JSON array as a
            // response envelope.
            Self::ListPapers {} => {
                papers::list_library(root).map(|papers| json!({ "papers": papers }))
            }
            Self::SearchLibrary { query } => {
                papers::search_library(root, &query).map(|results| json!({ "results": results }))
            }
            Self::FetchWebReference { url } => to_json(papers::fetch_web_reference(root, &url)),
            Self::Cite { query } => to_json(papers::import_reference(
                root,
                &query,
                HistoryMode::Defer,
                &|_| {},
                &AtomicBool::new(false),
            )),
            Self::UpgradeBibliography { dry_run } => {
                to_json(papers::upgrade_bibliography(root, dry_run))
            }
            Self::RemoveReference { key } => to_json(papers::remove_reference(
                root,
                &key,
                HistoryMode::Defer,
                CitationRemovalMode::Block,
            )),
        }
    }
}

/// Serve `<executable> literature <json>` and exit the process; returns false
/// when this is an ordinary app launch. Must run before anything touches
/// Tauri or AppKit.
pub(crate) fn run_cli() -> bool {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("literature") {
        return false;
    }
    let Some(root) = std::env::var_os("LATTICE_PROJECT_ROOT").filter(|v| !v.is_empty()) else {
        eprintln!("LATTICE_PROJECT_ROOT is not set.");
        std::process::exit(2);
    };
    let raw = args.collect::<Vec<_>>().join(" ");
    let request: LiteratureRequest = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("Invalid literature request: {error}");
            std::process::exit(2)
        }
    };
    match request.run(Path::new(&root)) {
        Ok(result) => {
            println!("{}", serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string()));
            std::process::exit(0);
        }
        Err(reason) => {
            eprintln!("{reason}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{bounded_value, AgentBibliographyMutation, LiteratureRequest};

    /// The gateway always sends a params object, even for tools without
    /// arguments — the empty-struct variant must accept `{}` (a unit variant
    /// would reject it).
    #[test]
    fn parses_gateway_requests() {
        let parse = |json: &str| serde_json::from_str::<LiteratureRequest>(json).unwrap();
        let request = parse(r#"{"tool":"list_papers","params":{}}"#);
        assert!(matches!(request, LiteratureRequest::ListPapers {}));
        let request = parse(r#"{"tool":"search_library","params":{"query":"attention"}}"#);
        assert!(
            matches!(request, LiteratureRequest::SearchLibrary { query } if query == "attention")
        );
    }

    #[test]
    fn mutation_protocol_rejects_arbitrary_actions_and_fields() {
        let parse = serde_json::from_str::<AgentBibliographyMutation>;
        assert!(parse(r#"{"action":"cite","query":"Attention Is All You Need"}"#).is_ok());
        assert!(parse(r#"{"action":"write_file","path":"references.bib"}"#).is_err());
        assert!(parse(r#"{"action":"remove_reference","key":"bad2024","path":"references.bib"}"#)
            .is_err());
    }

    #[test]
    fn mutation_protocol_bounds_agent_controlled_strings() {
        assert_eq!(bounded_value("  key2024  ".to_string(), "key", 512).unwrap(), "key2024");
        assert!(bounded_value("   ".to_string(), "key", 512).is_err());
        assert!(bounded_value("x".repeat(513), "key", 512).is_err());
    }
}
