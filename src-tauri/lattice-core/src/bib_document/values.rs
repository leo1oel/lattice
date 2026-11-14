//! Reading and writing a field's value: macros expanded, BibTeX's LaTeX as
//! the reader sees it, an entry's summary for a list, and a value written
//! back in the delimiters it had.

use std::{collections::HashMap, sync::LazyLock};

use regex::{Captures, Regex};

use super::{compose::compose, is_name, names, skip_gap, value_end, value_part_end, BibEntry};

/// BibTeX's predefined macros, which a bare value may name without an
/// `@string`.
const MONTHS: [&str; 12] =
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

fn is_month(name: &str) -> bool {
    MONTHS.contains(&name.to_lowercase().as_str())
}

fn is_number(part: &str) -> bool {
    !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
}

/// The `#`-joined parts of a raw value, each as written.
fn value_parts(raw: &str) -> Vec<&str> {
    let bytes = raw.as_bytes();
    let mut parts = Vec::new();
    let mut index = skip_gap(bytes, 0);
    while index < bytes.len() {
        let Some(end) = value_part_end(bytes, index, None) else {
            return vec![raw];
        };
        parts.push(&raw[index..end]);
        index = skip_gap(bytes, end);
        if bytes.get(index) != Some(&b'#') {
            break;
        }
        index = skip_gap(bytes, index + 1);
    }
    parts
}

/// A raw value with its delimiters gone and macros expanded, still LaTeX.
pub fn expand_value(raw: &str, macros: &HashMap<String, String>) -> String {
    expand_at(raw, macros, 0)
}

fn expand_at(raw: &str, macros: &HashMap<String, String>, depth: usize) -> String {
    value_parts(raw)
        .into_iter()
        .map(|part| {
            if part.starts_with('{') || part.starts_with('"') {
                return part[1..part.len().saturating_sub(1).max(1)].to_string();
            }
            if is_number(part) {
                return part.to_string();
            }
            match macros.get(&part.to_lowercase()) {
                Some(macro_value) if depth < 8 => expand_at(macro_value, macros, depth + 1),
                _ => part.to_string(),
            }
        })
        .collect()
}

/// `raw` as another file reads it without this one's `@string` macros: as
/// written when it is one braced or quoted value, a number or a month, and
/// otherwise expanded in braces.
pub fn self_contained_value(raw: &str, macros: &HashMap<String, String>) -> String {
    let parts = value_parts(raw);
    if let [part] = parts.as_slice() {
        if part.starts_with('{') || part.starts_with('"') || is_number(part) || is_month(part) {
            return raw.to_string();
        }
    }
    format!("{{{}}}", expand_value(raw, macros))
}

/// An accent command's combining mark.
fn accent_mark(accent: &str) -> Option<char> {
    Some(match accent {
        "\"" => '\u{0308}',
        "'" => '\u{0301}',
        "`" => '\u{0300}',
        "^" => '\u{0302}',
        "~" => '\u{0303}',
        "=" => '\u{0304}',
        "." => '\u{0307}',
        "u" => '\u{0306}',
        "v" => '\u{030C}',
        "H" => '\u{030B}',
        "c" => '\u{0327}',
        "k" => '\u{0328}',
        "r" => '\u{030A}',
        "d" => '\u{0323}',
        "b" => '\u{0331}',
        _ => return None,
    })
}

/// A letter-making command's letter (`\ss` is "ß", `\alpha` "α").
fn letter(name: &str) -> Option<&'static str> {
    Some(match name {
        "aa" => "å",
        "AA" => "Å",
        "ae" => "æ",
        "AE" => "Æ",
        "oe" => "œ",
        "OE" => "Œ",
        "o" => "ø",
        "O" => "Ø",
        "ss" => "ß",
        "l" => "ł",
        "L" => "Ł",
        "i" => "ı",
        "j" => "ȷ",
        "textendash" => "–",
        "textemdash" => "—",
        "ldots" | "dots" => "…",
        "textregistered" => "®",
        "copyright" => "©",
        "S" => "§",
        "P" => "¶",
        "alpha" => "α",
        "beta" => "β",
        "gamma" => "γ",
        "delta" => "δ",
        "epsilon" | "varepsilon" => "ε",
        "zeta" => "ζ",
        "eta" => "η",
        "theta" => "θ",
        "kappa" => "κ",
        "lambda" => "λ",
        "mu" => "μ",
        "nu" => "ν",
        "xi" => "ξ",
        "pi" => "π",
        "rho" => "ρ",
        "sigma" => "σ",
        "tau" => "τ",
        "phi" => "φ",
        "chi" => "χ",
        "psi" => "ψ",
        "omega" => "ω",
        "Gamma" => "Γ",
        "Delta" => "Δ",
        "Theta" => "Θ",
        "Lambda" => "Λ",
        "Pi" => "Π",
        "Sigma" => "Σ",
        "Phi" => "Φ",
        "Omega" => "Ω",
        "ell" => "ℓ",
        "infty" => "∞",
        "times" => "×",
        "pm" => "±",
        "leq" | "le" => "≤",
        "geq" | "ge" => "≥",
        "to" | "rightarrow" => "→",
        "cdot" => "·",
        _ => return None,
    })
}

