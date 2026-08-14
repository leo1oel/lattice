//! Opt-in, fully local semantic indexing for project prose.
//!
//! The production provider is macOS NaturalLanguage's built-in English
//! sentence embedding. There is no network client in this module, no model
//! download, and no model file in the application bundle. Source text is read
//! in the background, split into stable prose blocks, embedded on-device, and
//! discarded. The persistent cache contains only a model version, normalized
//! text SHA-256, and normalized vector.

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use walkdir::{DirEntry, WalkDir};

const CACHE_SCHEMA_VERSION: u32 = 1;
const MAX_SOURCE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_BLOCK_CHARS: usize = 1_200;
const MAX_SNIPPET_CHARS: usize = 220;
const MAX_SEMANTIC_CANDIDATES: usize = 24;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticSearchStatus {
    /// disabled | indexing | ready | unavailable | error
    pub state: String,
    pub detail: Option<String>,
    pub model_version: Option<String>,
    pub indexed_files: usize,
    pub indexed_chunks: usize,
    pub cached_chunks: usize,
    pub total_chunks: usize,
    pub generation: u64,
}

impl SemanticSearchStatus {
    fn disabled(generation: u64) -> Self {
        Self {
            state: "disabled".to_string(),
            detail: None,
            model_version: None,
            indexed_files: 0,
            indexed_chunks: 0,
            cached_chunks: 0,
            total_chunks: 0,
            generation,
        }
    }

