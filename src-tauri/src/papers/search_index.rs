//! Full-text search over the paper library: a tantivy index with one
//! document per searchable line of each paper's cached Markdown, plus one for
//! its title, ranked by BM25 and grouped by paper.
//!
//! The index lives in a directory the caller names and indexes the papers the
//! caller lists, with absolute file paths: nothing here knows about a project
//! root, so one index per project today and a wider one later share the code.
//! Each commit records what it indexed (title, files, their size and mtime)
//! in tantivy's commit payload, atomically with the documents, and `sync`
//! re-indexes only the papers whose record differs. A schema change or an
//! index that fails to open or write is deleted and rebuilt from scratch.
//!
//! Step 0 of the design compared this with SQLite FTS5 (unicode61 + trigram)
//! on a 154-paper library: tantivy built in 0.6 s vs 1.6 s, answered in
//! 0.16 ms vs 1.7 ms (29 ms for a two-character Chinese word, which trigram
//! can only LIKE-scan), and took 15 MB on disk vs 96 MB.

mod lines;
mod tokenizer;

use serde::{Deserialize, Serialize};
use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use tantivy::collector::TopDocs;
use tantivy::columnar::{Column, StrColumn};
use tantivy::query::{BooleanQuery, Occur, Query, TermQuery};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, Value, FAST, STORED, STRING,
};
use tantivy::tokenizer::TextAnalyzer;
use tantivy::{
    doc, DocAddress, Index, IndexReader, IndexWriter, ReloadPolicy, Searcher, TantivyDocument,
    TantivyError, Term,
};

/// Bump to rebuild every index: a schema, analyzer or line-reading change.
const SCHEMA_VERSION: u32 = 1;
const TOKENIZER: &str = "lattice_paper";
/// tantivy's floor is 15 MB per indexing thread; a whole library's text
/// (13 MB for 150 papers) fits one segment at this size.
const WRITER_MEMORY: usize = 32_000_000;
/// Lines scored per query before grouping: enough for every paper a
/// panel shows, and to count each one's matches up to this many.
const MAX_SCORED_LINES: usize = 1_000;
/// A prefix expands to at most this many indexed words.
const MAX_PREFIX_TERMS: usize = 64;

/// Where a project keeps its paper index; rebuildable, so under the cache.
pub(crate) fn project_index_dir(root: &Path) -> PathBuf {
    root.join(".research/cache/paper-index")
}

/// One paper as the index reads it: its library key, its title, and its
/// readable files (paper.md, blog.md), each under the path hits report.
pub(crate) struct PaperText {
    pub key: String,
    pub title: String,
    pub files: Vec<PaperFile>,
}

pub(crate) struct PaperFile {
    pub path: String,
    pub absolute: PathBuf,
}

/// A paper that matched, with its best lines in score order.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperTextMatch {
    pub key: String,
    pub title_match: bool,
    /// Matching lines, counted among the best `MAX_SCORED_LINES` overall.
    pub matches: usize,
    pub hits: Vec<LineHit>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineHit {
    pub path: String,
    pub line: u32,
    /// The line around its first match, ellipsized when long.
    pub text: String,
    /// `[from, to)` UTF-16 ranges of `text` that matched the query.
    pub highlights: Vec<[u32; 2]>,
}

#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub papers: usize,
    pub hits_per_paper: usize,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct PaperStamp {
    title: String,
    /// `(path, size, modified_ns)` of each file read.
    files: Vec<(String, u64, i64)>,
}

#[derive(Serialize, Deserialize)]
struct Payload {
    schema: u32,
    papers: BTreeMap<String, PaperStamp>,
}

#[derive(Clone, Copy)]
struct Fields {
    paper: Field,
    path: Field,
    line: Field,
    text: Field,
}

struct OpenIndex {
    index: Index,
    reader: IndexReader,
    fields: Fields,
    indexed: BTreeMap<String, PaperStamp>,
}

