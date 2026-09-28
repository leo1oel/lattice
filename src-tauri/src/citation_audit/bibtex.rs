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
    let Some(start) = entry.find(',') else {
        return BTreeMap::new();
    };
    let body = &entry[start + 1..entry.len() - 1];
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
        if byte == b'"' && depth == 0 {
            quoted = !quoted;
        }
        if !quoted {
            if byte == b'{' {
                depth += 1;
            }
            if byte == b'}' {
                depth -= 1;
            }
            if byte == b',' && depth == 0 {
                if let Some((name, value)) = body[start..i].split_once('=') {
                    let name = name.trim().to_ascii_lowercase();
                    if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                        fields.insert(name, value.trim().into());
                    }
                }
                start = i + 1;
            }
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
    let opening = entry.as_bytes()[start];
    let closing = if opening == b'{' { b'}' } else { b')' };
    let mut depth = 0i32;
    let mut quoted = false;
    let mut escaped = false;
    for (i, byte) in entry.bytes().enumerate().skip(start) {
        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' {
            escaped = true;
            continue;
        }
        if byte == b'"' {
            quoted = !quoted;
        }
        if !quoted {
            if byte == opening {
                depth += 1;
            }
            if byte == closing {
                depth -= 1;
                if depth == 0 {
                    return i + 1 == entry.len();
                }
            }
        }
    }
    false
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
