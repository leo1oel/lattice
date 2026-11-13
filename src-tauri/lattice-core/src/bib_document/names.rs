//! A BibTeX author list as people (`src/papers/paper-identity.ts`):
//! "Vaswani, Ashish and Shazeer, Noam" reads "Ashish Vaswani", "Noam
//! Shazeer". Only an "and" outside braces separates two names, and one
//! outer brace group (`{Google Brain}`) is an organisation, never a person
//! named Brain. A trailing "and others" is kept as a flag.

use std::sync::LazyLock;

use regex::Regex;

struct Author {
    name: String,
    surname: String,
}

/// BibTeX braces protect case and grouping; neither belongs on screen.
fn unbrace(value: &str) -> String {
    value.replace(['{', '}'], "").split_whitespace().collect::<Vec<_>>().join(" ")
}

/// "{Gemini Team}": one outer brace group protects the whole name.
fn is_one_brace_group(value: &str) -> bool {
    if !value.starts_with('{') {
        return false;
    }
    let mut depth = 0i32;
    for (index, ch) in value.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => depth -= 1,
            _ => {}
        }
        if depth == 0 {
            return index + ch.len_utf8() == value.len();
        }
    }
    false
}

fn split_authors(authors: &str) -> Vec<&str> {
    static SEPARATOR: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)[{}]|\s+and\s+").unwrap());
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    for token in SEPARATOR.find_iter(authors) {
        match token.as_str() {
            "{" => depth += 1,
            "}" => depth = depth.saturating_sub(1),
            _ if depth == 0 => {
                parts.push(&authors[start..token.start()]);
                start = token.end();
            }
            _ => {}
        }
    }
    parts.push(&authors[start..]);
    parts
}

fn parse_authors(authors: &str) -> (Vec<Author>, bool) {
    let parts: Vec<&str> = split_authors(authors)
        .into_iter()
        .map(str::trim)
        .filter(|part| !unbrace(part).is_empty())
        .collect();
    let others = parts.last().is_some_and(|last| unbrace(last).to_lowercase() == "others");
    let people = parts[..parts.len() - usize::from(others)]
        .iter()
        .map(|raw| {
            let part = unbrace(raw);
            if is_one_brace_group(raw) {
                return Author { name: part.clone(), surname: part };
            }
            // "von Last, Jr, First" and "Last, First": the surname leads; a
            // plain "First Last" (or a single CJK name) ends with it.
            let pieces: Vec<&str> =
                part.split(',').map(str::trim).filter(|piece| !piece.is_empty()).collect();
            if let [last, .., first] = pieces.as_slice() {
                return Author { name: format!("{first} {last}"), surname: last.to_string() };
            }
            let surname = part.rsplit(' ').next().unwrap_or(&part).to_string();
            Author { name: part, surname }
        })
        .collect();
    (people, others)
}

/// Every author's name in reading order; empty when the list has none.
pub fn author_names(authors: &str) -> Vec<String> {
    parse_authors(authors).0.into_iter().map(|author| author.name).collect()
}

/// "Vaswani", "Vaswani and Shazeer" or "Vaswani et al."; `None` without
/// authors.
pub fn short_authors(authors: &str) -> Option<String> {
    let (people, others) = parse_authors(authors);
    let first = people.first()?;
    if people.len() > 2 || others {
        return Some(format!("{} et al.", first.surname));
    }
    Some(match people.get(1) {
        Some(second) => format!("{} and {}", first.surname, second.surname),
        None => first.surname.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authors_read_as_people() {
        let list = "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki";
        assert_eq!(short_authors(list).as_deref(), Some("Vaswani et al."));
        assert_eq!(author_names(list)[0], "Ashish Vaswani");
        assert_eq!(
            short_authors("Ashish Vaswani and Noam Shazeer").as_deref(),
            Some("Vaswani and Shazeer")
        );
        assert_eq!(
            short_authors("{Research and Development Institute}").as_deref(),
            Some("Research and Development Institute")
        );
        assert_eq!(short_authors("Doe, Jane and others").as_deref(), Some("Doe et al."));
        assert_eq!(short_authors(""), None);
    }
}