/// Each index directory's open index, behind the lock every reader and
/// writer of that directory in this process takes.
type Slot = Arc<Mutex<Option<OpenIndex>>>;
static OPEN: LazyLock<Mutex<HashMap<PathBuf, Slot>>> = LazyLock::new(Default::default);

/// Bring the index at `dir` up to date with `papers`.
pub(crate) fn sync(dir: &Path, papers: &[PaperText]) -> Result<(), String> {
    with_index(dir, |open| sync_open(open, papers).map(drop))
}

/// Sync, then search: papers ranked by their title and best lines, each with
/// its best `limits.hits_per_paper` lines. Every line of a query word must be
/// on one line, the last word also matching as a prefix while it is typed.
pub(crate) fn search(
    dir: &Path, papers: &[PaperText], query: &str, limits: Limits,
) -> Result<Vec<PaperTextMatch>, String> {
    with_index(dir, |open| {
        match sync_open(open, papers) {
            // Another process (a second Lattice build on the same project)
            // holds the writer: search what it last committed.
            Err(TantivyError::LockFailure(..)) => {}
            result => result.map(drop)?,
        }
        search_open(open, query, limits)
    })
}

/// Run `operation` on the open index at `dir`, opening or creating it first.
/// A failure deletes the index and runs `operation` once on a fresh one,
/// unless another process holds its lock.
fn with_index<T>(
    dir: &Path, operation: impl Fn(&mut OpenIndex) -> tantivy::Result<T>,
) -> Result<T, String> {
    let slot = OPEN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(dir.to_path_buf())
        .or_default()
        .clone();
    let mut guard = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let attempt = |guard: &mut Option<OpenIndex>| -> tantivy::Result<T> {
        if guard.is_none() {
            *guard = Some(open_index(dir)?);
        }
        operation(guard.as_mut().expect("opened above"))
    };
    match attempt(&mut guard) {
        Err(error @ TantivyError::LockFailure(..)) => Err(error.to_string()),
        Err(error) => {
            log::warn!("Paper index at {} is rebuilt: {error}", dir.display());
            *guard = None;
            let _ = fs::remove_dir_all(dir);
            attempt(&mut guard).map_err(|error| format!("Paper search index error: {error}"))
        }
        result => result.map_err(|error| error.to_string()),
    }
}

fn schema() -> (Schema, Fields) {
    let mut builder = Schema::builder();
    let indexing = TextFieldIndexing::default()
        .set_tokenizer(TOKENIZER)
        .set_index_option(IndexRecordOption::WithFreqs);
    let fields = Fields {
        paper: builder.add_text_field("paper", STRING | STORED | FAST),
        path: builder.add_text_field("path", STORED),
        line: builder.add_u64_field("line", STORED | FAST),
        text: builder.add_text_field(
            "text",
            TextOptions::default().set_indexing_options(indexing).set_stored(),
        ),
    };
    (builder.build(), fields)
}

/// The index at `dir`, or a new one; one from another schema is an error,
/// which `with_index` answers by rebuilding.
fn open_index(dir: &Path) -> tantivy::Result<OpenIndex> {
    let (schema, fields) = schema();
    let (index, indexed) = if dir.join("meta.json").exists() {
        let index = Index::open_in_dir(dir)?;
        let payload = index.load_metas()?.payload.and_then(|payload| {
            serde_json::from_str::<Payload>(&payload)
                .ok()
                .filter(|payload| payload.schema == SCHEMA_VERSION)
        });
        let Some(payload) = payload.filter(|_| index.schema() == schema) else {
            return Err(TantivyError::SchemaError(format!("not schema {SCHEMA_VERSION}")));
        };
        (index, payload.papers)
    } else {
        fs::create_dir_all(dir)?;
        (Index::create_in_dir(dir, schema)?, BTreeMap::new())
    };
    index.tokenizers().register(TOKENIZER, tokenizer::index_analyzer());
    let reader = index.reader_builder().reload_policy(ReloadPolicy::Manual).try_into()?;
    Ok(OpenIndex { index, reader, fields, indexed })
}