    fn indexing(generation: u64, previous: Option<&SemanticIndex>) -> Self {
        Self {
            state: "indexing".to_string(),
            detail: Some("Building an on-device index in the background.".to_string()),
            model_version: previous.map(|index| index.model_version.clone()),
            indexed_files: previous.map_or(0, |index| index.indexed_files),
            indexed_chunks: previous.map_or(0, |index| index.chunks.len()),
            cached_chunks: 0,
            total_chunks: 0,
            generation,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticSearchCandidate {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub line: u32,
    pub score: f32,
    pub kind: String,
    pub file_kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticSearchResponse {
    pub status: SemanticSearchStatus,
    pub applied: bool,
    pub candidates: Vec<SemanticSearchCandidate>,
}

#[derive(Default)]
pub struct SemanticSearch {
    inner: Mutex<SearchState>,
}

struct SearchState {
    generation: u64,
    cancel: Option<Arc<AtomicBool>>,
    status: SemanticSearchStatus,
    index: Option<Arc<SemanticIndex>>,
}

impl Default for SearchState {
    fn default() -> Self {
        Self {
            generation: 0,
            cancel: None,
            status: SemanticSearchStatus::disabled(0),
            index: None,
        }
    }
}

impl SemanticSearch {
    fn begin(&self) -> (u64, Arc<AtomicBool>) {
        let mut state = lock_unpoisoned(&self.inner);
        if let Some(cancel) = state.cancel.take() {
            cancel.store(true, Ordering::Release);
        }
        state.generation = state.generation.wrapping_add(1);
        let generation = state.generation;
        let cancel = Arc::new(AtomicBool::new(false));
        state.cancel = Some(Arc::clone(&cancel));
        state.status = SemanticSearchStatus::indexing(generation, state.index.as_deref());
        (generation, cancel)
    }

    fn note_progress(&self, generation: u64, indexed_files: usize, total_chunks: usize) {
        let mut state = lock_unpoisoned(&self.inner);
        if state.generation != generation || state.status.state != "indexing" {
            return;
        }
        state.status.indexed_files = indexed_files;
        state.status.total_chunks = total_chunks;
    }

    fn finish(&self, generation: u64, result: Result<BuildOutput, BuildFailure>) {
        let mut state = lock_unpoisoned(&self.inner);
        if state.generation != generation {
            return;
        }
        state.cancel = None;
        match result {
            Ok(output) => {
                let index = Arc::new(output.index);
                state.status = SemanticSearchStatus {
                    state: "ready".to_string(),
                    detail: Some(
                        "Apple Natural Language · English · source text stays on this Mac."
                            .to_string(),
                    ),
                    model_version: Some(index.model_version.clone()),
                    indexed_files: index.indexed_files,
                    indexed_chunks: index.chunks.len(),
                    cached_chunks: output.cached_chunks,
                    total_chunks: output.total_chunks,
                    generation,
                };
                state.index = Some(index);
            }
            Err(BuildFailure::Cancelled) => {
                state.status = SemanticSearchStatus::disabled(generation);
                state.index = None;
            }
            Err(BuildFailure::Unavailable(detail)) => {
                state.status = SemanticSearchStatus {
                    state: "unavailable".to_string(),
                    detail: Some(detail),
                    model_version: None,
                    indexed_files: 0,
                    indexed_chunks: 0,
                    cached_chunks: 0,
                    total_chunks: 0,
                    generation,
                };
                state.index = None;
            }
            Err(BuildFailure::Failed(detail)) => {
                state.status = SemanticSearchStatus {
                    state: "error".to_string(),
                    detail: Some(detail),
                    model_version: None,
                    indexed_files: 0,
                    indexed_chunks: 0,
                    cached_chunks: 0,
                    total_chunks: 0,
                    generation,
                };
                state.index = None;
            }
        }
    }

    pub fn cancel(&self) -> SemanticSearchStatus {
        let mut state = lock_unpoisoned(&self.inner);
        if let Some(cancel) = state.cancel.take() {
            cancel.store(true, Ordering::Release);
        }
        state.generation = state.generation.wrapping_add(1);
        state.index = None;
        state.status = SemanticSearchStatus::disabled(state.generation);
        state.status.clone()
    }

    pub fn status(&self) -> SemanticSearchStatus {
        lock_unpoisoned(&self.inner).status.clone()
    }

    fn snapshot(&self) -> (SemanticSearchStatus, Option<Arc<SemanticIndex>>) {
        let state = lock_unpoisoned(&self.inner);
        (state.status.clone(), state.index.clone())
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Starts a new generation and returns immediately. A previous generation is
/// cooperatively cancelled; only the newest worker can publish its index.
pub fn start_index(search: Arc<SemanticSearch>, root: PathBuf, cache_path: PathBuf) {
    let (generation, cancel) = search.begin();
    tauri::async_runtime::spawn_blocking(move || {
        let result = build_with_system_provider(&root, &cache_path, &cancel, |files, chunks| {
            search.note_progress(generation, files, chunks);
        });
        search.finish(generation, result);
    });
}

/// Embeds a query on a blocking worker (the Tauri command supplies that worker)
/// and returns only short local snippets plus per-document cosine scores. If
/// the provider/index is unavailable, `applied` is false and callers retain the
/// lexical result unchanged.
pub fn search(search: &SemanticSearch, query: &str) -> SemanticSearchResponse {
    let (mut status, index) = search.snapshot();
    let Some(index) = index else {
        return SemanticSearchResponse {
            status,
            applied: false,
            candidates: Vec::new(),
        };
    };
    if index.chunks.is_empty() {
        return SemanticSearchResponse {
            status,
            applied: false,
            candidates: Vec::new(),
        };
    }
    let normalized = normalize_embedding_text(query);
    if normalized.is_empty() {
        return SemanticSearchResponse {
            status,
            applied: false,
            candidates: Vec::new(),
        };
    }

    let provider = match SystemEmbeddingProvider::load() {
        Ok(provider) => provider,
        Err(error) => {
            status.state = "unavailable".to_string();
            status.detail = Some(error.detail().to_string());
            return SemanticSearchResponse {
                status,
                applied: false,
                candidates: Vec::new(),
            };
        }
    };
    if provider.model_version() != index.model_version {
        status.state = "unavailable".to_string();
        status.detail = Some(
            "The system embedding model changed; showing lexical results until the local index is rebuilt."
                .to_string(),
        );
        return SemanticSearchResponse {
            status,
            applied: false,
            candidates: Vec::new(),
        };
    }
    let query_vector = match provider.embed(&normalized).and_then(normalize_vector) {
        Ok(vector) if vector.len() == index.dimension => vector,
        Ok(_) => {
            status.state = "unavailable".to_string();
            status.detail = Some(
                "The system embedding dimension changed; showing lexical results.".to_string(),
            );
            return SemanticSearchResponse {
                status,
                applied: false,
                candidates: Vec::new(),
            };
        }
        Err(error) => {
            status.state = "unavailable".to_string();
            status.detail = Some(format!("{} Showing lexical results.", error.detail()));
            return SemanticSearchResponse {
                status,
                applied: false,
                candidates: Vec::new(),
            };
        }
    };

    let mut best_by_path: HashMap<&str, (f32, &IndexedChunk)> = HashMap::new();
    for chunk in &index.chunks {
        let score = dot(&query_vector, &chunk.vector);
        if !score.is_finite() || score < 0.0 {
            continue;
        }
        let entry = best_by_path.entry(&chunk.path).or_insert((score, chunk));
        if score > entry.0 {
            *entry = (score, chunk);
        }
    }
    let mut candidates = best_by_path
        .into_values()
        .map(|(score, chunk)| SemanticSearchCandidate {
            path: chunk.path.clone(),
            title: chunk.title.clone(),
            snippet: chunk.snippet.clone(),
            line: chunk.line,
            score,
            kind: chunk.kind.clone(),
            file_kind: chunk.file_kind.clone(),
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
    });
    candidates.truncate(MAX_SEMANTIC_CANDIDATES);
    SemanticSearchResponse {
        status,
        applied: !candidates.is_empty(),
        candidates,
    }
}

#[derive(Debug)]
struct SemanticIndex {
    model_version: String,
    dimension: usize,
    indexed_files: usize,
    chunks: Vec<IndexedChunk>,
}

#[derive(Debug)]
struct IndexedChunk {
    path: String,
    title: String,
    snippet: String,
    line: u32,
    kind: String,
    file_kind: String,
    vector: Vec<f32>,
}

#[derive(Debug)]
struct BuildOutput {
    index: SemanticIndex,
    total_chunks: usize,
    cached_chunks: usize,
}

#[derive(Debug, PartialEq, Eq)]
enum BuildFailure {
    Cancelled,
    Unavailable(String),
    Failed(String),
}

#[derive(Debug)]
enum ProviderFailure {
    Unavailable(String),
    Text(String),
}

impl ProviderFailure {
    fn detail(&self) -> &str {
        match self {
            Self::Unavailable(detail) | Self::Text(detail) => detail,
        }
    }
}

trait LocalEmbeddingProvider {
    fn model_version(&self) -> &str;
    fn embed(&self, text: &str) -> Result<Vec<f32>, ProviderFailure>;
}

#[cfg(target_os = "macos")]
struct SystemEmbeddingProvider {
    embedding: objc2::rc::Retained<objc2_natural_language::NLEmbedding>,
    model_version: String,
    dimension: usize,
}

#[cfg(target_os = "macos")]
impl SystemEmbeddingProvider {
    fn load() -> Result<Self, ProviderFailure> {
        use objc2_natural_language::{NLEmbedding, NLLanguageEnglish};
        let language = unsafe { NLLanguageEnglish }.ok_or_else(|| {
            ProviderFailure::Unavailable(
                "Apple's English sentence embedding is not available on this Mac.".to_string(),
            )
        })?;
        let embedding =
            unsafe { NLEmbedding::sentenceEmbeddingForLanguage(language) }.ok_or_else(|| {
                ProviderFailure::Unavailable(
                    "Apple's English sentence embedding is not available on this Mac.".to_string(),
                )
            })?;
        let dimension = unsafe { embedding.dimension() } as usize;
        let revision = unsafe { embedding.revision() };
        if dimension == 0 || dimension > 16_384 {
            return Err(ProviderFailure::Unavailable(
                "Apple's sentence embedding reported an invalid vector size.".to_string(),
            ));
        }
        Ok(Self {
            embedding,
            model_version: format!("apple-nl-sentence-en-r{revision}"),
            dimension,
        })
    }
}

#[cfg(target_os = "macos")]
impl LocalEmbeddingProvider for SystemEmbeddingProvider {
    fn model_version(&self) -> &str {
        &self.model_version
    }

    fn embed(&self, text: &str) -> Result<Vec<f32>, ProviderFailure> {
        use objc2_foundation::NSString;
        use std::ptr::NonNull;

        let input = NSString::from_str(text);
        let mut vector = vec![0.0_f32; self.dimension];
        let output = NonNull::new(vector.as_mut_ptr()).ok_or_else(|| {
            ProviderFailure::Unavailable("Could not allocate an embedding vector.".to_string())
        })?;
        // SAFETY: `output` points to exactly `self.dimension` writable f32s,
        // which is the size reported by this immutable NLEmbedding instance.
        // `input` and the allocation remain alive for the duration of the call.
        if unsafe { self.embedding.getVector_forString(output, &input) } {
            Ok(vector)
        } else {
            Err(ProviderFailure::Text(
                "Apple's sentence model could not embed this text.".to_string(),
            ))
        }
    }
}

#[cfg(not(target_os = "macos"))]
struct SystemEmbeddingProvider;

#[cfg(not(target_os = "macos"))]
impl SystemEmbeddingProvider {
    fn load() -> Result<Self, ProviderFailure> {
        Err(ProviderFailure::Unavailable(
            "Local semantic search currently requires macOS Natural Language.".to_string(),
        ))
    }
}

#[cfg(not(target_os = "macos"))]
impl LocalEmbeddingProvider for SystemEmbeddingProvider {
    fn model_version(&self) -> &str {
        "unavailable"
    }

    fn embed(&self, _text: &str) -> Result<Vec<f32>, ProviderFailure> {
        Err(ProviderFailure::Unavailable(
            "Local semantic search currently requires macOS Natural Language.".to_string(),
        ))
    }
}

fn build_with_system_provider(
    root: &Path,
    cache_path: &Path,
    cancel: &AtomicBool,
    progress: impl FnMut(usize, usize),
) -> Result<BuildOutput, BuildFailure> {
    let provider = SystemEmbeddingProvider::load().map_err(|error| match error {
        ProviderFailure::Unavailable(detail) | ProviderFailure::Text(detail) => {
            BuildFailure::Unavailable(detail)
        }
    })?;
    build_index(root, cache_path, cancel, &provider, progress)
}

fn build_index(
    root: &Path,
    cache_path: &Path,
    cancel: &AtomicBool,
    provider: &impl LocalEmbeddingProvider,
    mut progress: impl FnMut(usize, usize),
) -> Result<BuildOutput, BuildFailure> {
    if cancel.load(Ordering::Acquire) {
        return Err(BuildFailure::Cancelled);
    }
    let documents = read_source_documents(root, cancel)?;
    let total_chunks = documents.iter().map(|document| document.chunks.len()).sum();
    progress(documents.len(), total_chunks);
    if total_chunks == 0 {
        return Ok(BuildOutput {
            index: SemanticIndex {
                model_version: provider.model_version().to_string(),
                dimension: 0,
                indexed_files: documents.len(),
                chunks: Vec::new(),
            },
            total_chunks,
            cached_chunks: 0,
        });
    }

    let mut cache = EmbeddingCache::open(cache_path)?;
    let mut vectors_by_hash: HashMap<String, Vec<f32>> = HashMap::new();
    let mut indexed = Vec::with_capacity(total_chunks);
    let mut cached_chunks = 0;
    let mut dimension = None;
    for document in documents {
        for chunk in document.chunks {
            if cancel.load(Ordering::Acquire) {
                return Err(BuildFailure::Cancelled);
            }
            let normalized = normalize_embedding_text(&chunk.text);
            if normalized.is_empty() {
                continue;
            }
            let hash = normalized_text_hash(&normalized);
            let vector = if let Some(vector) = vectors_by_hash.get(&hash) {
                cached_chunks += 1;
                vector.clone()
            } else if let Some(vector) = cache.get(provider.model_version(), &hash)? {
                cached_chunks += 1;
                vectors_by_hash.insert(hash.clone(), vector.clone());
                vector
            } else {
                let vector = match provider.embed(&normalized).and_then(normalize_vector) {
                    Ok(vector) => vector,
                    // A prose block with no usable language signal should not
                    // make the entire project unavailable. Query failures are
                    // handled separately and always fall back to lexical.
                    Err(ProviderFailure::Text(_)) => continue,
                    Err(ProviderFailure::Unavailable(detail)) => {
                        return Err(BuildFailure::Unavailable(detail));
                    }
                };
                cache.put(provider.model_version(), &hash, &vector)?;
                vectors_by_hash.insert(hash.clone(), vector.clone());
                vector
            };
            if vector.is_empty() {
                continue;
            }
            if let Some(expected) = dimension {
                if vector.len() != expected {
                    return Err(BuildFailure::Failed(
                        "Cached embeddings have inconsistent dimensions.".to_string(),
                    ));
                }
            } else {
                dimension = Some(vector.len());
            }
            indexed.push(IndexedChunk {
                path: document.path.clone(),
                title: document.title.clone(),
                snippet: snippet(&normalized),
                line: chunk.line,
                kind: document.kind.clone(),
                file_kind: document.file_kind.clone(),
                vector,
            });
        }
    }
    if indexed.is_empty() && total_chunks > 0 {
        return Err(BuildFailure::Unavailable(
            "Apple's English sentence model could not embed this project's prose.".to_string(),
        ));
    }
    Ok(BuildOutput {
        index: SemanticIndex {
            model_version: provider.model_version().to_string(),
            dimension: dimension.unwrap_or(0),
            indexed_files: indexed
                .iter()
                .map(|chunk| chunk.path.as_str())
                .collect::<std::collections::HashSet<_>>()
                .len(),
            chunks: indexed,
        },
        total_chunks,
        cached_chunks,
    })
}

struct EmbeddingCache {
    connection: Connection,
}

impl EmbeddingCache {
    fn open(path: &Path) -> Result<Self, BuildFailure> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                BuildFailure::Failed(format!("Could not create semantic cache folder: {error}"))
            })?;
        }
        let connection = Connection::open(path).map_err(cache_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(cache_error)?;
        connection
            .execute_batch(&format!(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE IF NOT EXISTS embeddings_v{CACHE_SCHEMA_VERSION} (
                   model_version TEXT NOT NULL,
                   normalized_text_hash TEXT NOT NULL,
                   dimension INTEGER NOT NULL,
                   vector BLOB NOT NULL,
                   PRIMARY KEY (model_version, normalized_text_hash)
                 );"
            ))
            .map_err(cache_error)?;
        Ok(Self { connection })
    }

    fn get(&self, model_version: &str, hash: &str) -> Result<Option<Vec<f32>>, BuildFailure> {
        let mut statement = self
            .connection
            .prepare(&format!(
                "SELECT dimension, vector FROM embeddings_v{CACHE_SCHEMA_VERSION}
                 WHERE model_version = ?1 AND normalized_text_hash = ?2"
            ))
            .map_err(cache_error)?;
        let mut rows = statement
            .query(params![model_version, hash])
            .map_err(cache_error)?;
        let Some(row) = rows.next().map_err(cache_error)? else {
            return Ok(None);
        };
        let dimension = row.get::<_, i64>(0).map_err(cache_error)?;
        let bytes = row.get::<_, Vec<u8>>(1).map_err(cache_error)?;
        if dimension <= 0 || bytes.len() != dimension as usize * std::mem::size_of::<f32>() {
            return Ok(None);
        }
        let vector = bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect::<Vec<_>>();
        if vector.iter().all(|value| value.is_finite()) {
            Ok(Some(vector))
        } else {
            Ok(None)
        }
    }

    fn put(&mut self, model_version: &str, hash: &str, vector: &[f32]) -> Result<(), BuildFailure> {
        let bytes = vector
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>();
        self.connection
            .execute(
                &format!(
                    "INSERT OR REPLACE INTO embeddings_v{CACHE_SCHEMA_VERSION}
                     (model_version, normalized_text_hash, dimension, vector)
                     VALUES (?1, ?2, ?3, ?4)"
                ),
                params![model_version, hash, vector.len() as i64, bytes],
            )
            .map_err(cache_error)?;
        Ok(())
    }
}

fn cache_error(error: rusqlite::Error) -> BuildFailure {
    BuildFailure::Failed(format!("Could not use the local semantic cache: {error}"))
}

#[derive(Debug)]
struct SourceDocument {
    path: String,
    title: String,
    kind: String,
    file_kind: String,
    chunks: Vec<SourceChunk>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceChunk {
    line: u32,
    text: String,
}

fn read_source_documents(
    root: &Path,
    cancel: &AtomicBool,
) -> Result<Vec<SourceDocument>, BuildFailure> {
    let mut documents = Vec::new();
    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| semantic_walk_entry(root, entry));
    for entry in walker.filter_map(Result::ok) {
        if cancel.load(Ordering::Acquire) {
            return Err(BuildFailure::Cancelled);
        }
        if !entry.file_type().is_file() || !semantic_source_path(root, entry.path()) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.len() > MAX_SOURCE_BYTES {
            continue;
        }
        let Ok(content) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let relative = entry
            .path()
            .strip_prefix(root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");
        let extension = entry
            .path()
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let (title, chunks) = if extension == "tex" {
            (file_title(&relative), latex_chunks(&content))
        } else {
            markdown_chunks(&content, &file_title(&relative))
        };
        if chunks.is_empty() {
            continue;
        }
        let kind = if is_paper_markdown(&relative) {
            "paper"
        } else {
            "file"
        };
        documents.push(SourceDocument {
            path: relative,
            title,
            kind: kind.to_string(),
            file_kind: extension,
            chunks,
        });
    }
    documents.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(documents)
}

fn semantic_walk_entry(root: &Path, entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
    let normalized = relative.to_string_lossy().replace('\\', "/");
    let first = relative.components().find_map(|component| match component {
        Component::Normal(value) => value.to_str(),
        _ => None,
    });
    if matches!(first, Some(".git" | "node_modules" | "target" | "dist")) {
        return false;
    }
    if first.is_some_and(|part| part.starts_with('.')) {
        return normalized == ".research"
            || normalized == ".research/papers"
            || normalized.starts_with(".research/papers/");
    }
    true
}

fn semantic_source_path(root: &Path, path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "tex" | "md" | "mdx") {
        return false;
    }
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let hidden = relative.split('/').any(|part| part.starts_with('.'));
    !hidden || is_paper_markdown(&relative)
}

fn is_paper_markdown(path: &str) -> bool {
    path.starts_with(".research/papers/")
        && (path.ends_with("/paper.md") || path.ends_with("/blog.md"))
}

fn file_title(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

fn markdown_chunks(content: &str, fallback_title: &str) -> (String, Vec<SourceChunk>) {
    let lines = content.lines().collect::<Vec<_>>();
    let mut start = 0;
    if lines
        .first()
        .is_some_and(|line| line.trim_end_matches('\r') == "---")
    {
        start = lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, line)| line.trim_end_matches('\r') == "---")
            .map_or(lines.len(), |(index, _)| index + 1);
    }
    let mut title = fallback_title.to_string();
    let mut headings: Vec<String> = Vec::new();
    let mut paragraph = Vec::new();
    let mut paragraph_line = 1;
    let mut chunks = Vec::new();
    let mut fence: Option<char> = None;

    for (index, raw_line) in lines.iter().enumerate().skip(start) {
        let line_number = index as u32 + 1;
        let trimmed = raw_line.trim();
        let fence_marker = trimmed
            .strip_prefix("```")
            .map(|_| '`')
            .or_else(|| trimmed.strip_prefix("~~~").map(|_| '~'));
        if let Some(marker) = fence_marker {
            flush_paragraph(&mut chunks, &mut paragraph, paragraph_line, &headings);
            if fence == Some(marker) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(marker);
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if let Some((level, heading)) = markdown_heading(raw_line) {
            flush_paragraph(&mut chunks, &mut paragraph, paragraph_line, &headings);
            headings.truncate(level.saturating_sub(1));
            headings.push(heading.clone());
            if level == 1 && title == fallback_title {
                title = heading.clone();
            }
            push_block(&mut chunks, line_number, "", &headings.join(" › "));
            continue;
        }
        if trimmed.is_empty() {
            flush_paragraph(&mut chunks, &mut paragraph, paragraph_line, &headings);
        } else {
            if paragraph.is_empty() {
                paragraph_line = line_number;
            }
            paragraph.push((*raw_line).to_string());
        }
    }
    flush_paragraph(&mut chunks, &mut paragraph, paragraph_line, &headings);
    (title, chunks)
}

fn markdown_heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start();
    let level = trimmed
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if !(1..=6).contains(&level) || !trimmed[level..].starts_with(char::is_whitespace) {
        return None;
    }
    let heading = trimmed[level..]
        .trim()
        .trim_end_matches('#')
        .trim()
        .to_string();
    (!heading.is_empty()).then_some((level, heading))
}

fn latex_chunks(content: &str) -> Vec<SourceChunk> {
    let mut headings: Vec<String> = Vec::new();
    let mut paragraph = Vec::new();
    let mut paragraph_line = 1;
    let mut chunks = Vec::new();
    for (index, raw_line) in content.lines().enumerate() {
        let line_number = index as u32 + 1;
        let line = strip_latex_comment(raw_line);
        if let Some((level, heading)) = latex_heading(line) {
            flush_paragraph(&mut chunks, &mut paragraph, paragraph_line, &headings);
            headings.truncate(level.saturating_sub(1));
            headings.push(heading);
            push_block(&mut chunks, line_number, "", &headings.join(" › "));
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            flush_paragraph(&mut chunks, &mut paragraph, paragraph_line, &headings);
        } else if is_latex_structure_only(trimmed) {
            continue;
        } else {
            if paragraph.is_empty() {
                paragraph_line = line_number;
            }
            paragraph.push(trimmed.to_string());
        }
    }
    flush_paragraph(&mut chunks, &mut paragraph, paragraph_line, &headings);
    chunks
}

fn strip_latex_comment(line: &str) -> &str {
    for (index, character) in line.char_indices() {
        if character != '%' {
            continue;
        }
        let slash_count = line[..index]
            .chars()
            .rev()
            .take_while(|value| *value == '\\')
            .count();
        if slash_count % 2 == 0 {
            return &line[..index];
        }
    }
    line
}

fn latex_heading(line: &str) -> Option<(usize, String)> {
    const COMMANDS: [(&str, usize); 7] = [
        ("part", 1),
        ("chapter", 1),
        ("section", 2),
        ("subsection", 3),
        ("subsubsection", 4),
        ("paragraph", 5),
        ("subparagraph", 6),
    ];
    for (command, level) in COMMANDS {
        let needle = format!("\\{command}");
        let Some(start) = line.find(&needle) else {
            continue;
        };
        let mut rest = line[start + needle.len()..].trim_start();
        if let Some(after_star) = rest.strip_prefix('*') {
            rest = after_star.trim_start();
        }
        let rest = rest.strip_prefix('{')?;
        let mut depth = 1usize;
        let mut end = None;
        for (index, character) in rest.char_indices() {
            match character {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(index);
                        break;
                    }
                }
                _ => {}
            }
        }
        let heading = normalize_embedding_text(&rest[..end?]);
        if !heading.is_empty() {
            return Some((level, heading));
        }
    }
    None
}

