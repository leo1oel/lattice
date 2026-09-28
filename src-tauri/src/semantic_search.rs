//! Opt-in, fully local semantic indexing for project prose.
//!
//! The production provider is macOS NaturalLanguage's built-in English
//! sentence embedding (`embedding`). There is no network client in this
//! module, no model download, and no model file in the application bundle.
//! Source text is read in the background, split into stable prose blocks
//! (`chunks`), embedded on-device, and discarded. The persistent cache
//! (`cache`) contains only a model version, normalized text SHA-256, quantized
//! vector, and a last-used stamp used for eviction.
//!
//! The cache is bounded: every successful build drops rows from other model
//! versions and evicts least-recently-used rows beyond `MAX_CACHE_ROWS`, so no
//! manual cleanup is ever required.

mod cache;
mod chunks;
mod embedding;

use crate::util::collapse_whitespace;
use cache::EmbeddingCache;
use chunks::read_source_documents;
use embedding::{
    normalize_vector, quantize_vector, quantized_score, LocalEmbeddingProvider, ProviderFailure,
    SystemEmbeddingProvider,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const MAX_SOURCE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_BLOCK_CHARS: usize = 1_200;
const MAX_SNIPPET_CHARS: usize = 220;
const MAX_SEMANTIC_CANDIDATES: usize = 24;
const MAX_EMBEDDING_DIMENSION: usize = 16_384;
/// Upper bound on retained cached vectors across every project. At the system
/// model's vector size this is roughly 70 MB of quantized rows; rewriting prose
/// can only recycle this budget, never grow it without bound.
const MAX_CACHE_ROWS: usize = 100_000;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
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
    fn new(state: &str, detail: Option<String>, generation: u64) -> Self {
        Self { state: state.to_string(), detail, generation, ..Self::default() }
    }

    fn disabled(generation: u64) -> Self {
        Self::new("disabled", None, generation)
    }

    /// A `state` that reports the model and size of `index`, when there is one.
    fn describing(
        state: &str, detail: &str, generation: u64, index: Option<&SemanticIndex>,
    ) -> Self {
        Self {
            model_version: index.map(|index| index.model_version.clone()),
            indexed_files: index.map_or(0, |index| index.indexed_files),
            indexed_chunks: index.map_or(0, |index| index.chunks.len()),
            ..Self::new(state, Some(detail.to_string()), generation)
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
        Self { generation: 0, cancel: None, status: SemanticSearchStatus::disabled(0), index: None }
    }
}

impl SemanticSearch {
    fn lock(&self) -> std::sync::MutexGuard<'_, SearchState> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Cancel the running build, if any, and start a new generation.
    fn next_generation(state: &mut SearchState) -> u64 {
        if let Some(cancel) = state.cancel.take() {
            cancel.store(true, Ordering::Release);
        }
        state.generation = state.generation.wrapping_add(1);
        state.generation
    }

    fn begin(&self) -> (u64, Arc<AtomicBool>) {
        let mut state = self.lock();
        let generation = Self::next_generation(&mut state);
        let cancel = Arc::new(AtomicBool::new(false));
        state.cancel = Some(Arc::clone(&cancel));
        state.status = SemanticSearchStatus::describing(
            "indexing",
            "Building an on-device index in the background.",
            generation,
            state.index.as_deref(),
        );
        (generation, cancel)
    }

    fn note_progress(&self, generation: u64, indexed_files: usize, total_chunks: usize) {
        let mut state = self.lock();
        if state.generation != generation || state.status.state != "indexing" {
            return;
        }
        state.status.indexed_files = indexed_files;
        state.status.total_chunks = total_chunks;
    }

    fn finish(&self, generation: u64, result: Result<BuildOutput, BuildFailure>) {
        let mut state = self.lock();
        if state.generation != generation {
            return;
        }
        state.cancel = None;
        state.index = None;
        state.status = match result {
            Ok(output) => {
                let status = SemanticSearchStatus {
                    cached_chunks: output.cached_chunks,
                    total_chunks: output.total_chunks,
                    ..SemanticSearchStatus::describing(
                        "ready",
                        "Apple Natural Language · English · source text stays on this Mac.",
                        generation,
                        Some(&output.index),
                    )
                };
                state.index = Some(Arc::new(output.index));
                status
            }
            Err(BuildFailure::Cancelled) => SemanticSearchStatus::disabled(generation),
            Err(BuildFailure::Unavailable(detail)) => {
                SemanticSearchStatus::new("unavailable", Some(detail), generation)
            }
            Err(BuildFailure::Failed(detail)) => {
                SemanticSearchStatus::new("error", Some(detail), generation)
            }
        };
    }

    pub fn cancel(&self) -> SemanticSearchStatus {
        let mut state = self.lock();
        let generation = Self::next_generation(&mut state);
        state.index = None;
        state.status = SemanticSearchStatus::disabled(generation);
        state.status.clone()
    }

    pub fn status(&self) -> SemanticSearchStatus {
        self.lock().status.clone()
    }

    fn snapshot(&self) -> (SemanticSearchStatus, Option<Arc<SemanticIndex>>) {
        let state = self.lock();
        (state.status.clone(), state.index.clone())
    }

    /// `status` if the snapshot it came from is still current, else the
    /// current status and `false`.
    fn status_for_snapshot(
        &self, status: SemanticSearchStatus, index: Option<&Arc<SemanticIndex>>,
    ) -> (SemanticSearchStatus, bool) {
        let state = self.lock();
        let index_matches = index.map(Arc::as_ptr) == state.index.as_ref().map(Arc::as_ptr);
        if state.generation == status.generation && index_matches {
            (status, true)
        } else {
            (state.status.clone(), false)
        }
    }
}

/// Starts a new generation and returns immediately. A previous generation is
/// cooperatively cancelled; only the newest worker can publish its index.
pub fn start_index(search: Arc<SemanticSearch>, root: PathBuf, cache_path: PathBuf) {
    let (generation, cancel) = search.begin();
    tauri::async_runtime::spawn_blocking(move || {
        let result = SystemEmbeddingProvider::load()
            .map_err(|error| BuildFailure::Unavailable(error.detail().to_string()))
            .and_then(|provider| {
                build_index(&root, &cache_path, &cancel, &provider, |files, chunks| {
                    search.note_progress(generation, files, chunks);
                })
            });
        search.finish(generation, result);
    });
}

/// Embeds a query on a blocking worker (the Tauri command supplies that worker)
/// and returns only short local snippets plus per-document cosine scores. If
/// the provider/index is unavailable, `applied` is false and callers retain the
/// lexical result unchanged.
pub fn search(search: &SemanticSearch, query: &str) -> SemanticSearchResponse {
    let (status, index) = search.snapshot();
    let Some(index) = index else {
        return fallback_response(search, status, None);
    };
    let normalized = collapse_whitespace(query);
    if index.chunks.is_empty() || normalized.is_empty() {
        return fallback_response(search, status, Some(&index));
    }
    let unavailable = |detail: String| {
        let status = SemanticSearchStatus {
            state: "unavailable".to_string(),
            detail: Some(detail),
            ..status.clone()
        };
        fallback_response(search, status, Some(&index))
    };

    let provider = match SystemEmbeddingProvider::load() {
        Ok(provider) => provider,
        Err(error) => return unavailable(error.detail().to_string()),
    };
    if provider.model_version() != index.model_version {
        return unavailable(
            "The system embedding model changed; showing lexical results until the local index is rebuilt."
                .to_string(),
        );
    }
    let query_vector = match provider.embed(&normalized).and_then(normalize_vector) {
        Ok(vector) if vector.len() == index.dimension => vector,
        Ok(_) => {
            return unavailable(
                "The system embedding dimension changed; showing lexical results.".to_string(),
            )
        }
        Err(error) => return unavailable(format!("{} Showing lexical results.", error.detail())),
    };

    let mut best_by_path: HashMap<&str, (f32, &IndexedChunk)> = HashMap::new();
    for chunk in &index.chunks {
        let score = quantized_score(&query_vector, &chunk.vector);
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
            path: chunk.path.to_string(),
            title: chunk.title.to_string(),
            snippet: chunk.snippet.clone(),
            line: chunk.line,
            score,
            kind: chunk.kind.to_string(),
            file_kind: chunk.file_kind.to_string(),
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right.score.total_cmp(&left.score).then_with(|| left.path.cmp(&right.path))
    });
    candidates.truncate(MAX_SEMANTIC_CANDIDATES);
    // A project switch, opt-out, or newer index generation may race this
    // blocking query after it snapshots the old Arc. Never publish paths or
    // snippets from an index that is no longer the current project resource.
    let (status, current) = search.status_for_snapshot(status, Some(&index));
    if !current {
        return SemanticSearchResponse { status, applied: false, candidates: Vec::new() };
    }
    SemanticSearchResponse { status, applied: !candidates.is_empty(), candidates }
}

