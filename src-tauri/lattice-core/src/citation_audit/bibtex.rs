//! Reading and rebuilding one BibTeX entry's text. File-level span parsing
//! lives in `project`; these helpers work on a single entry.
use super::*;

/// arXiv's DataCite DOIs name the preprint, never a publication.
pub(super) const ARXIV_DOI_PREFIX: &str = "10.48550/";

/// Field values keyed by lowercase name, without their outer delimiters.
pub(crate) fn fields(entry: &str) -> BTreeMap<String, String> {
    entry
        .find(',')
        .map(|i| {
            let body = entry[i + 1..].trim_end();
            let body = body.strip_suffix('}').or_else(|| body.strip_suffix(')')).unwrap_or(body);
            project::parse_bibliography_fields_raw(body)
        })
        .unwrap_or_default()
}

/// A trimmed field value, or "" when absent.
pub(super) fn field_value(values: &BTreeMap<String, String>, name: &str) -> String {
    values.get(name).map(|v| clean(v)).unwrap_or_default()
}

// Preserve raw expressions (macros, concatenation, protected capitals) in
// untouched fields rather than converting every value to a braced literal.
pub(super) fn field_expressions(entry: &str) -> BTreeMap<String, String> {
    // Fetched BibTeX ends with a newline. Taking the last byte as the closing
    // delimiter kept the brace in the body, and the scanner then never flushed
    // the final field: imports lost `year`, refused the verified merge, and
    // stored bibcite's lossy record (ImageNet as CVPRW).
    let entry = entry.trim_end();
    let Some(body) = entry.find(',').and_then(|start| entry[start + 1..].strip_suffix(['}', ')']))
    else {
        return BTreeMap::new();
    };
    let mut fields = BTreeMap::new();
    let (mut depth, mut quoted, mut escaped, mut start) = (0i32, false, false, 0usize);
    for (i, byte) in body.bytes().chain(std::iter::once(b',')).enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' {
            escaped = true;
            continue;
        }
        // Braces nest inside a quoted value too; a `"` inside braces is a
        // literal, and a stray `}` inside quotes is text.
        if byte == b'"' && depth == 0 {
            quoted = !quoted;
        }
        if byte == b'{' {
            depth += 1;
        }
        if byte == b'}' && (depth > 0 || !quoted) {
            depth -= 1;
        }
        if !quoted && byte == b',' && depth == 0 {
            if let Some((name, value)) = body[start..i].split_once('=') {
                let name = name.trim().to_ascii_lowercase();
                if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                    fields.insert(name, value.trim().into());
                }
            }
            start = i + 1;
        }
    }
    fields
}

/// Rebuild an entry from field expressions, one field per line.
pub(super) fn render_entry(
    entry_type: &str, key: &str, expressions: BTreeMap<String, String>,
) -> String {
    let mut entry = format!("@{entry_type}{{{key},\n");
    for (name, value) in expressions {
        entry.push_str(&format!("  {name} = {value},\n"));
    }
    entry.push('}');
    entry
}

/// Add a field line before the entry's closing delimiter.
pub(super) fn append_field(entry: &str, field: &str) -> String {
    let mut body = entry.to_string();
    body.pop();
    format!("{},\n{field}\n}}", body.trim_end().trim_end_matches(','))
}

/// Each unescaped character with the brace depth after it. A backslash and
/// the character it escapes are skipped.
pub(super) fn brace_depths(text: &str) -> impl Iterator<Item = (usize, char, i32)> + '_ {
    let (mut depth, mut escaped) = (0, false);
    text.char_indices().filter_map(move |(index, character)| {
        if std::mem::take(&mut escaped) {
            return None;
        }
        match character {
            '\\' => {
                escaped = true;
                return None;
            }
            '{' => depth += 1,
            '}' => depth -= 1,
            _ => {}
        }
        Some((index, character, depth))
    })
}

pub(super) fn clean(value: &str) -> String {
    value.trim().to_string()
}

pub(super) fn normalize_text(value: &str) -> String {
    crate::util::collapse_whitespace(&value.to_lowercase())
}

pub(super) fn normalize_title(value: &str) -> String {
    normalize_text(value).replace(['{', '}'], "")
}

/// A DOI that can identify a publication: normalized, and not arXiv's.
pub(super) fn published_doi(value: &str) -> Option<String> {
    normalize_doi(value).filter(|doi| !doi.starts_with(ARXIV_DOI_PREFIX))
}

/// The entry's DOI: its `doi` field, else a DOI resolver link in `url`. Many
/// published records (COCO's ECCV chapter) carry the DOI only as that link.
pub(super) fn entry_doi(values: &BTreeMap<String, String>) -> Option<String> {
    ["doi", "url"].into_iter().find_map(|name| values.get(name).and_then(|v| normalize_doi(v)))
}

