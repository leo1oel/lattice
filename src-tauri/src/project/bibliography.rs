//! BibTeX as the project stores it: one scanner for entries, field parsing,
//! identifiers (DOI, arXiv), editing a single entry, and the SyncTeX hops
//! between a `.bib` source and the generated `.bbl`.

use super::citation_lookup::citation_from_bibtex;
use super::history::{apply_citation_transaction, current_text};
use super::manifest::read_manifest;
use super::paths::safe_path;
use super::tree::{scan_tree, tree_files, TreeView};
use super::{err, line_number_at, skip_bytes};
use crate::models::{CitationInfo, ResolvedCitation, SyncTexTarget};
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

/// One editable `@type{key, …}` (or `@type(key, …)`) entry.
struct BibRecord<'a> {
    key: String,
    /// Offset of the `@`.
    start: usize,
    /// Text between the key's comma and the closing delimiter.
    body: &'a str,
    /// Just past the closing delimiter (clamped to the source length).
    end: usize,
}

/// Every entry with a key, skipping `@comment`, `@preamble`, and `@string`.
/// The single scanner behind parsing, spans, and in-place edits.
fn scan_entries(bibliography: &str) -> Vec<BibRecord<'_>> {
    let bytes = bibliography.as_bytes();
    let mut cursor = 0;
    let mut records = Vec::new();
    while cursor < bytes.len() {
        let Some(relative_start) = bibliography[cursor..].find('@') else {
            break;
        };
        let start = cursor + relative_start;
        let type_end = skip_bytes(bytes, start + 1, u8::is_ascii_alphabetic);
        let entry_type = bibliography[start + 1..type_end].to_ascii_lowercase();
        let mut position = skip_bytes(bytes, type_end, u8::is_ascii_whitespace);
        let Some(&opening) = bytes.get(position).filter(|value| matches!(value, b'{' | b'('))
        else {
            cursor = position.saturating_add(1);
            continue;
        };
        let closing = if opening == b'{' { b'}' } else { b')' };
        let key_start = skip_bytes(bytes, position + 1, u8::is_ascii_whitespace);
        position = skip_bytes(bytes, key_start, |byte| *byte != b',' && *byte != closing);
        if bytes.get(position) != Some(&b',') {
            cursor = position.saturating_add(1);
            continue;
        }
        let key = bibliography[key_start..position].trim().to_string();
        position += 1;
        let body_start = position;
        let (mut depth, mut quoted) = (1usize, false);
        while position < bytes.len() {
            let byte = bytes[position];
            if byte == b'"' && bytes[position - 1] != b'\\' {
                quoted = !quoted;
            } else if !quoted && byte == opening {
                depth += 1;
            } else if !quoted && byte == closing {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            position += 1;
        }
        cursor = position.saturating_add(1);
        if !key.is_empty() && !matches!(entry_type.as_str(), "comment" | "preamble" | "string") {
            records.push(BibRecord {
                key,
                start,
                body: &bibliography[body_start..position],
                end: cursor.min(bytes.len()),
            });
        }
    }
    records
}

pub(crate) fn parse_bibliography(bibliography: &str) -> Vec<CitationInfo> {
    scan_entries(bibliography)
        .into_iter()
        .map(|record| {
            let fields = parse_bibliography_fields_raw(record.body)
                .into_iter()
                .map(|(name, value)| (name, clean_bibliography_value(&value)))
                .collect::<BTreeMap<_, _>>();
            let field = |name: &str| fields.get(name).cloned().unwrap_or_default();
            CitationInfo {
                title: field("title"),
                authors: field("author"),
                year: field("year"),
                venue: fields
                    .get("journal")
                    .or_else(|| fields.get("booktitle"))
                    .or_else(|| fields.get("publisher"))
                    .cloned()
                    .unwrap_or_default(),
                arxiv_id: bibliography_arxiv_id(&fields),
                doi: fields.get("doi").and_then(|value| normalize_doi(value)),
                url: fields
                    .get("url")
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                key: record.key,
            }
        })
        .collect()
}

/// Parsed citation key and byte range for every editable BibTeX entry.
pub(crate) fn bibliography_entry_spans(bibliography: &str) -> Vec<(String, usize, usize)> {
    scan_entries(bibliography)
        .into_iter()
        .map(|record| (record.key, record.start, record.end))
        .collect()
}