fn fallback_response(
    search: &SemanticSearch, status: SemanticSearchStatus, index: Option<&Arc<SemanticIndex>>,
) -> SemanticSearchResponse {
    let (status, _) = search.status_for_snapshot(status, index);
    SemanticSearchResponse { status, applied: false, candidates: Vec::new() }
}

#[derive(Debug)]
struct SemanticIndex {
    model_version: String,
    dimension: usize,
    indexed_files: usize,
    chunks: Vec<IndexedChunk>,
}

/// Per-document fields are shared across that document's chunks: a long chapter
/// otherwise pays for one copy of its path and title per prose block.
#[derive(Debug)]
struct IndexedChunk {
    path: Arc<str>,
    title: Arc<str>,
    snippet: String,
    line: u32,
    kind: Arc<str>,
    file_kind: Arc<str>,
    vector: Arc<[i8]>,
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

fn build_index(
    root: &Path, cache_path: &Path, cancel: &AtomicBool, provider: &impl LocalEmbeddingProvider,
    mut progress: impl FnMut(usize, usize),
) -> Result<BuildOutput, BuildFailure> {
    let cancelled = || cancel.load(Ordering::Acquire);
    if cancelled() {
        return Err(BuildFailure::Cancelled);
    }
    let model_version = provider.model_version();
    let documents = read_source_documents(root, cancel)?;
    let total_chunks = documents.iter().map(|document| document.chunks.len()).sum();
    progress(documents.len(), total_chunks);
    let make_index = |dimension, indexed_files, chunks| SemanticIndex {
        model_version: model_version.to_string(),
        dimension,
        indexed_files,
        chunks,
    };
    if total_chunks == 0 {
        let index = make_index(0, documents.len(), Vec::new());
        return Ok(BuildOutput { index, total_chunks, cached_chunks: 0 });
    }

    let mut cache = EmbeddingCache::open(cache_path)?;
    let mut vectors_by_hash: HashMap<String, Arc<[i8]>> = HashMap::new();
    let mut indexed = Vec::with_capacity(total_chunks);
    let mut cached_chunks = 0;
    let mut dimension = None;
    for document in documents {
        let path: Arc<str> = Arc::from(document.path);
        let title: Arc<str> = Arc::from(document.title);
        let kind: Arc<str> = Arc::from(document.kind);
        let file_kind: Arc<str> = Arc::from(document.file_kind);
        for chunk in document.chunks {
            if cancelled() {
                return Err(BuildFailure::Cancelled);
            }
            let normalized = collapse_whitespace(&chunk.text);
            if normalized.is_empty() {
                continue;
            }
            let hash = crate::util::sha256_hex(&normalized);
            let vector = if let Some(vector) = vectors_by_hash.get(&hash) {
                cached_chunks += 1;
                Arc::clone(vector)
            } else {
                let vector = if let Some(vector) = cache.get(model_version, &hash)? {
                    cached_chunks += 1;
                    vector
                } else {
                    let vector = match provider.embed(&normalized).and_then(normalize_vector) {
                        Ok(vector) => quantize_vector(&vector),
                        // A prose block with no usable language signal should
                        // not make the entire project unavailable. Query
                        // failures are handled separately and always fall back
                        // to lexical.
                        Err(ProviderFailure::Text(_)) => continue,
                        Err(ProviderFailure::Unavailable(detail)) => {
                            return Err(BuildFailure::Unavailable(detail));
                        }
                    };
                    cache.put(model_version, &hash, &vector)?;
                    vector
                };
                let vector: Arc<[i8]> = Arc::from(vector);
                vectors_by_hash.insert(hash, Arc::clone(&vector));
                vector
            };
            if vector.is_empty() {
                continue;
            }
            if *dimension.get_or_insert(vector.len()) != vector.len() {
                return Err(BuildFailure::Failed(
                    "Cached embeddings have inconsistent dimensions.".to_string(),
                ));
            }
            indexed.push(IndexedChunk {
                path: Arc::clone(&path),
                title: Arc::clone(&title),
                snippet: crate::util::truncate_chars(&normalized, MAX_SNIPPET_CHARS),
                line: chunk.line,
                kind: Arc::clone(&kind),
                file_kind: Arc::clone(&file_kind),
                vector,
            });
        }
    }
    if indexed.is_empty() {
        return Err(BuildFailure::Unavailable(
            "Apple's English sentence model could not embed this project's prose.".to_string(),
        ));
    }
    // Cache maintenance keeps the shared on-disk cache bounded, but it is not
    // part of the answer: a failed prune must never discard a usable index.
    if !cancelled() {
        let live = vectors_by_hash.into_keys().collect::<Vec<_>>();
        let _ = cache.touch(model_version, &live);
        let _ = cache.prune(model_version, live.len().max(MAX_CACHE_ROWS));
    }
    let indexed_files = indexed.iter().map(|chunk| &*chunk.path).collect::<HashSet<_>>().len();
    let index = make_index(dimension.unwrap_or(0), indexed_files, indexed);
    Ok(BuildOutput { index, total_chunks, cached_chunks })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::sync::atomic::AtomicUsize;

    fn cache_path(project: &Path) -> PathBuf {
        project.join("cache/index.sqlite3")
    }

    fn build(
        project: &Path, provider: &FakeProvider, cancelled: bool,
    ) -> Result<BuildOutput, BuildFailure> {
        let cancel = AtomicBool::new(cancelled);
        build_index(project, &cache_path(project), &cancel, provider, |_, _| {})
    }

    pub(super) fn column<T: rusqlite::types::FromSql>(
        connection: &rusqlite::Connection, sql: &str,
    ) -> Vec<T> {
        let mut statement = connection.prepare(sql).unwrap();
        let rows = statement.query_map([], |row| row.get::<_, T>(0)).unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }

    /// Deterministic 4-dimensional vectors derived from the text's SHA-256.
    struct FakeProvider {
        version: &'static str,
        calls: Arc<AtomicUsize>,
    }

    impl FakeProvider {
        fn new(version: &'static str) -> Self {
            Self { version, calls: Arc::default() }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::Relaxed)
        }
    }

