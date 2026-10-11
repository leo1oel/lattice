//! Reference lists written by hand: a root document's `thebibliography`. A
//! proposal that cites through `\bibitem` text never reaches the `.bib`
//! files, so auditing those alone reported a clean result for references it
//! had not read.
//!
//! Each `\bibitem` is read into a BibTeX record (authors, title, venue, year
//! and any DOI, arXiv or ACL Anthology link) and checked by the same pipeline
//! as a `.bib` entry. The rows are review-only: the writer's prose is never
//! rewritten. Written lists abbreviate authors ("et al."), so the record the
//! item's own identifier names supplies the full list once the listed names
//! agree with it.
use super::*;
use regex::Regex;
use std::sync::LazyLock;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

/// One `\bibitem` of a root document's inline reference list.
pub(super) struct InlineReference {
    pub path: String,
    pub key: String,
    /// The item as written, for display.
    pub text: String,
    pub title: String,
    /// The item as a BibTeX record; the scan snapshot of the row.
    pub bibtex: String,
    authors: Vec<String>,
    /// The list ends in "et al." or "others".
    truncated: bool,
    venue: String,
    year: String,
    anthology: Option<String>,
}

/// The inline references of every root document, in document order.
pub(super) fn inline_references(root: &Path) -> Result<Vec<InlineReference>, String> {
    let manifest = project::read_manifest(root)?;
    let mut references = Vec::new();
    for document in manifest.root_documents {
        let Ok(path) = project::safe_path(root, &document.path) else {
            continue;
        };
        let Ok(source) = fs::read_to_string(path) else {
            continue;
        };
        references.extend(read_list(&document.path, &source));
    }
    Ok(references)
}

fn read_list(path: &str, source: &str) -> Vec<InlineReference> {
    let source = without_comments(source);
    let mut references = Vec::new();
    let mut rest = source.as_str();
    while let Some(start) = rest.find("\\begin{thebibliography}") {
        let list = &rest[start..];
        let end = list.find("\\end{thebibliography}").unwrap_or(list.len());
        let items = &list[..end];
        let starts = items.match_indices("\\bibitem").map(|(at, _)| at).collect::<Vec<_>>();
        for (index, at) in starts.iter().enumerate() {
            let item =
                &items[at + "\\bibitem".len()..starts.get(index + 1).copied().unwrap_or(end)];
            if let Some(reference) = read_item(path, item) {
                references.push(reference);
            }
        }
        rest = &list[end..];
    }
    references
}

/// The source with each line's unescaped `%` comment removed.
fn without_comments(source: &str) -> String {
    source
        .lines()
        .map(|line| {
            let mut escaped = false;
            let end = line
                .char_indices()
                .find(|(_, c)| {
                    let comment = *c == '%' && !escaped;
                    escaped = *c == '\\' && !escaped;
                    comment
                })
                .map_or(line.len(), |(at, _)| at);
            &line[..end]
        })
        .collect::<Vec<_>>()
        .join("\n")
}

static URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\(?:url|href)\s*\{([^}]*)\}").unwrap());
static BARE_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://[^\s}{,]+").unwrap());
static DOI_TEXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bdoi\s*:\s*(10\.\d{4,9}/[^\s,;}]+)").unwrap());
static ARXIV_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\d{4}\.\d{4,5}(?:v\d+)?").unwrap());
static YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(?:19|20)\d{2}\b").unwrap());
static EMPH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\(?:emph|textit|textsl)\s*\{([^}]*)\}").unwrap());

