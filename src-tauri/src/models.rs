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
    pub pdf_base64: Option<String>,
    pub log: String,
    pub duration_ms: u128,
    pub diagnostics: Vec<Diagnostic>,
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
    pub id: String,
    pub label: String,
    pub timestamp: String,
    pub changes: Vec<FileChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: String,
    pub label: String,
    pub timestamp: String,
    pub files: Vec<String>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperSummary {
    pub arxiv_id: String,
    pub title: String,
    pub citation_key: Option<String>,
    /// False for works that are only cited — the reader has nothing to open.
    pub has_full_text: bool,
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

/// One chronological slice of an agent turn: something it said, or something it
/// did. `text` on the message stays the full transcript for copying and for
/// clients that predate this field; `parts` is what the bubble renders.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MessagePart {
    Text {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Tool {
        id: String,
        name: String,
        detail: String,
        phase: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    /// Empty for user/system messages and for turns recorded before the field
    /// existed; the renderer falls back to `text` then.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<MessagePart>,
}

/// A slash command offered by the OMP build we ship.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    pub name: String,
    pub description: String,
    pub hint: Option<String>,
    pub subcommands: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    pub provider: String,
    pub model: String,
    pub reasoning_effort: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRequest {
    pub settings: AgentSettings,
    pub message: String,
    pub active_file: Option<String>,
    pub selection: Option<String>,
    pub session_id: String,
    pub session_title: String,
    #[serde(default)]
    pub system_prompt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionStatus {
    pub provider: String,
    pub installed: bool,
    pub logged_in: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionLoginEvent {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub reasoning_effort: String,
    pub messages: Vec<AgentMessage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    pub provider: String,
    pub model: String,
    pub reasoning_effort: String,
    pub message_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSearchResult {
    #[serde(flatten)]
    pub session: AgentSessionSummary,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub name: String,
    pub description: String,
    pub scope: String,
    pub enabled: bool,
    pub editable: bool,
    pub overridden: bool,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillSaveRequest {
    pub original_name: Option<String>,
    pub scope: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResult {
    pub summary: String,
    pub changed_files: Vec<String>,
    pub transaction_id: Option<String>,
    pub skills_used: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentStreamEvent {
    Status {
        message: String,
    },
    Text {
        text: String,
    },
    Cancellable {
        enabled: bool,
    },
    Tool {
        name: String,
        detail: String,
        phase: String,
    },
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
