//! chemnum compound-key completion, as the Tauri app's `compoundCompletions`
//! (`latex-completions.ts`): in `\cmpd{`, `\cmpd*{`, `\refcmpd{` or
//! `\labelcmpd{` (after the last comma) the project's compound keys, and in
//! `\rcmpd{` the same for a drawing's mark. Each shows the number the last
//! build gave it ("ketone — 1"), numbered keys first in number order, then
//! the rest by key, and the place it is drawn ("Scheme 1: …") as its detail.
//! A key only a drawing can cite (`A:…`, `I:…`, or `key.sub.num`) picked in
//! `\cmpd{` turns the command into `\rcmpd{`. Unlike the Tauri source, the
//! key being typed is not listed as a key of its own.
//!
//! The keys are the open buffer's and those the host read of the project's
//! TeX files, with the numbers and places of the last build
//! ([`CompoundFacts`], filled by `lattice-gpui`'s `editor_panel/index_lint.rs`).

use std::{cmp::Ordering, collections::HashMap, sync::LazyLock};

use gpui::App;
use regex::Regex;

use super::{
    completions::{locale_order, match_rank},
    compounds::{compound_keys_on_line, is_safe_key, numbered_key},
    project_completions::Facts,
};
use crate::completion::{
    CompletionItem, CompletionKind, CompletionList, CompletionQuery, CompletionSource,
};

/// How many keys a project lists.
const MAX_KEYS: usize = 5000;
/// How many of a project's `.tex` files a compound list reads.
const MAX_SOURCES: usize = 300;
/// A longer `.tex` file is not a source anyone writes compounds in by hand.
const MAX_SOURCE_BYTES: usize = 2_000_000;

static OPEN_COMPOUND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(?:cmpd\*?|refcmpd|labelcmpd)(?:\[[^\]\[{}]*\])?\{([^}]*)$")
        .expect("the compound slot pattern compiles")
});
static OPEN_MARK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\rcmpd\{([^}]*)$").expect("the mark slot pattern compiles"));

/// What the project's files hold of chemnum, besides the open buffer.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CompoundFacts {
    /// The keys the project's TeX files name, in order of first appearance.
    pub keys: Vec<String>,
    /// What the last build numbered each key.
    pub numbers: HashMap<String, String>,
    /// Each drawn key's place line.
    pub place_lines: HashMap<String, String>,
}

/// What the project's TeX files (`tex_paths`, project-relative, at most
/// 300 of them) and the last build hold of chemnum (`readCompoundProject`):
/// the keys they name, the numbers the build's `.aux` gave them, and each
/// drawn key's place line, numbered from `labels` (the build's, `None`
/// before one). Read from disk; call it off the main thread.
pub fn read_compound_facts(
    root: &std::path::Path,
    tex_paths: &[String],
    build: Option<&super::compiled_labels::CompiledBuild>,
    labels: Option<&HashMap<String, super::compiled_labels::CompiledLabel>>,
) -> CompoundFacts {
    let sources: Vec<(String, String)> = tex_paths
        .iter()
        .take(MAX_SOURCES)
        .map(|path| {
            let text = lattice_core::project::read_file(root, path)
                .ok()
                .filter(|text| text.len() <= MAX_SOURCE_BYTES)
                .unwrap_or_default();
            (path.clone(), text)
        })
        .collect();
    let numbers = build
        .map(|build| {
            super::compounds::read_compound_numbers(root, &build.root_document, &build.aux_folder)
                .numbers
        })
        .unwrap_or_default();
    let place_lines = super::compound_places::compound_places(&sources)
        .into_iter()
        .map(|(key, place)| {
            let line = super::compound_places::place_line(&place, labels, &numbers);
            (key, line)
        })
        .collect();
    CompoundFacts {
        keys: compound_keys_in(sources.iter().map(|(_, text)| text.as_str())),
        numbers,
        place_lines,
    }
}