fn accented(captures: &Captures) -> String {
    let base = captures
        .get(2)
        .or_else(|| captures.get(3))
        .map_or("", |found| found.as_str())
        .trim_start_matches('\\');
    let Some(mark) = accent_mark(&captures[1]) else {
        return captures[0].to_string();
    };
    let mut letters = base.chars();
    match (letters.next(), letters.next()) {
        (Some(first), None) => {
            compose(first, mark).map_or_else(|| format!("{first}{mark}"), String::from)
        }
        _ => format!("{base}{mark}"),
    }
}

/// BibTeX's LaTeX as the reader sees it: accents composed, groups and markup
/// commands dropped, dashes and quotes typeset.
pub fn bib_text_to_plain(value: &str) -> String {
    static SYMBOL_ACCENT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"\\(["'`^~=.])\s*(?:\{\s*(\\?[A-Za-z])\s*\}|(\\?[A-Za-z]))"#).unwrap()
    });
    static LETTER_ACCENT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\\([uvHckrdb])(?:\s*\{\s*(\\?[A-Za-z])\s*\}|\s+(\\?[A-Za-z]))").unwrap()
    });
    // `(?![A-Za-z])` in the original: a name runs to its last letter anyway.
    static COMMAND: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\\([A-Za-z]+)\s*(\{\s*\})?").unwrap());
    static ESCAPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\([&%$#_{}])").unwrap());
    static MARKUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\[A-Za-z]+\*?\s*").unwrap());
    static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
    let text = SYMBOL_ACCENT.replace_all(value, |captures: &Captures| accented(captures));
    let text = LETTER_ACCENT.replace_all(&text, |captures: &Captures| accented(captures));
    let text = COMMAND.replace_all(&text, |captures: &Captures| {
        letter(&captures[1]).map_or_else(|| captures[0].to_string(), str::to_string)
    });
    // An escaped character is kept as itself, and must survive the steps
    // that drop braces and markup: it is held as a private-use stand-in.
    let text = ESCAPE.replace_all(&text, |captures: &Captures| {
        let ch = captures[1].chars().next().unwrap_or(' ');
        char::from_u32(0xF0000 + ch as u32).map_or_else(String::new, String::from)
    });
    // \emph{x}, \textbf{x}, \url{x}: keep the argument.
    let text = MARKUP.replace_all(&text, "");
    let text: String = text
        .chars()
        .filter(|ch| !matches!(ch, '{' | '}' | '$'))
        .map(|ch| match ch as u32 {
            code @ 0xF0000..=0xF00FF => char::from_u32(code - 0xF0000).unwrap_or(ch),
            _ => ch,
        })
        .collect();
    let text = text
        .replace("---", "—")
        .replace("--", "–")
        .replace("``", "“")
        .replace("''", "”")
        .replace('~', " ");
    SPACES.replace_all(&text, " ").trim().to_string()
}

/// The entry's fields by lower-cased name, expanded but still LaTeX.
pub fn entry_values(
    source: &str, entry: &BibEntry, macros: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for field in &entry.fields {
        values
            .entry(field.name.to_lowercase())
            .or_insert_with(|| expand_value(&source[field.value_from..field.value_to], macros));
    }
    values
}

/// What a list shows of an entry, and what its filter reads.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BibSummary {
    pub title: String,
    /// "Ashish Vaswani, Noam Shazeer": people as they are read.
    pub authors: String,
    /// "Vaswani et al."
    pub short_authors: String,
    pub year: String,
    pub venue: String,
    pub doi: String,
    pub arxiv_id: String,
    pub url: String,
    /// Lower-cased key, title, authors (as written too), venue, year, type,
    /// DOI and arXiv id, for a filter.
    pub haystack: String,
}

static EXPLICIT_ARXIV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:arxiv:\s*|https?://(?:www\.|export\.)?arxiv\.org/(?:abs|pdf|html)/)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?/\d{7}(?:v\d+)?)(?:\.pdf)?(?:[?#].*)?$").unwrap()
});