fn read_item(path: &str, item: &str) -> Option<InlineReference> {
    let mut rest = item.trim_start();
    if let Some(label) = rest.strip_prefix('[') {
        rest = label[label.find(']')? + 1..].trim_start();
    }
    let rest = rest.strip_prefix('{')?;
    let key = rest[..rest.find('}')?].trim().to_string();
    let body = rest[rest.find('}')? + 1..].trim().to_string();
    if key.is_empty() {
        return None;
    }
    let urls = URL
        .captures_iter(&body)
        .map(|found| found[1].trim().to_string())
        .chain(BARE_URL.find_iter(&URL.replace_all(&body, "")).map(|found| found.as_str().into()))
        .collect::<Vec<_>>();
    let doi = urls
        .iter()
        .find_map(|url| published_doi(url))
        .or_else(|| DOI_TEXT.captures(&body).and_then(|found| published_doi(&found[1])));
    let arxiv = project::bibliography_arxiv_id(&BTreeMap::from([
        ("url".to_string(), urls.join(" ")),
        ("note".to_string(), plain(&body)),
    ]));
    let anthology = urls.iter().find_map(|url| {
        let id = url.split_once("aclanthology.org/")?.1.trim_end_matches('/');
        let id = id.strip_suffix(".pdf").unwrap_or(id);
        (!id.is_empty() && !id.contains('/')).then(|| id.to_string())
    });
    let segments = segments(&URL.replace_all(&body, ""));
    let mut parts = segments.iter();
    let (authors, truncated) = parts.next().map(|text| author_list(text)).unwrap_or_default();
    let title = parts.next().map(|text| sentence(&plain(text))).unwrap_or_default();
    let details = parts.cloned().collect::<Vec<_>>().join(" ");
    let venue = details_venue(&details);
    let year = YEAR
        .find_iter(&ARXIV_ID.replace_all(&details, ""))
        .last()
        .map(|found| found.as_str().to_string())
        .unwrap_or_default();

    let mut values = BTreeMap::new();
    let mut add = |name: &str, value: &str| {
        if !value.is_empty() {
            values.insert(name.to_string(), format!("{{{value}}}"));
        }
    };
    let mut author = authors.join(" and ");
    if truncated && !author.is_empty() {
        author.push_str(" and others");
    }
    add("author", &author);
    add("title", &title);
    add("year", &year);
    add("url", urls.first().map(String::as_str).unwrap_or(""));
    add("doi", doi.as_deref().unwrap_or(""));
    if let Some(id) = &arxiv {
        add("eprint", id);
        add("archiveprefix", "arXiv");
    }
    let lower = venue.to_lowercase();
    let kind = if venue.is_empty() || is_preprint_venue(&venue) {
        add("howpublished", &venue);
        "misc"
    } else if lower.contains("journal") || lower.contains("transactions") {
        add("journal", &venue);
        "article"
    } else {
        add("booktitle", &venue);
        "inproceedings"
    };
    Some(InlineReference {
        path: path.to_string(),
        bibtex: render_entry(kind, &key, values),
        key,
        text: crate::util::collapse_whitespace(&body),
        title,
        authors,
        truncated,
        venue,
        year,
        anthology,
    })
}

/// An item's parts: authors, title, then publication details. Generated
/// lists separate them with `\newblock`; handwritten ones end each part with
/// a period, usually at the end of a line.
fn segments(body: &str) -> Vec<String> {
    if body.contains("\\newblock") {
        return body
            .split("\\newblock")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(Into::into)
            .collect();
    }
    let lines = body
        .split_inclusive('\n')
        .fold(vec![String::new()], |mut parts, line| {
            parts.last_mut().unwrap().push_str(line);
            if line.trim_end().ends_with('.') {
                parts.push(String::new());
            }
            parts
        })
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>();
    if lines.len() >= 3 {
        return lines;
    }
    // One paragraph: split at a period that ends a word, not an initial
    // ("A. Smith") or an abbreviation inside a word.
    let text = crate::util::collapse_whitespace(body);
    let mut parts = Vec::new();
    let mut start = 0;
    for (at, _) in text.match_indices(". ") {
        let word_start = text[..at].rfind([' ', ',', '-']).map_or(0, |i| i + 1);
        let word = &text[word_start..at];
        let initial = word.chars().count() == 1 && word.chars().all(char::is_uppercase);
        if !initial && at >= start {
            parts.push(text[start..=at].trim().to_string());
            start = at + 2;
        }
    }
    parts.push(text[start..].trim().to_string());
    parts.into_iter().filter(|part| !part.is_empty()).collect()
}