pub(super) fn unversioned_arxiv(id: &str) -> &str {
    id.rsplit_once('v')
        .filter(|(_, version)| !version.is_empty() && version.chars().all(|c| c.is_ascii_digit()))
        .map(|(id, _)| id)
        .unwrap_or(id)
}

pub(super) fn is_preprint_venue(venue: &str) -> bool {
    // Match markers as words, not substrings of journals such as Corrosion Science.
    venue
        .to_ascii_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .any(|word| matches!(word, "arxiv" | "preprint" | "corr" | "biorxiv" | "medrxiv"))
}

pub(super) fn entry_type(entry: &str) -> String {
    entry.trim_start_matches('@').split(['{', '(']).next().unwrap_or("").trim().to_lowercase()
}

/// What an entry says rather than how it is written: its type and field
/// values, whatever the field order, spacing, value delimiters or case of
/// field names. A reformat (bibcite's field sort, an editor's alignment)
/// keeps it, so Check references keeps that entry's result; a changed value
/// does not.
pub fn content_fingerprint(entry: &str) -> String {
    let mut canonical = entry_type(entry);
    for (name, value) in fields(entry) {
        canonical.push_str(&format!("\0{name}={}", crate::util::collapse_whitespace(&value)));
    }
    crate::util::sha256_hex(canonical.as_bytes())
}

/// The key of `text` when it is exactly one complete entry and nothing else.
pub(crate) fn single_entry_key(text: &str) -> Option<String> {
    let mut spans = project::bibliography_entry_spans(text);
    let whole =
        spans.len() == 1 && spans[0].1 == 0 && spans[0].2 == text.len() && complete_entry(text);
    whole.then(|| spans.remove(0).0)
}

pub(crate) fn complete_entry(entry: &str) -> bool {
    let Some(start) = entry.find(['{', '(']) else {
        return false;
    };
    let closing = if entry.as_bytes()[start] == b'{' { b'}' } else { b')' };
    project::entry_close(entry.as_bytes(), start + 1, closing)
        .is_some_and(|close| close + 1 == entry.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doi_normalization_and_entry_completeness_are_exact() {
        assert_eq!(normalize_doi("https://doi.org/10.1234/ABC"), Some("10.1234/abc".into()));
        assert_eq!(normalize_doi("arxiv:1"), None);
        assert!(!complete_entry("@article{a,title={Broken}"));
        assert!(complete_entry("@article{a,title={Complete}}"));
        // A `"` inside braces is a literal (issue #772); braces nest in quotes.
        let zotero = "@article{a,shorttitle={Review for \"{{X}} in {{Y}}},year={2024}}";
        assert!(complete_entry(zotero));
        assert!(!complete_entry(&format!("{zotero}\n@misc{{b,title={{B}}}}")));
        let quoted = "@misc{q,title=\"A {\"B, C\"} D\",year=2020}";
        assert!(complete_entry(quoted));
        assert_eq!(field_expressions(zotero)["year"], "{2024}");
        let expressions = field_expressions(quoted);
        assert_eq!(expressions["title"], "\"A {\"B, C\"} D\"");
        assert_eq!(expressions["year"], "2020");
    }

    /// bibcite's `remove` rewrote untouched entries this way; their checks
    /// must survive it, and only a changed value may invalidate one.
    #[test]
    fn content_fingerprint_ignores_formatting_but_not_values() {
        let written = "@InProceedings{he2016deep,\n  title={Deep Residual  Learning},\n  Year = 2016,\n  pages={770--778}\n}";
        let fingerprint = content_fingerprint(written);
        let reformatted = "@inproceedings{he2016deep,\n  pages         = {770--778},\n  title         = {Deep Residual Learning},\n  year          = {2016},\n}";
        assert_eq!(content_fingerprint(reformatted), fingerprint);
        for changed in [
            written.replace("2016,", "2017,"),
            written.replace("770--778", "770--779"),
            written.replace("  pages={770--778}\n", ""),
            written.replace("@InProceedings", "@article"),
            written.replace("{Deep Residual", "{{Deep} Residual"),
        ] {
            assert_ne!(content_fingerprint(&changed), fingerprint, "{changed}");
        }
    }

    #[test]
    fn preprint_markers_are_words_not_fragments_of_journal_names() {
        for (venue, preprint) in [
            ("CoRR abs/2401.12345", true),
            ("arXiv preprint arXiv:2401.12345", true),
            ("Corrosion Science", false),
            ("Corrosion Engineering, Science and Technology", false),
        ] {
            assert_eq!(is_preprint_venue(venue), preprint, "{venue}");
        }
    }
}