/// An arXiv id given on its own (or as an arXiv URL), lower-case and
/// without its version.
fn explicit_arxiv_id(input: &str) -> Option<String> {
    let id = EXPLICIT_ARXIV.captures(input.trim())?.get(1)?.as_str().to_lowercase();
    let base = match id.rsplit_once('v') {
        Some((base, version))
            if !base.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            base.to_string()
        }
        _ => id,
    };
    Some(base)
}

pub fn summarize_entry(
    source: &str, entry: &BibEntry, macros: &HashMap<String, String>,
) -> BibSummary {
    static IDENTIFIER_ESCAPE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\\([_%&#])").unwrap());
    static DOI_URL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^https?://(?:dx\.)?doi\.org/").unwrap());
    static ARXIV_NOTE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)arxiv[:\s]+(\d{4}\.\d{4,5})").unwrap());
    static NEW_STYLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}\.\d{4,5}").unwrap());
    let values = entry_values(source, entry, macros);
    let get = |name: &str| values.get(name).map(String::as_str).unwrap_or("");
    let plain = |name: &str| bib_text_to_plain(get(name));
    // Identifiers keep their dashes and underscores: only grouping and
    // escapes go.
    let literal = |name: &str| {
        IDENTIFIER_ESCAPE.replace_all(get(name), "$1").replace(['{', '}'], "").trim().to_string()
    };
    let raw_authors =
        values.get("author").or_else(|| values.get("editor")).cloned().unwrap_or_default();
    let authors = names::author_names(&raw_authors).join(", ");
    let short_authors = names::short_authors(&raw_authors).unwrap_or_default();
    let year = match plain("year") {
        year if !year.is_empty() => year,
        _ => get("date").chars().take(4).collect(),
    };
    let doi = DOI_URL.replace(&literal("doi"), "").into_owned();
    let eprint = literal("eprint");
    let archive = format!("{} {}", literal("archiveprefix"), literal("eprinttype")).to_lowercase();
    let url = literal("url");
    let arxiv_id = (archive.contains("arxiv") || NEW_STYLE.is_match(&eprint))
        .then(|| explicit_arxiv_id(&eprint))
        .flatten()
        .or_else(|| (!url.is_empty()).then(|| explicit_arxiv_id(&url)).flatten())
        .or_else(|| {
            ARXIV_NOTE
                .captures(&format!("{} {}", plain("journal"), plain("note")))
                .map(|found| found[1].to_string())
        })
        .unwrap_or_default();
    let venue = [
        "journal",
        "journaltitle",
        "booktitle",
        "publisher",
        "school",
        "institution",
        "organization",
        "howpublished",
    ]
    .iter()
    .map(|name| plain(name))
    .find(|venue| !venue.is_empty())
    .unwrap_or_else(|| if arxiv_id.is_empty() { String::new() } else { "arXiv".into() });
    let title = plain("title");
    let haystack = format!(
        "{}\n{title}\n{authors}\n{}\n{venue}\n{year}\n{}\n{doi}\n{arxiv_id}",
        entry.key,
        bib_text_to_plain(&raw_authors),
        entry.kind
    )
    .to_lowercase();
    BibSummary { title, authors, short_authors, year, venue, doi, arxiv_id, url, haystack }
}

/// How a field's value is written, so an edit keeps the writer's delimiters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BibValueStyle {
    Brace,
    Quote,
    Bare,
    /// A `#` concatenation, edited as written.
    Raw,
}

/// A field value as a form edits it: the text between its delimiters, or the
/// whole expression for a concatenation.
pub fn editable_value(raw: &str) -> (String, BibValueStyle) {
    let parts = value_parts(raw);
    let [part] = parts.as_slice() else {
        return (raw.to_string(), BibValueStyle::Raw);
    };
    if *part != raw.trim() {
        return (raw.to_string(), BibValueStyle::Raw);
    }
    if part.starts_with('{') && part.len() >= 2 {
        (part[1..part.len() - 1].to_string(), BibValueStyle::Brace)
    } else if part.starts_with('"') && part.len() >= 2 {
        (part[1..part.len() - 1].to_string(), BibValueStyle::Quote)
    } else {
        (part.to_string(), BibValueStyle::Bare)
    }
}

/// Braces nest and close in order, as BibTeX needs them to.
pub fn balanced_braces(text: &str) -> bool {
    let mut depth = 0i32;
    for ch in text.chars() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0
}

fn has_top_level_quote(text: &str) -> bool {
    let mut depth = 0i32;
    for ch in text.chars() {
        match ch {
            '{' => depth += 1,
            '}' => depth -= 1,
            '"' if depth == 0 => return true,
            _ => {}
        }
    }
    false
}

