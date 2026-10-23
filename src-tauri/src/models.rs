use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The parameters of a message `code`, by name. A code names text Lattice
/// itself wrote, so the interface can show it in its own language; the
/// English text beside it stays for logs, copied reports and the agent.
pub type MessageParams = BTreeMap<&'static str, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootDocument {
    pub path: String,
    pub name: String,
    pub is_default: bool,
}

fn default_pdf_engine() -> String {
    "pdf".to_string()
}

fn default_venue() -> String {
    "neurips".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    pub schema_version: u32,
    pub project_id: String,
    pub name: String,
    pub root_documents: Vec<RootDocument>,
    pub primary_bibliography: String,
    pub trusted: bool,
    #[serde(default = "default_pdf_engine")]
    pub engine: String,
    /// The writer undid an automatic switch to pdfLaTeX, so builds leave this
    /// project's engine alone from then on (latex/engine_mismatch.rs).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub keep_engine: bool,
    /// Builds stop at the first LaTeX error (`-halt-on-error`) instead of
    /// carrying on past every error, Overleaf's default (latex/build.rs).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stop_on_first_error: bool,
    #[serde(default = "default_venue")]
    pub venue: String,
    #[serde(default)]
    pub word_budget: Option<u32>,
    #[serde(default)]
    pub page_budget: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<ProjectDeadline>,
    #[serde(default)]
    pub spelling_words: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub submission_items: Vec<SubmissionItem>,
    /// Keys this build does not read, written back as they were: a newer
    /// Lattice's settings, or the term rules and English variant an earlier
    /// one's Terms panel kept here.
    #[serde(flatten)]
    pub unread: serde_json::Map<String, serde_json::Value>,
}

/// A requirement or material the writer tracks by hand on the submission
/// checklist, beside the automatic checks: "supplementary.pdf checked", "all
/// authors approved". Passing every automatic check never confirms one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionItem {
    pub id: String,
    pub title: String,
    /// "todo", "review" (done, waiting to be checked) or "confirmed".
    pub status: String,
    /// The project file this item is about, relative to the project root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// Where the requirement is written down: a call-for-papers URL or a note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// The day the requirement was last read against its source, "YYYY-MM-DD".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_checked: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// The linked file's mtime (ms) when the item was confirmed, so a
    /// rebuilt PDF or a replaced supplement asks to be looked at again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_mtime_ms: Option<u64>,
}

/// The submission deadline the checklist counts down to. Calls for papers
/// publish it as a wall-clock time Anywhere on Earth (UTC−12), so it is kept
/// in that form and never converted through a host time zone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeadline {
    /// What the writer calls it, such as "NeurIPS 2027".
    pub venue: String,
    /// "abstract", "paper" or "rebuttal".
    pub kind: String,
    /// "YYYY-MM-DDTHH:MM", Anywhere on Earth.
    pub due: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedCitation {
    pub key: String,
    pub title: String,
    pub author: String,
    pub year: String,
    pub journal: String,
    pub booktitle: String,
    pub publisher: String,
    pub url: String,
    pub doi: String,
    pub entry_type: String,
    pub bibtex: String,
    pub candidates: Vec<ResolvedCitation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<serde_json::Value>,
    pub extra_fields: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub kind: String,
    /// Content-derived routing boundary. `text` is lossless bounded UTF-8;
    /// everything uncertain is `binary`, and links are never followed.
    pub content_kind: String,
    pub size: u64,
    pub children: Vec<FileNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    pub root: String,
    pub manifest: ProjectManifest,
    pub files: Vec<FileNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub file: Option<String>,
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
    pub level: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: MessageParams,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAlexWork {
    pub id: String,
    pub title: String,
    pub year: Option<u32>,
    pub cited_by_count: u32,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    pub landing_url: Option<String>,
    pub authors: Vec<String>,
    #[serde(default)]
    pub r#abstract: Option<String>,
    /// Where it was published ("NAACL", "arXiv"), as OpenAlex names the source.
    #[serde(default)]
    pub venue: Option<String>,
}

/// A merged search hit shown in the Discover panel. alphaXiv (full-text) and
/// OpenAlex (citation graph) both flow into this single shape; the panel reads
/// `source` to label the row and picks the fields each source populates.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureHit {
    /// "alphaxiv" | "openalex"
    pub source: String,
    pub arxiv_id: Option<String>,
    pub title: String,
    pub year: Option<u32>,
    pub authors: Vec<String>,
    pub cited_by_count: Option<u32>,
    pub votes: Option<u32>,
    pub snippet: Option<String>,
    /// The work's abstract, for the row's preview. OpenAlex gives one for most
    /// works; alphaXiv's full-text hits carry only the matching `snippet`.
    #[serde(default)]
    pub r#abstract: Option<String>,
    pub doi: Option<String>,
    pub landing_url: Option<String>,
    /// OpenAlex: where the work was published.
    #[serde(default)]
    pub venue: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTexTarget {
    pub path: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationInfo {
    pub key: String,
    pub title: String,
    pub authors: String,
    /// The author list as BibTeX writes it, braces kept: `{Google Brain}` is
    /// one corporate name, which the brace-free `authors` cannot tell apart
    /// from a person whose surname is "Brain".
    #[serde(skip)]
    pub bibtex_authors: String,
    pub year: String,
    pub venue: String,
    /// Present when the entry names an arXiv preprint, so its full text can be
    /// fetched later.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arxiv_id: Option<String>,
    /// DOI normalized for exact metadata lookups (lowercase, without a resolver URL).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    /// The entry's `url` field. For a webpage citation this is the identity
    /// that links it to its captured content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolOccurrence {
    pub kind: String,
    pub symbol: String,
    pub role: String,
    pub path: String,
    pub line: u32,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchResult {
    pub kind: String,
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub line: Option<u32>,
    pub arxiv_id: Option<String>,
    pub file_kind: Option<String>,
}