/// The listed authors as written, and whether the list is abbreviated.
fn author_list(text: &str) -> (Vec<String>, bool) {
    let text = sentence(&plain(text));
    let mut truncated = false;
    let mut text = text.as_str();
    for marker in ["et al.", "et al", "and others", "others"] {
        if let Some(head) = text.strip_suffix(marker) {
            truncated = true;
            text = head.trim_end().trim_end_matches(',').trim_end();
            break;
        }
    }
    let parts = text.split(" and ").map(str::trim).collect::<Vec<_>>();
    // "Liu, Haotian and Li, Chunyuan": BibTeX's family-first form.
    let names = if parts.len() > 1 && parts.iter().all(|part| part.matches(',').count() == 1) {
        parts.into_iter().map(str::to_string).collect()
    } else {
        text.split(',')
            .flat_map(|part| part.split(" and "))
            .map(|name| name.trim().trim_start_matches("and ").trim())
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .collect()
    };
    (names, truncated)
}

/// The venue named in an item's publication details.
fn details_venue(details: &str) -> String {
    if let Some(found) = EMPH.captures(details) {
        return sentence(&plain(&found[1]));
    }
    let text = plain(details);
    let text = text.trim().strip_prefix("In ").unwrap_or(text.trim());
    let venue = text.split(',').next().unwrap_or("");
    let venue = YEAR.replace_all(venue, "");
    sentence(venue.trim())
}

/// LaTeX markup reduced to the text it prints.
fn plain(text: &str) -> String {
    static COMMAND: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\\(?:[A-Za-z]+\*?|[^A-Za-z\s])").unwrap());
    let text = decode_accents(text)
        .replace("{}", "")
        .replace("\\&", "&")
        .replace("\\%", "%")
        .replace('~', " ");
    let text = COMMAND.replace_all(&text, "");
    crate::util::collapse_whitespace(&text.replace(['{', '}'], "")).nfc().collect()
}

/// A part without its closing period or surrounding quotes.
fn sentence(text: &str) -> String {
    text.trim()
        .trim_end_matches('.')
        .trim()
        .trim_start_matches("``")
        .trim_end_matches("''")
        .trim_matches('"')
        .trim()
        .to_string()
}

pub(super) fn check(
    root: &Path, request: AuditEntry, s2_batch_status: Option<&str>,
) -> Result<AuditResult, String> {
    let current = inline_references(root)?
        .into_iter()
        .find(|reference| reference.path == request.path && reference.key == request.key);
    let reference = match current {
        Some(reference) if reference.bibtex == request.bibtex => reference,
        Some(reference) => {
            let message = "The bibliography entry changed after the scan.";
            return Ok(result("conflict", message, reference.bibtex));
        }
        None => return Ok(result("conflict", "The bibliography entry no longer exists.", "")),
    };
    let before = reference.bibtex.clone();
    if reference.title.is_empty() || reference.authors.is_empty() {
        let message = "This inline reference could not be read as authors, title, and venue.";
        return Ok(result("skipped", message, before).because("missing_identity"));
    }
    let expanded = match identifier_record(&reference, s2_batch_status) {
        Ok(Some(record)) if names_agree(&reference, &record) => {
            with_record_authors(&before, &record)
        }
        Ok(Some(record)) => return Ok(identity_conflict(&before, &record)),
        Ok(None) if !reference.truncated => before.clone(),
        Ok(None) => {
            let message = "This inline reference abbreviates its authors, and no record of it was found to compare with.";
            return Ok(result("unavailable", message, before).because("no_match"));
        }
        Err(error) => {
            return Ok(result(
                "unavailable",
                &format!("Metadata check incomplete: {error}"),
                before,
            )
            .because("metadata_unavailable"))
        }
    };
    // No local cleanup: it would turn a failed lookup into an "update" that
    // only re-braces the record this module wrote.
    let mut checked = publication::refine(check::look_up(root, expanded.clone(), s2_batch_status)?);
    checked.before = before;
    if !checked.verified() && checked.after.is_none() {
        return Ok(checked);
    }
    // Compare what the writer wrote with the verified record. Fields the item
    // never states (pages, DOI, publisher) are not differences.
    let record = checked.after.take().unwrap_or(expanded);
    checked.changes = differences(&reference, &record);
    let preprint_published =
        is_preprint_venue(&reference.venue) && !is_preprint_venue(&record_venue(&record));
    if checked.verified() {
        checked.status = if checked.changes.is_empty() { "checked" } else { "update" }.into();
        checked.message = if checked.changes.is_empty() {
            "The inline reference agrees with the verified record."
        } else if preprint_published {
            "A published version of this preprint exists. Inline references are edited by hand."
        } else {
            "The verified record differs from this inline reference. Inline references are edited by hand."
        }
        .into();
    }
    checked.after = Some(record);
    Ok(checked)
}