fn is_latex_structure_only(line: &str) -> bool {
    [
        "\\documentclass",
        "\\usepackage",
        "\\begin{",
        "\\end{",
        "\\label{",
        "\\bibliography{",
        "\\bibliographystyle{",
        "\\includegraphics",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
}

fn flush_paragraph(
    chunks: &mut Vec<SourceChunk>,
    paragraph: &mut Vec<String>,
    line: u32,
    headings: &[String],
) {
    if paragraph.is_empty() {
        return;
    }
    let body = paragraph.join(" ");
    paragraph.clear();
    push_block(chunks, line, &headings.join(" › "), &body);
}

fn push_block(chunks: &mut Vec<SourceChunk>, line: u32, context: &str, body: &str) {
    let body = normalize_embedding_text(body);
    if body.is_empty() {
        return;
    }
    let pieces = split_block(
        &body,
        MAX_BLOCK_CHARS.saturating_sub(context.chars().count() + 1),
    );
    for piece in pieces {
        let text = if context.is_empty() || piece == context {
            piece
        } else {
            format!("{context}\n{piece}")
        };
        chunks.push(SourceChunk { line, text });
    }
}

fn split_block(text: &str, maximum: usize) -> Vec<String> {
    let maximum = maximum.max(200);
    if text.chars().count() <= maximum {
        return vec![text.to_string()];
    }
    let mut pieces = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let needed = word.chars().count() + usize::from(!current.is_empty());
        if !current.is_empty() && current.chars().count() + needed > maximum {
            pieces.push(std::mem::take(&mut current));
        }
        if word.chars().count() > maximum {
            let chars = word.chars().collect::<Vec<_>>();
            for slice in chars.chunks(maximum) {
                if !current.is_empty() {
                    pieces.push(std::mem::take(&mut current));
                }
                pieces.push(slice.iter().collect());
            }
            continue;
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        pieces.push(current);
    }
    pieces
}

fn normalize_embedding_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalized_text_hash(normalized: &str) -> String {
    Sha256::digest(normalized.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn normalize_vector(mut vector: Vec<f32>) -> Result<Vec<f32>, ProviderFailure> {
    if vector.is_empty() || vector.iter().any(|value| !value.is_finite()) {
        return Err(ProviderFailure::Text(
            "The sentence model returned an invalid vector.".to_string(),
        ));
    }
    let magnitude = vector
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum::<f64>()
        .sqrt();
    if !magnitude.is_finite() || magnitude <= f64::EPSILON {
        return Err(ProviderFailure::Text(
            "The sentence model returned an empty vector.".to_string(),
        ));
    }
    for value in &mut vector {
        *value = (f64::from(*value) / magnitude) as f32;
    }
    Ok(vector)
}

fn dot(left: &[f32], right: &[f32]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum()
}

fn snippet(text: &str) -> String {
    let mut value = text.chars().take(MAX_SNIPPET_CHARS).collect::<String>();
    if text.chars().count() > MAX_SNIPPET_CHARS {
        value.push('…');
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct FakeProvider {
        version: String,
        calls: Arc<AtomicUsize>,
    }

    impl LocalEmbeddingProvider for FakeProvider {
        fn model_version(&self) -> &str {
            &self.version
        }

        fn embed(&self, text: &str) -> Result<Vec<f32>, ProviderFailure> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            let bytes = Sha256::digest(text.as_bytes());
            Ok(bytes[..8]
                .chunks_exact(2)
                .map(|pair| f32::from(u16::from_le_bytes([pair[0], pair[1]])) + 1.0)
                .collect())
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("lattice-semantic-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn markdown_and_latex_chunk_on_stable_prose_boundaries() {
        let (_, markdown) = markdown_chunks(
            "---\ntags: [private]\n---\n# Methods\n\nFirst paragraph.\ncontinued here.\n\n## Results\n\nSecond paragraph.\n\n```rs\nsecret_code();\n```\n",
            "paper.md",
        );
        assert_eq!(markdown[0].text, "Methods");
        assert_eq!(
            markdown[1].text,
            "Methods\nFirst paragraph. continued here."
        );
        assert_eq!(markdown[2].text, "Methods › Results");
        assert_eq!(markdown[3].text, "Methods › Results\nSecond paragraph.");
        assert!(markdown.iter().all(|chunk| !chunk.text.contains("tags:")));
        assert!(markdown
            .iter()
            .all(|chunk| !chunk.text.contains("secret_code")));

        let latex = latex_chunks(
            "\\documentclass{article}\n\\section{Method}\n\nA local approach. % hidden note\n\n\\subsection{Evaluation}\n\nA measured result.\n",
        );
        assert_eq!(latex[0].text, "Method");
        assert_eq!(latex[1].text, "Method\nA local approach.");
        assert_eq!(latex[2].text, "Method › Evaluation");
        assert_eq!(latex[3].text, "Method › Evaluation\nA measured result.");
    }

    #[test]
    fn editing_one_paragraph_only_embeds_that_new_normalized_hash() {
        let root = temp_dir("incremental");
        let cache = root.join("cache/index.sqlite3");
        let source = root.join("main.tex");
        write(
            &source,
            "\\section{One}\n\nAlpha paragraph.\n\n\\section{Two}\n\nBeta paragraph.\n",
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let provider = FakeProvider {
            version: "test-v1".to_string(),
            calls: Arc::clone(&calls),
        };
        let cancel = AtomicBool::new(false);
        let first = build_index(&root, &cache, &cancel, &provider, |_, _| {}).unwrap();
        let first_calls = calls.load(Ordering::Relaxed);
        assert_eq!(first.index.chunks.len(), 4);

        write(
            &source,
            "\\section{One}\n\nAlpha paragraph changed.\n\n\\section{Two}\n\nBeta paragraph.\n",
        );
        let second = build_index(&root, &cache, &cancel, &provider, |_, _| {}).unwrap();
        assert_eq!(calls.load(Ordering::Relaxed) - first_calls, 1);
        assert_eq!(second.cached_chunks, 3);

        let second_calls = calls.load(Ordering::Relaxed);
        write(
            &source,
            "\\section{One}\n\nAlpha   paragraph changed.\n\n\\section{Two}\n\nBeta paragraph.\n",
        );
        let normalized_only = build_index(&root, &cache, &cancel, &provider, |_, _| {}).unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), second_calls);
        assert_eq!(normalized_only.cached_chunks, 4);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn model_version_is_part_of_the_cache_key() {
        let root = temp_dir("model-version");
        let cache = root.join("cache.sqlite3");
        write(
            &root.join("notes.md"),
            "# Topic\n\nOne reusable paragraph.\n",
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let cancel = AtomicBool::new(false);
        for version in ["model-a", "model-a", "model-b"] {
            let provider = FakeProvider {
                version: version.to_string(),
                calls: Arc::clone(&calls),
            };
            build_index(&root, &cache, &cancel, &provider, |_, _| {}).unwrap();
        }
        // Two stable blocks × two distinct model versions. The second model-a
        // build is fully cached; model-b must not reuse model-a vectors.
        assert_eq!(calls.load(Ordering::Relaxed), 4);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persistent_cache_contains_no_source_text_or_project_path() {
        let root = temp_dir("privacy");
        let cache = root.join("cache.sqlite3");
        let secret = "Confidential theorem about private patient outcomes";
        write(
            &root.join("private/manuscript.md"),
            &format!("# Study\n\n{secret}\n"),
        );
        let provider = FakeProvider {
            version: "privacy-test".to_string(),
            calls: Arc::new(AtomicUsize::new(0)),
        };
        build_index(&root, &cache, &AtomicBool::new(false), &provider, |_, _| {}).unwrap();
        let connection = Connection::open(&cache).unwrap();
        let columns = connection
            .prepare("PRAGMA table_info(embeddings_v1)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            columns,
            [
                "model_version",
                "normalized_text_hash",
                "dimension",
                "vector"
            ]
        );
        drop(connection);
        for suffix in ["", "-wal", "-shm"] {
            let path = PathBuf::from(format!("{}{suffix}", cache.to_string_lossy()));
            let Ok(cache_bytes) = fs::read(path) else {
                continue;
            };
            let cache_text = String::from_utf8_lossy(&cache_bytes);
            assert!(!cache_text.contains(secret));
            assert!(!cache_text.contains("private/manuscript.md"));
            assert!(!cache_text.contains(root.to_string_lossy().as_ref()));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancellation_and_generation_checks_prevent_stale_publication() {
        let search = SemanticSearch::default();
        let (first_generation, first_cancel) = search.begin();
        let (second_generation, _) = search.begin();
        assert!(first_cancel.load(Ordering::Acquire));

        search.finish(
            first_generation,
            Err(BuildFailure::Failed("stale failure".to_string())),
        );
        assert_eq!(search.status().generation, second_generation);
        assert_eq!(search.status().state, "indexing");

        search.cancel();
        assert_eq!(search.status().state, "disabled");
        assert!(search.status().generation > second_generation);
    }

    #[test]
    fn a_pre_cancelled_build_never_reads_or_embeds_the_project() {
        let root = temp_dir("cancelled");
        write(&root.join("paper.md"), "# Secret\n\nNever process this.\n");
        let calls = Arc::new(AtomicUsize::new(0));
        let provider = FakeProvider {
            version: "cancel-test".to_string(),
            calls: Arc::clone(&calls),
        };
        let cancel = AtomicBool::new(true);
        let result = build_index(
            &root,
            &root.join("cache.sqlite3"),
            &cancel,
            &provider,
            |_, _| {},
        );
        assert_eq!(result.unwrap_err(), BuildFailure::Cancelled);
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        fs::remove_dir_all(root).unwrap();
    }

    /// Manual, model-real benchmark. Run on either supported Mac architecture:
    /// `cargo test --release semantic_search::tests::apple_sentence_embedding_benchmark -- --ignored --nocapture`
    #[test]
    #[ignore = "requires Apple's on-device English sentence model"]
    fn apple_sentence_embedding_benchmark() {
        #[cfg(target_os = "macos")]
        {
            let provider = SystemEmbeddingProvider::load().expect("Apple sentence embedding");
            let passages = (0..200)
                .map(|index| {
                    format!(
                        "Section {index}. We evaluate a local retrieval method on scientific manuscripts and report reproducible measurements."
                    )
                })
                .collect::<Vec<_>>();
            let started = std::time::Instant::now();
            for passage in &passages {
                provider.embed(passage).expect("embed passage");
            }
            let elapsed = started.elapsed();
            eprintln!(
                "Apple NLEmbedding: {} chunks in {:.3}s ({:.1} chunks/s)",
                passages.len(),
                elapsed.as_secs_f64(),
                passages.len() as f64 / elapsed.as_secs_f64()
            );
        }
        #[cfg(not(target_os = "macos"))]
        eprintln!("Skipped: Apple NaturalLanguage is available only on macOS.");
    }
}