/// Every distinct compound key `sources` name, in order (`compoundKeysIn`).
pub fn compound_keys_in<'a>(sources: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut keys = Vec::new();
    for source in sources {
        for key in source.lines().flat_map(compound_keys_on_line) {
            if keys.len() >= MAX_KEYS {
                return keys;
            }
            if seen.insert(key.clone()) {
                keys.push(key);
            }
        }
    }
    keys
}

/// The keys the open buffer's `text` names, then the other files' `keys`
/// it does not, at most [`MAX_KEYS`].
pub fn merged_keys(text: &str, keys: &[String]) -> Vec<String> {
    let mut merged = compound_keys_in([text]);
    let mut seen: std::collections::HashSet<String> = merged.iter().cloned().collect();
    for key in keys {
        if merged.len() >= MAX_KEYS {
            break;
        }
        if seen.insert(key.clone()) {
            merged.push(key.clone());
        }
    }
    merged
}

/// `Intl.Collator("en", { numeric: true })`'s order for keys and numbers:
/// runs of digits by their value, the rest as `localeCompare` orders it.
pub fn natural_order(a: &str, b: &str) -> Ordering {
    fn runs(text: &str) -> Vec<(bool, &str)> {
        let mut runs = Vec::new();
        let mut start = 0;
        let mut digits = None;
        for (at, ch) in text.char_indices() {
            let digit = ch.is_ascii_digit();
            if digits.is_some_and(|was| was != digit) {
                runs.push((digits.unwrap_or(false), &text[start..at]));
                start = at;
            }
            digits = Some(digit);
        }
        if start < text.len() {
            runs.push((digits.unwrap_or(false), &text[start..]));
        }
        runs
    }
    let (left, right) = (runs(a), runs(b));
    for (x, y) in left.iter().zip(&right) {
        let order = if x.0 && y.0 {
            let (x, y) = (x.1.trim_start_matches('0'), y.1.trim_start_matches('0'));
            x.len().cmp(&y.len()).then_with(|| x.cmp(y))
        } else {
            locale_order(x.1, y.1)
        };
        if order != Ordering::Equal {
            return order;
        }
    }
    left.len().cmp(&right.len())
}