/// Stamped before the read, so a write that lands during it leaves a stamp
/// the next sync sees as stale.
fn stamp(paper: &PaperText) -> PaperStamp {
    let files = paper
        .files
        .iter()
        .filter_map(|file| {
            let metadata = fs::metadata(&file.absolute).ok()?;
            let modified_ns = metadata.mtime() * 1_000_000_000 + metadata.mtime_nsec();
            Some((file.path.clone(), metadata.len(), modified_ns))
        })
        .collect();
    PaperStamp { title: paper.title.clone(), files }
}

/// Re-index the papers whose stamp changed and drop the ones no longer
/// listed, in one commit; true when anything was written.
fn sync_open(open: &mut OpenIndex, papers: &[PaperText]) -> tantivy::Result<bool> {
    let current: BTreeMap<String, PaperStamp> =
        papers.iter().map(|paper| (paper.key.clone(), stamp(paper))).collect();
    let changed: Vec<&PaperText> = papers
        .iter()
        .filter(|paper| open.indexed.get(&paper.key) != current.get(&paper.key))
        .collect();
    let removed: Vec<&String> =
        open.indexed.keys().filter(|key| !current.contains_key(*key)).collect();
    if changed.is_empty() && removed.is_empty() {
        return Ok(false);
    }
    let fields = open.fields;
    let mut writer: IndexWriter = open.index.writer_with_num_threads(1, WRITER_MEMORY)?;
    for key in removed.into_iter().chain(changed.iter().map(|paper| &paper.key)) {
        writer.delete_term(Term::from_field_text(fields.paper, key));
    }
    for paper in &changed {
        add_paper(&writer, fields, paper, &current[&paper.key])?;
    }
    let payload = Payload { schema: SCHEMA_VERSION, papers: current };
    let encoded = serde_json::to_string(&payload)
        .map_err(|error| TantivyError::InternalError(error.to_string()))?;
    let mut commit = writer.prepare_commit()?;
    commit.set_payload(&encoded);
    commit.commit()?;
    writer.wait_merging_threads()?;
    open.reader.reload()?;
    open.indexed = payload.papers;
    Ok(true)
}

fn add_paper(
    writer: &IndexWriter, fields: Fields, paper: &PaperText, stamp: &PaperStamp,
) -> tantivy::Result<()> {
    let Some((first, ..)) = stamp.files.first() else {
        return Ok(());
    };
    // The title's document is line 0 of the file a title hit opens.
    writer.add_document(doc!(
        fields.paper => paper.key.as_str(), fields.path => first.as_str(),
        fields.line => 0u64, fields.text => paper.title.as_str(),
    ))?;
    for file in
        paper.files.iter().filter(|file| stamp.files.iter().any(|(path, ..)| path == &file.path))
    {
        // A file that went away since its stamp is re-read at the next sync.
        let Ok(content) = fs::read_to_string(&file.absolute) else { continue };
        for (line, text) in lines::searchable_lines(&content) {
            writer.add_document(doc!(
                fields.paper => paper.key.as_str(), fields.path => file.path.as_str(),
                fields.line => u64::from(line), fields.text => text,
            ))?;
        }
    }
    Ok(())
}

/// A query word: its stem, and while it is still being typed (the last
/// word, no space after it) the raw word as a prefix too.
struct QueryTerm {
    stem: String,
    prefix: Option<String>,
}