/// The record the item's own identifier names: its ACL Anthology page, DOI or
/// arXiv ID, else the title's best match.
fn identifier_record(
    reference: &InlineReference, s2_batch_status: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(id) = &reference.anthology {
        if let Some(record) = publication::anthology_record(id)? {
            return Ok(Some(record));
        }
    }
    let values = fields(&reference.bibtex);
    if let Some(doi) = values.get("doi") {
        let output = run_bibcite(&["get", "--json", doi], Some(audit_command(s2_batch_status)?))?;
        return parse_get_output(&output).map(Some);
    }
    if let Some(id) = values.get("eprint") {
        return crate::papers::official_arxiv_citation(id);
    }
    let output =
        run_bibcite(&["get", &reference.title, "--json"], Some(audit_command(s2_batch_status)?))?;
    if is_clean_lookup_miss(&output) {
        return Ok(None);
    }
    parse_get_output(&output).map(Some)
}

/// Whether `record` is the work the item describes: the same title, and the
/// listed authors (all of them, unless the list is abbreviated) leading its
/// author list in order. Names compare by family name and first initial,
/// because a written list shortens given names ("Steven Hoi" for "Steven
/// C. H. Hoi").
fn names_agree(reference: &InlineReference, record: &str) -> bool {
    let values = fields(record);
    let title = field_value(&values, "title");
    let record_authors = people(&field_value(&values, "author"));
    same_title(&reference.title, &title)
        && !reference.authors.is_empty()
        && reference.authors.len() <= record_authors.len()
        && (reference.truncated || reference.authors.len() == record_authors.len())
        && reference.authors.iter().zip(&record_authors).all(|(a, b)| person(a) == *b)
}

fn same_title(a: &str, b: &str) -> bool {
    normalize_title(a) == normalize_title(b) || drops_short_name(a, b) || drops_short_name(b, a)
}

fn people(authors: &str) -> Vec<Option<(String, char)>> {
    // Exports wrap long author lists ("Li, Yifan  and\n      Du, Yifan").
    crate::util::collapse_whitespace(&authors.replace(['{', '}'], ""))
        .split(" and ")
        .map(str::trim)
        .filter(|name| !name.is_empty() && *name != "others")
        .map(person)
        .collect()
}