    impl LocalEmbeddingProvider for FakeProvider {
        fn model_version(&self) -> &str {
            self.version
        }

        fn embed(&self, text: &str) -> Result<Vec<f32>, ProviderFailure> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            let bytes = <sha2::Sha256 as sha2::Digest>::digest(text.as_bytes());
            Ok(bytes[..8]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| f32::from(u16::from_le_bytes([pair[0], pair[1]])) + 1.0)
                .collect())
        }
    }

    /// Each rebuild also runs cache maintenance, so a cached rebuild proves
    /// eviction never reclaims the vectors the previous build just used.
    #[test]
    fn editing_one_paragraph_only_embeds_that_new_normalized_hash() {
        let project = TempDir::new("incremental");
        let provider = FakeProvider::new("test-v1");
        let mut expected_calls = 0;
        for (paragraph, new_embeddings, cached_chunks) in [
            ("Alpha paragraph.", 4, 0),
            ("Alpha paragraph changed.", 1, 3),
            // Whitespace-only edits keep the normalized hash.
            ("Alpha   paragraph changed.", 0, 4),
        ] {
            project.write(
                "main.tex",
                format!("\\section{{One}}\n\n{paragraph}\n\n\\section{{Two}}\n\nBeta paragraph.\n"),
            );
            let output = build(&project, &provider, false).unwrap();
            expected_calls += new_embeddings;
            assert_eq!(provider.calls(), expected_calls, "{paragraph}");
            assert_eq!(output.cached_chunks, cached_chunks, "{paragraph}");
            assert_eq!(output.index.chunks.len(), 4);
        }
    }

    #[test]
    fn model_version_is_part_of_the_cache_key() {
        let project = TempDir::new("model-version");
        project.write("notes.md", "# Topic\n\nOne reusable paragraph.\n");
        let calls = Arc::new(AtomicUsize::new(0));
        for version in ["model-a", "model-a", "model-b"] {
            build(&project, &FakeProvider { version, calls: Arc::clone(&calls) }, false).unwrap();
        }
        // Two stable blocks × two distinct model versions. The second model-a
        // build is fully cached; model-b must not reuse model-a vectors.
        assert_eq!(calls.load(Ordering::Relaxed), 4);
    }

    #[test]
    fn persistent_cache_contains_no_source_text_or_project_path() {
        let project = TempDir::new("privacy");
        let secret = "Confidential theorem about private patient outcomes";
        project.write("private/manuscript.md", format!("# Study\n\n{secret}\n"));
        build(&project, &FakeProvider::new("privacy-test"), false).unwrap();
        let cache = cache_path(&project);
        let columns: Vec<String> = column(
            &rusqlite::Connection::open(&cache).unwrap(),
            "SELECT name FROM pragma_table_info('embeddings_v2')",
        );
        assert_eq!(
            columns,
            ["model_version", "normalized_text_hash", "dimension", "vector", "last_used_ts"]
        );
        let root = project.to_string_lossy();
        for suffix in ["", "-wal", "-shm"] {
            let path = PathBuf::from(format!("{}{suffix}", cache.to_string_lossy()));
            let Ok(cache_bytes) = std::fs::read(path) else {
                continue;
            };
            let cache_text = String::from_utf8_lossy(&cache_bytes);
            for private in [secret, "private/manuscript.md", &root] {
                assert!(!cache_text.contains(private), "{private}");
            }
        }
    }

    #[test]
    fn a_pre_cancelled_build_never_reads_or_embeds_the_project() {
        let project = TempDir::new("cancelled");
        project.write("paper.md", "# Secret\n\nNever process this.\n");
        let provider = FakeProvider::new("cancel-test");
        assert_eq!(build(&project, &provider, true).unwrap_err(), BuildFailure::Cancelled);
        assert_eq!(provider.calls(), 0);
    }

    /// Covers index snapshots too: one taken before cancellation cannot
    /// publish candidates afterwards.
    #[test]
    fn cancellation_and_generation_checks_prevent_stale_publication() {
        let search = SemanticSearch::default();
        let (first_generation, first_cancel) = search.begin();
        let (second_generation, _) = search.begin();
        assert!(first_cancel.load(Ordering::Acquire));

        search.finish(first_generation, Err(BuildFailure::Failed("stale failure".to_string())));
        assert_eq!(search.status().generation, second_generation);
        assert_eq!(search.status().state, "indexing");

        let index = Arc::new(SemanticIndex {
            model_version: "test-v1".to_string(),
            dimension: 4,
            indexed_files: 1,
            chunks: Vec::new(),
        });
        search.lock().index = Some(Arc::clone(&index));
        let snapshot = search.status();
        assert!(search.status_for_snapshot(snapshot.clone(), Some(&index)).1);

        search.cancel();
        assert_eq!(search.status().state, "disabled");
        assert!(search.status().generation > second_generation);
        let response = fallback_response(&search, snapshot, Some(&index));
        assert_eq!(response.status.state, "disabled");
        assert_eq!(response.status.generation, search.status().generation);
    }
}