fn query_terms(query: &str) -> Vec<QueryTerm> {
    let mut analyzer = tokenizer::query_analyzer();
    let tokens = tokenizer::tokens(&mut analyzer, query);
    let typing = query.chars().last().is_some_and(char::is_alphanumeric);
    let last = tokens.len().saturating_sub(1);
    let mut seen = HashSet::new();
    tokens
        .into_iter()
        .enumerate()
        .filter(|(_, (stem, ..))| seen.insert(stem.clone()))
        .map(|(index, (stem, from, to))| {
            // The raw word, not its stem: "transfo" stems to itself, which
            // no indexed word equals, but "transform" starts with it.
            let word = &query[from..to];
            let prefix =
                (typing && index == last && word.chars().all(|c| c.is_ascii_alphanumeric()))
                    .then(|| word.to_lowercase());
            QueryTerm { stem, prefix }
        })
        .collect()
}

/// The indexed words that start with `prefix`, across every segment.
fn expand_prefix(searcher: &Searcher, field: Field, prefix: &str) -> tantivy::Result<Vec<String>> {
    let mut words = Vec::new();
    for segment in searcher.segment_readers() {
        let inverted = segment.inverted_index(field)?;
        let mut stream = inverted.terms().range().ge(prefix.as_bytes()).into_stream()?;
        while stream.advance() && words.len() < MAX_PREFIX_TERMS {
            let Ok(word) = std::str::from_utf8(stream.key()) else { continue };
            if !word.starts_with(prefix) {
                break;
            }
            if !words.iter().any(|known| known == word) {
                words.push(word.to_string());
            }
        }
    }
    Ok(words)
}

fn term_query(field: Field, word: &str) -> Box<dyn Query> {
    Box::new(TermQuery::new(Term::from_field_text(field, word), IndexRecordOption::WithFreqs))
}

/// One paper's matching lines while they are grouped.
struct Group {
    title_score: f32,
    lines: Vec<(f32, DocAddress)>,
}

fn search_open(
    open: &OpenIndex, query: &str, limits: Limits,
) -> tantivy::Result<Vec<PaperTextMatch>> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let searcher = open.reader.searcher();
    let field = open.fields.text;
    let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
    let mut prefixes = Vec::new();
    for term in &terms {
        let Some(prefix) = &term.prefix else {
            clauses.push((Occur::Must, term_query(field, &term.stem)));
            continue;
        };
        let mut words = expand_prefix(&searcher, field, prefix)?;
        if !words.contains(&term.stem) {
            words.push(term.stem.clone());
        }
        let any: Vec<(Occur, Box<dyn Query>)> =
            words.iter().map(|word| (Occur::Should, term_query(field, word))).collect();
        clauses.push((Occur::Must, Box::new(BooleanQuery::new(any))));
        prefixes.push(prefix.clone());
    }
    let top = searcher.search(
        &BooleanQuery::new(clauses),
        &TopDocs::with_limit(MAX_SCORED_LINES).order_by_score(),
    )?;

    // Grouped through the fast fields; only the lines a result shows are
    // read from the document store (1,000 stored lines took 15–25 ms).
    let mut columns: HashMap<u32, (StrColumn, Column<u64>)> = HashMap::new();
    let mut groups: Vec<(String, Group)> = Vec::new();
    let mut slot_of: HashMap<String, usize> = HashMap::new();
    let mut key = String::new();
    for (score, address) in top {
        let (papers, lines) = match columns.entry(address.segment_ord) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                let fast = searcher.segment_reader(address.segment_ord).fast_fields();
                let papers = fast
                    .str("paper")?
                    .ok_or_else(|| TantivyError::FieldNotFound("paper".into()))?;
                entry.insert((papers, fast.u64("line")?))
            }
        };
        key.clear();
        if let Some(ord) = papers.term_ords(address.doc_id).next() {
            papers.ord_to_str(ord, &mut key)?;
        }
        let slot = *slot_of.entry(key.clone()).or_insert_with(|| {
            groups.push((key.clone(), Group { title_score: 0.0, lines: Vec::new() }));
            groups.len() - 1
        });
        let group = &mut groups[slot].1;
        if lines.first(address.doc_id).unwrap_or(0) == 0 {
            group.title_score = score;
        } else {
            group.lines.push((score, address));
        }
    }
    // A title match counts double; then the best three lines, each half the
    // last, so a paper about the query outranks one heading that names it.
    let rank = |group: &Group| {
        let lines: f32 = group
            .lines
            .iter()
            .take(3)
            .zip([1.0, 0.5, 0.25])
            .map(|((score, _), weight)| score * weight)
            .sum();
        2.0 * group.title_score + lines
    };
    groups.sort_by(|(_, a), (_, b)| rank(b).total_cmp(&rank(a)));

    let exact: HashSet<&str> = terms.iter().map(|term| term.stem.as_str()).collect();
    let mut analyzer = tokenizer::index_analyzer();
    let fields = open.fields;
    let mut line_hit = |address: DocAddress| -> tantivy::Result<LineHit> {
        let document: TantivyDocument = searcher.doc(address)?;
        let text_of = |field: Field| {
            document.get_first(field).and_then(|value| value.as_str()).unwrap_or_default()
        };
        let text = text_of(fields.text);
        let highlights = highlight_ranges(&mut analyzer, text, &exact, &prefixes);
        let (text, highlights) = lines::snippet(text, &highlights);
        let line =
            document.get_first(fields.line).and_then(|value| value.as_u64()).unwrap_or(0) as u32;
        Ok(LineHit { path: text_of(fields.path).to_string(), line, text, highlights })
    };
    groups
        .into_iter()
        .take(limits.papers)
        .map(|(key, group)| {
            Ok(PaperTextMatch {
                key,
                title_match: group.title_score > 0.0,
                matches: group.lines.len(),
                hits: group
                    .lines
                    .into_iter()
                    .take(limits.hits_per_paper)
                    .map(|(_, address)| line_hit(address))
                    .collect::<tantivy::Result<_>>()?,
            })
        })
        .collect()
}