/// Byte range `[start, end)` of the entry whose key matches (case-insensitive),
/// from the `@` through its closing brace.
fn bib_entry_span(bibliography: &str, target_key: &str) -> Option<(usize, usize)> {
    let target = target_key.trim();
    bibliography_entry_spans(bibliography)
        .into_iter()
        .find(|(key, _, _)| key.eq_ignore_ascii_case(target))
        .map(|(_, start, end)| (start, end))
}

static DOI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^10\.\d{4,9}/\S+$").expect("valid DOI regex"));

/// Canonical DOI spelling used as the cache and Crossref lookup identity.
/// DOI matching is case-insensitive; resolver prefixes are presentation only.
pub(crate) fn normalize_doi(value: &str) -> Option<String> {
    let mut value = value.trim();
    for prefix in ["https://doi.org/", "http://doi.org/", "http://dx.doi.org/", "doi:"] {
        if value.get(..prefix.len()).is_some_and(|start| start.eq_ignore_ascii_case(prefix)) {
            value = value[prefix.len()..].trim();
            break;
        }
    }
    let value = value.to_ascii_lowercase();
    DOI.is_match(&value).then_some(value)
}

static ARXIV_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?ix)(?:
            ^\s* |
            arxiv\s*(?:preprint\s*)?(?::|\.)\s* |
            arxiv\.org/(?:abs|pdf)/ |
            10\.48550/arxiv\.
        )
        (?P<id>\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?/\d{7}(?:v\d+)?)
        (?:\.pdf)?(?:\s*$|[^a-z0-9./])",
    )
    .expect("valid arXiv id regex")
});

/// arXiv preprints reach a .bib in several shapes. Extract them all here so
/// every bibliography consumer sees the same identifier.
pub(crate) fn bibliography_arxiv_id(fields: &BTreeMap<String, String>) -> Option<String> {
    ["eprint", "url", "doi", "journal", "note", "booktitle", "howpublished"]
        .iter()
        .filter_map(|field| fields.get(*field))
        .find_map(|value| ARXIV_ID.captures(value)?.name("id").map(|id| id.as_str().to_string()))
}

/// Field values with their delimiters stripped (`{A}` → `A`).
pub(crate) fn parse_bibliography_fields_raw(body: &str) -> BTreeMap<String, String> {
    parse_bibliography_field_values(body, false)
}

/// Preserve braces, quotes and bare macros when merging BibTeX records.
/// `jul` and `{jul}` have different meanings to the bibliography processor.
pub(crate) fn parse_bibliography_fields_syntax(body: &str) -> BTreeMap<String, String> {
    parse_bibliography_field_values(body, true)
}

fn parse_bibliography_field_values(body: &str, preserve_syntax: bool) -> BTreeMap<String, String> {
    let bytes = body.as_bytes();
    let mut fields = BTreeMap::new();
    let mut position = 0;
    while position < bytes.len() {
        let name_start =
            skip_bytes(bytes, position, |byte| byte.is_ascii_whitespace() || *byte == b',');
        position = skip_bytes(bytes, name_start, |byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
        });
        if name_start == position {
            position += 1;
            continue;
        }
        let name = body[name_start..position].to_ascii_lowercase();
        position = skip_bytes(bytes, position, u8::is_ascii_whitespace);
        if bytes.get(position) != Some(&b'=') {
            continue;
        }
        let expression_start = skip_bytes(bytes, position + 1, u8::is_ascii_whitespace);
        position = expression_start;
        let value = match bytes.get(position) {
            Some(b'{') => delimited_value(body, &mut position, true),
            Some(b'"') => delimited_value(body, &mut position, false),
            Some(_) => {
                position = skip_bytes(bytes, position, |byte| *byte != b',');
                body[expression_start..position].to_string()
            }
            None => String::new(),
        };
        let syntax = || body[expression_start..position].trim().to_string();
        fields.insert(name, if preserve_syntax { syntax() } else { value });
    }
    fields
}