/// The raw value for `text` in `style`, or `None` when no delimiters can
/// hold it (unbalanced braces, or a raw expression that does not parse).
pub fn encode_value(
    text: &str, style: BibValueStyle, macros: &HashMap<String, String>,
) -> Option<String> {
    if style == BibValueStyle::Raw {
        let value = text.trim();
        return (!value.is_empty() && value_end(value.as_bytes(), 0, None) == Some(value.len()))
            .then(|| value.to_string());
    }
    if !balanced_braces(text) {
        return None;
    }
    if style == BibValueStyle::Bare
        && (is_number(text) || macros.contains_key(&text.to_lowercase()) || is_month(text))
        && text.bytes().all(is_name)
    {
        return Some(text.to_string());
    }
    if style == BibValueStyle::Quote && !has_top_level_quote(text) {
        return Some(format!("\"{text}\""));
    }
    Some(format!("{{{text}}}"))
}

/// A citation key BibTeX and `\cite` both accept.
pub fn valid_citation_key(key: &str) -> bool {
    !key.is_empty() && key.chars().all(|ch| !ch.is_whitespace() && !"\"#%'(),={}\\~".contains(ch))
}

#[cfg(test)]
mod tests {
    use super::super::parse;
    use super::*;

    #[test]
    fn values_expand_their_macros_and_parts() {
        let macros = HashMap::from([("nips".to_string(), "\"NeurIPS\"".to_string())]);
        assert_eq!(expand_value("nips # { 30}", &macros), "NeurIPS 30");
        assert_eq!(expand_value("{A {B} c}", &macros), "A {B} c");
        assert_eq!(self_contained_value("nips", &macros), "{NeurIPS}");
        assert_eq!(self_contained_value("jan", &macros), "jan");
        assert_eq!(self_contained_value("{x}", &macros), "{x}");
    }

    #[test]
    fn latex_reads_as_plain_text() {
        assert_eq!(bib_text_to_plain(r#"G{\"o}del and \c{c}a \v s"#), "Gödel and ça š");
        assert_eq!(
            bib_text_to_plain(r"\emph{Deep} learning --- a {GPU} \& \ss"),
            "Deep learning — a GPU & ß"
        );
        assert_eq!(bib_text_to_plain(r"``Quoted'' 1--2 $\alpha$"), "“Quoted” 1–2 α");
        assert_eq!(bib_text_to_plain(r"50\% \_x\_"), "50% _x_");
    }

    #[test]
    fn an_entry_summarizes_as_a_list_shows_it() {
        let source = "@inproceedings{v17,\n  title = {Attention Is {All} You Need},\n  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},\n  booktitle = {NeurIPS},\n  year = 2017,\n  eprint = {1706.03762v5},\n  archivePrefix = {arXiv},\n  doi = {https://doi.org/10.5555/x\\_y}\n}";
        let document = parse(source).unwrap();
        let summary = summarize_entry(source, &document.entries[0], &document.macros);
        assert_eq!(summary.title, "Attention Is All You Need");
        assert_eq!(summary.authors, "Ashish Vaswani, Noam Shazeer, Niki Parmar");
        assert_eq!(summary.short_authors, "Vaswani et al.");
        assert_eq!(summary.year, "2017");
        assert_eq!(summary.venue, "NeurIPS");
        assert_eq!(summary.arxiv_id, "1706.03762");
        assert_eq!(summary.doi, "10.5555/x_y");
        assert!(summary.haystack.contains("v17"));
    }

    #[test]
    fn a_value_is_written_back_in_its_delimiters() {
        let macros = HashMap::new();
        assert_eq!(editable_value("{Title}"), ("Title".to_string(), BibValueStyle::Brace));
        assert_eq!(editable_value("\"x\""), ("x".to_string(), BibValueStyle::Quote));
        assert_eq!(editable_value("2017"), ("2017".to_string(), BibValueStyle::Bare));
        assert_eq!(editable_value("a # {b}").1, BibValueStyle::Raw);
        assert_eq!(encode_value("New", BibValueStyle::Brace, &macros).as_deref(), Some("{New}"));
        assert_eq!(encode_value("a\"b", BibValueStyle::Quote, &macros).as_deref(), Some("{a\"b}"));
        assert_eq!(encode_value("2018", BibValueStyle::Bare, &macros).as_deref(), Some("2018"));
        assert_eq!(
            encode_value("two words", BibValueStyle::Bare, &macros).as_deref(),
            Some("{two words}")
        );
        assert_eq!(encode_value("{open", BibValueStyle::Brace, &macros), None);
        assert_eq!(
            encode_value("a # {b}", BibValueStyle::Raw, &macros).as_deref(),
            Some("a # {b}")
        );
        assert!(valid_citation_key("vaswani2017:attn"));
        assert!(!valid_citation_key("has space"));
    }
}