/// The byte ranges of `text` the query matched, merged where they overlap
/// (the index's search mode emits a Chinese compound and its parts) or only a
/// space or hyphen parts them, so "low-rank adaptation" is one mark.
fn highlight_ranges(
    analyzer: &mut TextAnalyzer, text: &str, exact: &HashSet<&str>, prefixes: &[String],
) -> Vec<(usize, usize)> {
    let mut ranges: Vec<(usize, usize)> = tokenizer::tokens(analyzer, text)
        .into_iter()
        .filter(|(word, ..)| {
            exact.contains(word.as_str())
                || prefixes.iter().any(|prefix| word.starts_with(prefix.as_str()))
        })
        .map(|(_, from, to)| (from, to))
        .collect();
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (from, to) in ranges {
        match merged.last_mut() {
            Some(last)
                if from <= last.1 || text[last.1..from].chars().all(|c| c == ' ' || c == '-') =>
            {
                last.1 = last.1.max(to)
            }
            _ => merged.push((from, to)),
        }
    }
    merged
}

/// Background syncs under way, by index directory; true when another was
/// asked for while one ran, so the running one goes round again.
static PENDING: LazyLock<Mutex<HashMap<PathBuf, bool>>> = LazyLock::new(Default::default);

/// Sync the index at `dir` off the calling thread with the papers `papers`
/// lists when it runs. Requests while one runs coalesce into one more round.
pub(crate) fn sync_in_background(
    dir: PathBuf, papers: impl Fn() -> Result<Vec<PaperText>, String> + Send + 'static,
) {
    {
        let mut pending = PENDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(again) = pending.get_mut(&dir) {
            *again = true;
            return;
        }
        pending.insert(dir.clone(), false);
    }
    std::thread::spawn(move || loop {
        if let Err(error) = papers().and_then(|papers| sync(&dir, &papers)) {
            log::warn!("Paper index sync failed for {}: {error}", dir.display());
        }
        let mut pending = PENDING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if pending.get(&dir) == Some(&true) {
            pending.insert(dir.clone(), false);
            continue;
        }
        pending.remove(&dir);
        break;
    });
}

#[cfg(test)]
mod tests;