/// The value inside a `{…}` (nesting-aware) or `"…"` (backslash-escaped)
/// expression starting at `*position`, leaving `*position` past its end.
/// An unterminated value runs to the end of the body.
fn delimited_value(body: &str, position: &mut usize, braced: bool) -> String {
    let bytes = body.as_bytes();
    *position += 1;
    let start = *position;
    let mut depth = 1usize;
    while *position < bytes.len() {
        let closes = match bytes[*position] {
            b'{' if braced => {
                depth += 1;
                false
            }
            b'}' if braced => {
                depth -= 1;
                depth == 0
            }
            b'"' if !braced => *position == start || bytes[*position - 1] != b'\\',
            _ => false,
        };
        if closes {
            let value = body[start..*position].to_string();
            *position += 1;
            return value;
        }
        *position += 1;
    }
    body[start..].to_string()
}

fn clean_bibliography_value(value: &str) -> String {
    value
        .replace(['{', '}'], "")
        .replace("\\&", "&")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The project's `.bib` files as `(relative path, contents)`: the manifest's
/// primary bibliography first, then every other `.bib` in the tree.
pub(crate) fn iter_bibliography_sources(root: &Path) -> Result<Vec<(String, String)>, String> {
    let manifest = read_manifest(root)?;
    let scanned = scan_tree(root, TreeView::Inventory)?;
    let candidates = std::iter::once(manifest.primary_bibliography).chain(
        tree_files(&scanned)
            .into_iter()
            .filter(|node| node.kind == "bib")
            .map(|node| node.path.clone()),
    );
    let mut seen = BTreeSet::new();
    let mut sources = Vec::new();
    for relative in candidates.filter(|relative| seen.insert(relative.clone())) {
        let path = safe_path(root, &relative)?;
        if path.is_file() {
            let contents = fs::read_to_string(&path).map_err(err)?;
            sources.push((relative, contents));
        }
    }
    Ok(sources)
}

pub fn citations(root: &Path) -> Result<Vec<CitationInfo>, String> {
    let sources = iter_bibliography_sources(root)?;
    let mut citations = sources
        .iter()
        .flat_map(|(_, bibliography)| parse_bibliography(bibliography))
        .collect::<Vec<_>>();
    citations.sort_by_key(|citation| citation.key.to_lowercase());
    citations.dedup_by(|left, right| left.key.eq_ignore_ascii_case(&right.key));
    Ok(citations)
}

/// The primary bibliography's path and contents (`None` when the file is missing).
fn primary_bibliography(root: &Path) -> Result<(String, Option<String>), String> {
    let relative = read_manifest(root)?.primary_bibliography;
    let path = safe_path(root, &relative)?;
    Ok((relative, current_text(&path)?))
}

/// The full field set of a single existing entry (by citation key) from the
/// project's primary bibliography, for pre-filling the entry editor.
pub fn read_bib_entry(root: &Path, key: &str) -> Result<Option<ResolvedCitation>, String> {
    let (_, Some(bibliography)) = primary_bibliography(root)? else {
        return Ok(None);
    };
    Ok(bib_entry_span(&bibliography, key)
        .map(|(start, end)| citation_from_bibtex(&bibliography[start..end], key)))
}

/// Replace the entry with `key` in the primary bibliography (or append it when
/// absent), writing the whole file through the undoable transaction log.
pub fn save_bib_entry(root: &Path, key: &str, bibtex: &str) -> Result<(), String> {
    let (relative, existing) = primary_bibliography(root)?;
    let existing = existing.unwrap_or_default();
    let entry = bibtex.trim();
    let next = match bib_entry_span(&existing, key) {
        Some((start, end)) => format!("{}{}{}", &existing[..start], entry, &existing[end..]),
        None if existing.trim_end().is_empty() => format!("{entry}\n"),
        None => format!("{}\n\n{entry}\n", existing.trim_end()),
    };
    apply_citation_transaction(root, &format!("Edit {relative}"), vec![(relative.clone(), next)])?;
    Ok(())
}

/// A reverse SyncTeX click on a rendered reference lands in the generated `.bbl`,
/// which the writer never edits. Follow the `\bibitem` there back to its source
/// `.bib` entry so "jump to source" opens something editable.
pub fn bib_target_for_bbl(
    root: &Path, bbl_relative: &Path, line: u32,
) -> Result<Option<SyncTexTarget>, String> {
    let contents = fs::read_to_string(root.join(bbl_relative)).map_err(err)?;
    let Some(key) = bibitem_key_at(&contents, line) else {
        return Ok(None);
    };
    for (relative, source) in iter_bibliography_sources(root)? {
        if let Some((start, _)) = bib_entry_span(&source, &key) {
            return Ok(Some(SyncTexTarget {
                path: relative,
                line: line_number_at(&source, start),
            }));
        }
    }
    Ok(None)
}

/// A forward SyncTeX lookup cannot start from a `.bib` source because TeX reads
/// the generated `.bbl` instead. Resolve the entry under the cursor to its
/// `\bibitem` and return that generated source position.
pub fn bbl_target_for_bib(
    root: &Path, bib_relative: &Path, bbl_relative: &Path, line: u32,
) -> Result<Option<SyncTexTarget>, String> {
    let bibliography = fs::read_to_string(root.join(bib_relative)).map_err(err)?;
    let Some(key) = bib_entry_key_at(&bibliography, line) else {
        return Ok(None);
    };
    let bbl_path = root.join(bbl_relative);
    if !bbl_path.is_file() {
        return Ok(None);
    }
    let bbl = fs::read_to_string(bbl_path).map_err(err)?;
    Ok(bibitem_line(&bbl, &key).map(|item_line| SyncTexTarget {
        path: bbl_relative.to_string_lossy().replace('\\', "/"),
        line: item_line,
    }))
}

fn parse_bibitem_key(after_bibitem: &str) -> Option<String> {
    let after = after_bibitem.trim_start();
    // Skip natbib's optional [label] argument.
    let after = match after.strip_prefix('[') {
        Some(rest) => rest[rest.find(']')? + 1..].trim_start(),
        None => after,
    };
    let rest = after.strip_prefix('{')?;
    let key = rest[..rest.find('}')?].trim();
    (!key.is_empty()).then(|| key.to_string())
}

/// Byte range of 1-based `line`, counting one separator byte per `lines()` item.
fn line_range(contents: &str, line: u32) -> Option<(usize, usize)> {
    let mut start = 0usize;
    for (index, text) in contents.lines().enumerate() {
        if index as u32 + 1 == line {
            return Some((start, start + text.len()));
        }
        start += text.len() + 1;
    }
    None
}

/// The citation key of the `\bibitem` that governs `line` (1-based) in a `.bbl`.
fn bibitem_key_at(contents: &str, line: u32) -> Option<String> {
    // Just past the end of the target line, so a click on the `\bibitem` line
    // itself still finds it.
    let boundary =
        line_range(contents, line).map_or(contents.len(), |(_, end)| (end + 1).min(contents.len()));
    let item_start = contents[..boundary].rfind("\\bibitem")?;
    parse_bibitem_key(&contents[item_start + "\\bibitem".len()..])
}

/// The 1-based line containing the generated `\bibitem` for `key`.
fn bibitem_line(contents: &str, key: &str) -> Option<u32> {
    contents.match_indices("\\bibitem").find_map(|(start, _)| {
        parse_bibitem_key(&contents[start + "\\bibitem".len()..])
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(key))
            .then(|| line_number_at(contents, start))
    })
}

