use serde::{Deserialize, Serialize};

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
    #[serde(default = "default_venue")]
    pub venue: String,
    #[serde(default)]
    pub word_budget: Option<u32>,
    #[serde(default)]
    pub page_budget: Option<u32>,
    #[serde(default)]
    pub spelling_words: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordCount {
    pub text: u32,
    pub headers: u32,
    pub captions: u32,
    pub total: u32,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnusedSymbols {
    pub labels: Vec<String>,
    pub citations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub files_changed: Vec<String>,
    pub replacements: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceMatch {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodoHit {
    pub path: String,
    pub line: u32,
    pub kind: String,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreview {
    pub matches: Vec<ReplaceMatch>,
    pub files: u32,
    pub replacements: u32,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub name: String,
    pub detail: String,
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub ok: bool,
    pub summary: String,
    pub checks: Vec<DoctorCheck>,
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
pub struct AssetPreview {
    pub path: String,
    pub mime_type: String,
    pub base64: String,
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
    pub doi: Option<String>,
    pub landing_url: Option<String>,
}

/// One page of Discover results. `has_more` means another backend page can be
/// fetched (OpenAlex has deeper pages); alphaXiv is exhausted after page 0.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteraturePage {
    pub hits: Vec<LiteratureHit>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexlabCompletionItem {
    pub label: String,
    pub detail: Option<String>,
    pub kind: Option<String>,
    pub insert_text: Option<String>,
    pub documentation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexlabHover {
    pub contents: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexlabLocation {
    pub path: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResult {
    pub success: bool,
    pub has_pdf: bool,
    pub log: String,
    pub duration_ms: u128,
    pub diagnostics: Vec<Diagnostic>,
    /// Project-relative path of the document latexmk was pointed at. The build
    /// may have re-targeted onto the open file (Overleaf's rule), and the
    /// frontend needs to know without re-reading the manifest.
    pub root_document: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTexTarget {
    pub path: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSyncTarget {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfMarkRect {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfMark {
    pub id: String,
    pub kind: String,
    pub page: u32,
    pub rects: Vec<PdfMarkRect>,
    pub color: String,
    pub text: String,
    #[serde(default)]
    pub note: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfMarksFile {
    pub schema_version: u32,
    pub annotations: Vec<PdfMark>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCommentReply {
    pub id: String,
    pub author_id: String,
    pub author_name: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorComment {
    pub id: String,
    pub path: String,
    pub from: u32,
    pub to: u32,
    pub quote: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    pub body: String,
    pub author_id: String,
    pub author_name: String,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default)]
    pub replies: Vec<EditorCommentReply>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCommentsFile {
    pub schema_version: u32,
    pub comments: Vec<EditorComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionRecord {
    #[serde(default = "default_history_schema_version")]
    pub schema_version: u32,
    pub id: String,
    pub label: String,
    pub timestamp: String,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub checkpoint_ref: Option<String>,
    #[serde(default)]
    pub undo_of: Option<String>,
    pub changes: Vec<FileChange>,
}

fn default_history_schema_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: String,
    pub label: String,
    pub timestamp: String,
    pub files: Vec<String>,
    pub actor: String,
    pub kind: String,
    pub source: String,
    pub thread_id: Option<String>,
    pub checkpoint_ref: Option<String>,
    pub undo_of: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub arxiv_id: String,
    pub title: String,
    pub paper_path: String,
    pub citation_key: Option<String>,
    pub citation_output: String,
    pub already_imported: bool,
    /// Why the full text is absent although the work has an arXiv id. The
    /// citation itself succeeded; readers (UI notice, agent) decide whether
    /// to mention it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetch_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperSummary {
    pub arxiv_id: String,
    /// The cited page for webpage references — how the row offers a download
    /// when there is no arXiv id to fetch by.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub title: String,
    pub citation_key: Option<String>,
    /// False for works that are only cited — the reader has nothing to open.
    pub has_full_text: bool,
    /// True only when an overview is already present in the local paper cache.
    pub has_blog: bool,
    /// Converter-owned files needed to render figures in the paper reader.
    #[serde(default)]
    pub asset_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationInfo {
    pub key: String,
    pub title: String,
    pub authors: String,
    pub year: String,
    pub venue: String,
    /// Present when the entry names an arXiv preprint, so its full text can be
    /// fetched later.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arxiv_id: Option<String>,
    /// The entry's `url` field. For a webpage citation this is the identity
    /// that links it to its captured content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceInfo {
    pub label: String,
    pub kind: String,
    pub title: String,
    pub snippet: String,
    pub path: String,
    pub line: u32,
    pub image_path: Option<String>,
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
pub struct RenameSymbolResult {
    pub changed_files: Vec<String>,
    pub occurrence_count: u32,
    pub transaction_id: String,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub available: bool,
    pub repository: bool,
    pub branch: Option<String>,
    pub remote: Option<String>,
    pub remote_url: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFileStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteResult {
    pub summary: String,
    pub status: GitStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub path: String,
    pub staged: bool,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogFile {
    pub path: String,
    /// "added" | "modified" | "deleted" | "renamed"
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub author_name: String,
    /// ISO-8601 author date.
    pub timestamp: String,
    pub message: String,
    pub files: Vec<GitLogFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub before: Option<String>,
    pub after: Option<String>,
    pub binary: bool,
}