/// The keys and numbers as the list shows them (`compoundEntries`): every
/// key, and every key the build numbered, but not `key.sub` when the
/// sources write it `key.sub.num`; numbered first, by number.
pub fn compound_entries(
    keys: &[String],
    numbers: &HashMap<String, String>,
) -> Vec<(String, Option<String>)> {
    let styled_suffix = |key: &str| numbered_key(key) != key;
    let hidden: std::collections::HashSet<&str> = keys
        .iter()
        .filter(|key| styled_suffix(key))
        .map(|key| numbered_key(key))
        .collect();
    let mut numbered: Vec<&String> = numbers.keys().collect();
    numbered.sort();
    let mut seen = std::collections::HashSet::new();
    let mut entries: Vec<(String, Option<String>)> = keys
        .iter()
        .chain(numbered)
        .filter(|key| seen.insert(key.as_str()))
        .filter(|key| is_safe_key(key) && !hidden.contains(key.as_str()))
        .take(MAX_KEYS)
        .map(|key| (key.clone(), numbers.get(numbered_key(key)).cloned()))
        .collect();
    entries.sort_by(|a, b| match (&a.1, &b.1) {
        (Some(x), Some(y)) => natural_order(x, y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => natural_order(&a.0, &b.0),
    });
    entries
}

/// A key a drawing's mark cites with `\rcmpd` (`MARK_ONLY`).
fn mark_only(key: &str) -> bool {
    let bytes = key.as_bytes();
    let series =
        bytes.len() >= 2 && matches!(bytes[0], b'A' | b'a' | b'I' | b'i') && bytes[1] == b':';
    let parts: Vec<&str> = key.split('.').collect();
    let styled = matches!(parts[..], [head, sub, "num" | "dash" | "letter"] if !head.is_empty() && !sub.is_empty());
    series || styled
}

/// The options for `query` typed in a compound slot: `mark` when it is
/// `\rcmpd{`'s, `rewrite` when the slot is a bare `\cmpd{` whose command a
/// mark-only key turns into `\rcmpd{` (the list's range then starts at its
/// `\`, and every option writes its command again).
pub fn compound_items(
    entries: Vec<(String, Option<String>)>,
    place_lines: &HashMap<String, String>,
    query: &str,
    mark: bool,
    rewrite: bool,
) -> Vec<CompletionItem> {
    let mut ranked: Vec<(u8, usize, String, Option<String>)> = entries
        .into_iter()
        .enumerate()
        .filter_map(|(index, (key, number))| {
            match_rank(&key, query).map(|rank| (rank, index, key, number))
        })
        .collect();
    ranked.sort_by_key(|(rank, index, ..)| (*rank, *index));
    ranked
        .into_iter()
        .map(|(_, _, key, number)| {
            let needs_mark = !mark && mark_only(&key);
            let insert = match (rewrite, needs_mark) {
                (true, true) => format!("\\rcmpd{{{key}"),
                (true, false) => format!("\\cmpd{{{key}"),
                (false, _) => key.clone(),
            };
            CompletionItem {
                label: match &number {
                    Some(number) => format!("{key} — {number}").into(),
                    None => key.clone().into(),
                },
                insert,
                caret: None,
                detail: place_lines.get(&key).map(|line| line.clone().into()),
                kind: CompletionKind::Label,
                reopen: false,
            }
        })
        .collect()
}

/// The project's compound keys in chemnum's commands.
pub struct CompoundSource {
    pub facts: Facts,
}

impl CompletionSource for CompoundSource {
    fn complete(&self, query: &CompletionQuery, _: &App) -> Option<CompletionList> {
        let (content, mark) = match OPEN_MARK.captures(query.before) {
            Some(found) => (found.get(1)?.as_str(), true),
            None => (
                OPEN_COMPOUND.captures(query.before)?.get(1)?.as_str(),
                false,
            ),
        };
        let typed = if mark {
            content
        } else {
            content[content.rfind(',').map_or(0, |at| at + 1)..].trim_start()
        };
        let from = query.offset - typed.len();
        let rewrite =
            !mark && query.before[..query.before.len() - typed.len()].ends_with("\\cmpd{");
        let facts = self.facts.borrow();
        let compounds = &facts.compounds;
        let text = query.text.text();
        // The key being typed is no key yet: the buffer is read without it,
        // so a half-typed `alc` does not list itself above `alcohol`.
        let typed_start = query.before_start() + (query.before.len() - typed.len());
        let without_typed = format!("{}{}", &text[..typed_start], &text[query.offset..]);
        let keys = merged_keys(&without_typed, &compounds.keys);
        let items = compound_items(
            compound_entries(&keys, &compounds.numbers),
            &compounds.place_lines,
            typed,
            mark,
            rewrite,
        );
        Some(CompletionList {
            range: if rewrite {
                from - "\\cmpd{".len()
            } else {
                from
            }..query.offset,
            items,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numbers(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, number)| (key.to_string(), number.to_string()))
            .collect()
    }

    /// `compoundEntries` in compound-keys.ts: numbered keys first in the
    /// numbers' natural order (2 before 10), then the others by key; a key
    /// only the build knows is listed too, and `key.sub` hides behind the
    /// `key.sub.num` the sources write.
    #[test]
    fn entries_list_numbered_keys_first_in_number_order() {
        let keys: Vec<String> = ["zeta", "ketone", "alcohol.a.num", "acid", "x\\bad"]
            .iter()
            .map(|key| key.to_string())
            .collect();
        let entries = compound_entries(
            &keys,
            &numbers(&[
                ("ketone", "10"),
                ("acid", "2"),
                ("alcohol.a", "3a"),
                ("ester", "1"),
            ]),
        );
        assert_eq!(
            entries,
            vec![
                ("ester".to_string(), Some("1".to_string())),
                ("acid".to_string(), Some("2".to_string())),
                ("alcohol.a.num".to_string(), Some("3a".to_string())),
                ("ketone".to_string(), Some("10".to_string())),
                ("zeta".to_string(), None),
            ]
        );
    }

    #[test]
    fn keys_come_from_every_source_in_order_of_first_use() {
        let keys = compound_keys_in([
            "\\cmpd{b,a} % \\cmpd{hidden}\n\\rcmpd{m.x.num}",
            "\\refcmpd{a}\\labelcmpd[x]{c}",
        ]);
        assert_eq!(keys, ["b", "a", "m.x.num", "c"]);
    }

    /// The menu's rows: "key — number", the place line as detail, matched
    /// on the typed key; a mark-only key picked in a bare `\cmpd{` writes
    /// `\rcmpd{` (`markApply`), while in `\rcmpd{` it is the key alone.
    #[test]
    fn items_show_numbers_and_turn_a_mark_into_rcmpd() {
        let entries = vec![
            ("ketone".to_string(), Some("1".to_string())),
            ("A:arrow".to_string(), None),
            ("alcohol.a.num".to_string(), Some("2a".to_string())),
        ];
        let places = HashMap::from([("ketone".to_string(), "Scheme 1: Reduction".to_string())]);
        let items = compound_items(entries.clone(), &places, "", false, true);
        assert_eq!(items[0].label.as_ref(), "ketone — 1");
        assert_eq!(items[0].insert, "\\cmpd{ketone");
        assert_eq!(items[0].detail.as_deref(), Some("Scheme 1: Reduction"));
        assert_eq!(items[1].insert, "\\rcmpd{A:arrow");
        assert_eq!(items[2].insert, "\\rcmpd{alcohol.a.num");
        let in_mark = compound_items(entries.clone(), &places, "alc", true, false);
        assert_eq!(in_mark.len(), 1);
        assert_eq!(in_mark[0].insert, "alcohol.a.num");
        // After a comma, or in \refcmpd{, the key alone.
        let plain = compound_items(entries, &places, "", false, false);
        assert_eq!(plain[1].insert, "A:arrow");
    }

    /// The other files' keys are keys, not TeX: they join the buffer's
    /// as they are, after them and without repeats.
    #[test]
    fn the_buffer_s_keys_come_before_the_other_files_keys() {
        let others = ["ketone".to_string(), "alc".to_string(), "acid".to_string()];
        assert_eq!(
            merged_keys("\\cmpd{alc} and \\cmpd{ester}", &others),
            ["alc", "ester", "ketone", "acid"]
        );
    }

    #[test]
    fn numbers_order_naturally() {
        let mut values = ["10", "2", "1b", "1a", "S3", "S12"];
        values.sort_by(|a, b| natural_order(a, b));
        assert_eq!(values, ["1a", "1b", "2", "10", "S3", "S12"]);
    }
}

#[cfg(test)]
mod read_tests {
    use super::*;

    /// A project's files read as the completion reads them, with no build:
    /// the keys every TeX file names, a drawn key's place by its file.
    #[test]
    fn a_project_s_keys_and_places_are_read_from_its_files() {
        let root = tempfile::tempdir().expect("a scratch folder");
        std::fs::create_dir_all(root.path().join("figs")).unwrap();
        std::fs::write(
            root.path().join("main.tex"),
            "See \\cmpd{ketone}.\n\\begin{scheme}\\input{figs/route}\\caption{Route}\\end{scheme}\n",
        )
        .unwrap();
        std::fs::write(
            root.path().join("figs/route.tex"),
            "% editable-figure source: route.cdxml\n\\rcmpd{alcohol.a.num}\n",
        )
        .unwrap();
        let facts = read_compound_facts(
            root.path(),
            &["main.tex".into(), "figs/route.tex".into()],
            None,
            None,
        );
        assert_eq!(facts.keys, ["ketone", "alcohol.a.num"]);
        assert_eq!(facts.place_lines["alcohol.a.num"], "Scheme · route");
    }
}