/// The citation key of the `.bib` entry containing `line` (1-based).
fn bib_entry_key_at(contents: &str, line: u32) -> Option<String> {
    let (line_start, line_end) = line_range(contents, line)?;
    bibliography_entry_spans(contents)
        .into_iter()
        .find(|(_, start, end)| line_end >= *start && line_start < *end)
        .map(|(key, _, _)| key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::history::history;
    use crate::project::test_support::Fixture;

    #[test]
    fn finds_a_bib_entry_span_by_key_case_insensitively() {
        let bib = "@misc{one, title = {A}}\n\n@inproceedings{Two, booktitle = {B}}\n";
        let (start, end) = bib_entry_span(bib, "TWO").unwrap();
        assert_eq!(&bib[start..end], "@inproceedings{Two, booktitle = {B}}");
        assert!(bib_entry_span(bib, "missing").is_none());
        // A nested brace in a value must not end the entry early.
        let nested = "@article{k, title = {Deep {Nets}}, year = {2020}}\n";
        let (s, e) = bib_entry_span(nested, "k").unwrap();
        assert_eq!(&nested[s..e], nested.trim_end());
    }

    #[test]
    fn finds_the_bib_line_and_the_key_governing_a_cursor_line() {
        let fixture = Fixture::project("bib-lines");
        fixture.write(
            "references.bib",
            "% a comment\n@article{smith2020,\n  title = {A},\n}\n@inproceedings{Jones2021,\n  booktitle = {B},\n}\n",
        );
        fixture.write(
            "main.bbl",
            "\\begin{thebibliography}{1}\n\\bibitem[Smith(2020)]{smith2020}\nJ. Smith. 2020.\n\\bibitem{JONES2021}\n\\bibitem{missing}\n",
        );
        // Text under a \bibitem (natbib's optional label form included) and the
        // \bibitem line itself resolve to its key; nothing before the first does.
        for (line, key) in [(3, Some("smith2020")), (4, Some("JONES2021")), (1, None)] {
            assert_eq!(bibitem_key_at(&fixture.read("main.bbl"), line).as_deref(), key, "{line}");
        }
        // Case-insensitive key match; a key with no .bib entry has no target.
        for (bbl_line, bib_line) in [(2, Some(2)), (4, Some(5)), (5, None)] {
            let target =
                bib_target_for_bbl(&fixture.root, Path::new("main.bbl"), bbl_line).unwrap();
            assert_eq!(target.map(|target| target.line), bib_line, "bbl line {bbl_line}");
        }

        let bib = "% a comment\n\
                   @article{smith2020,\n  title = {A},\n  year = {2020},\n}\n\n\
                   @inproceedings(\n  Jones2021,\n  title = \"Another paper\",\n)\n";
        for (line, key) in [(3, Some("smith2020")), (8, Some("Jones2021")), (6, None)] {
            assert_eq!(bib_entry_key_at(bib, line).as_deref(), key, "line {line}");
        }

        // Forward: a .bib cursor lands on the generated \bibitem of its entry.
        let forward = |line| {
            let bbl = Path::new("main.bbl");
            let target = bbl_target_for_bib(&fixture.root, Path::new("references.bib"), bbl, line);
            target.unwrap().map(|target| format!("{}:{}", target.path, target.line))
        };
        for (bib_line, bbl) in [(3, Some("main.bbl:2")), (6, Some("main.bbl:4")), (1, None)] {
            assert_eq!(forward(bib_line).as_deref(), bbl, "bib line {bib_line}");
        }
    }

    #[test]
    fn entries_are_parsed_from_every_bib_file_and_replaced_in_place() {
        let fixture = Fixture::project("bib-edit");
        let root = &fixture.root;
        fixture.write(
            "references.bib",
            "@misc{keep, title = {Keep Me}, year = {2019}}\n\n\
             @misc{vaswani2017, title = {Attention}, howpublished = {arXiv preprint arXiv:1706.03762}, year = {2017}}\n",
        );
        fixture.write(
            "extra.bib",
            "@article{attention,\n  title={Attention {Is} All You Need},\n  author={Vaswani, Ashish and Shazeer, Noam},\n  year={2017},\n  journal={NeurIPS}\n}\n@inproceedings{dosovitskiy2021image,\n}\n",
        );
        let found = citations(root).unwrap();
        let keys = found.iter().map(|citation| citation.key.as_str()).collect::<Vec<_>>();
        assert_eq!(keys, ["attention", "dosovitskiy2021image", "keep", "vaswani2017"]);
        let attention = &found[0];
        assert_eq!(
            [&attention.title, &attention.authors, &attention.year, &attention.venue],
            ["Attention Is All You Need", "Vaswani, Ashish and Shazeer, Noam", "2017", "NeurIPS"]
        );

        let entry = read_bib_entry(root, "vaswani2017").unwrap().unwrap();
        assert_eq!((entry.entry_type.as_str(), entry.title.as_str()), ("misc", "Attention"));
        assert!(read_bib_entry(root, "nope").unwrap().is_none());

        save_bib_entry(
            root,
            "vaswani2017",
            "@inproceedings{vaswani2017, title = {Attention Is All You Need}, booktitle = {NeurIPS}, year = {2017}}",
        )
        .unwrap();

        let updated = fixture.read("references.bib");
        assert!(!updated.contains("@misc{vaswani2017"));
        // The sibling entry is untouched.
        assert!(updated.contains("@misc{keep, title = {Keep Me}"));

        let reread = read_bib_entry(root, "vaswani2017").unwrap().unwrap();
        assert_eq!(
            (reread.entry_type.as_str(), reread.booktitle.as_str()),
            ("inproceedings", "NeurIPS")
        );
        let history = history(root).unwrap();
        assert_eq!((history[0].actor.as_str(), history[0].kind.as_str()), ("citation", "citation"));
    }
}