/// A name's family name and first initial, without accents or punctuation.
fn person(name: &str) -> Option<(String, char)> {
    let folded = decode_accents(&name.replace(['{', '}'], ""))
        .nfd()
        .filter(|c| !is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase();
    let (family, given) = match folded.split_once(',') {
        Some((family, given)) => (family.trim().to_string(), given.trim().to_string()),
        None => {
            let words = folded.split_whitespace().collect::<Vec<_>>();
            let (family, given) = words.split_last()?;
            (family.to_string(), given.join(" "))
        }
    };
    let family = family.chars().filter(|c| c.is_alphanumeric()).collect::<String>();
    let initial = given.chars().find(|c| c.is_alphanumeric())?;
    (!family.is_empty()).then_some((family, initial))
}

/// The item's record with the identifier record's full author list (and its
/// DOI, when the item had none).
fn with_record_authors(before: &str, record: &str) -> String {
    let remote = fields(record);
    let mut expressions = field_expressions(before);
    if let Some(author) = remote.get("author") {
        expressions.insert("author".into(), format!("{{{author}}}"));
    }
    if !expressions.contains_key("doi") {
        if let Some(doi) = remote.get("doi").and_then(|v| published_doi(v)) {
            expressions.insert("doi".into(), format!("{{{doi}}}"));
        }
    }
    let key = project::bibliography_entry_spans(before).first().map(|span| span.0.clone());
    render_entry(&entry_type(before), key.as_deref().unwrap_or("inline"), expressions)
}

fn record_venue(record: &str) -> String {
    let values = fields(record);
    ["journal", "booktitle", "howpublished"]
        .into_iter()
        .map(|name| field_value(&values, name))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

/// What the item states that the verified record contradicts.
fn differences(reference: &InlineReference, record: &str) -> Vec<FieldChange> {
    let values = fields(record);
    let mut changes = Vec::new();
    let mut differ = |field: &str, before: &str, after: String| {
        changes.push(FieldChange { field: field.into(), before: before.into(), after });
    };
    let title = field_value(&values, "title").replace(['{', '}'], "");
    if !title.is_empty() && !same_title(&reference.title, &title) {
        differ("title", &reference.title, title);
    }
    let record_authors = people(&field_value(&values, "author"));
    let listed = reference.authors.iter().map(|name| person(name)).collect::<Vec<_>>();
    let prefix = listed.len() <= record_authors.len()
        && listed.iter().zip(&record_authors).all(|(a, b)| a == b)
        && (reference.truncated || listed.len() == record_authors.len());
    if !record_authors.is_empty() && !prefix {
        let mut written = reference.authors.join(", ");
        if reference.truncated {
            written.push_str(", et al.");
        }
        differ(
            "author",
            &written,
            crate::util::collapse_whitespace(&field_value(&values, "author")),
        );
    }
    let year = field_value(&values, "year");
    if !year.is_empty() && !reference.year.is_empty() && year != reference.year {
        differ("year", &reference.year, year);
    }
    let venue = record_venue(record);
    if !venue.is_empty() && !venue_matches(&reference.venue, &venue) {
        differ("venue", &reference.venue, venue.replace(['{', '}'], ""));
    }
    changes
}

/// Whether a written venue label names `venue`: the same text, one of its
/// words or parenthesized acronyms ("ECCV" in "Computer Vision -- ECCV
/// 2014"), or the initials of its final words ("EMNLP" for "...Conference on
/// Empirical Methods in Natural Language Processing"). A workshop is never
/// its main conference, and a preprint label never names a publication.
fn venue_matches(label: &str, venue: &str) -> bool {
    let words = |text: &str| {
        text.replace(['{', '}'], "")
            .replace("\\&", "&")
            .to_lowercase()
            .split(|c: char| c.is_whitespace() || "(),:;/".contains(c))
            .map(|word| word.trim_matches('.').to_string())
            .filter(|word| !word.is_empty() && word != "-" && word != "--" && word != "–")
            .collect::<Vec<_>>()
    };
    let (label_words, venue_words) = (words(label), words(venue));
    if label_words.is_empty() {
        return is_preprint_venue(venue);
    }
    if is_preprint_venue(label) != is_preprint_venue(venue) {
        return false;
    }
    if is_preprint_venue(label) {
        return true;
    }
    let workshop = |words: &[String]| words.iter().any(|word| word.starts_with("workshop"));
    if workshop(&venue_words) && !workshop(&label_words) {
        return false;
    }
    if venue_words.windows(label_words.len()).any(|window| window == label_words.as_slice()) {
        return true;
    }
    let label = label_words.join(" ");
    if matches!(label.as_str(), "neurips" | "nips") {
        return venue.to_lowercase().contains("neural information processing systems");
    }
    // Initials of the venue's significant words, ignoring numbers and years.
    let initials = venue_words
        .iter()
        .filter(|word| {
            !matches!(word.as_str(), "of" | "on" | "in" | "and" | "the" | "for" | "&" | "at")
                && !word.chars().next().is_some_and(|c| c.is_ascii_digit())
        })
        .filter_map(|word| word.chars().next())
        .collect::<String>();
    label_words.len() == 1 && label.len() >= 3 && initials.ends_with(&label)
}
