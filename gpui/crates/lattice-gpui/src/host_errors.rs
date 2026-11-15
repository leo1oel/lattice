//! Host errors in the interface language, as the Tauri app's
//! `hostErrorText` (`src/platform/host-error-text.ts`) shows them.
//!
//! lattice-core fails with English prose (`Result<_, String>`), and that
//! English stays the error's identity: the log and a notice's Copy keep it,
//! so a report is searched by the words the code wrote. Only what a person
//! reads on screen is translated, where it is drawn: the notice stack passes
//! a notice's title and detail through [`text`].
//!
//! A translation is keyed by the Rust text itself, the `format!` literal with
//! its `{…}` placeholders standing for the parts that vary, so the catalog
//! reads as a list of the host's own sentences. The list is the Tauri app's
//! (`host-errors-*.ts`), written into [`catalog`] by
//! `node scripts/gpui-host-errors.mjs`, and each entry's words are the Lingui
//! message both apps read from `messages.po`. Text no entry matches is shown
//! as it is; so is everything in an English interface.
//!
//! Matching is the Tauri app's: a literal is an anchored pattern capturing
//! each argument (the last, when nothing follows it, takes the rest of the
//! text; the others stop at the first place the fixed text after them fits;
//! any may be empty), the entry with the most fixed text wins, an argument is
//! often another host message and is translated in turn, a few levels deep,
//! and a detail of several lines is matched a line at a time.

// Written by the generator, as it writes it.
#[rustfmt::skip]
mod catalog;

use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

use lattice_i18n::fill_named;
use regex::Regex;

/// One host message: the file under `src-tauri/src` or
/// `src-tauri/lattice-core/src` that writes it, its Rust literal, and its
/// words in the interface language.
pub(crate) struct Entry {
    #[allow(dead_code)]
    pub file: &'static str,
    pub literal: &'static str,
    pub text: Text,
}

/// What an entry says.
pub(crate) enum Text {
    /// A catalog message by its id, and where each of its placeholders'
    /// values comes from.
    Message(&'static str, &'static [(&'static str, Arg)]),
    /// The first when the argument at this place is not empty, else the
    /// second (a startup failure with or without its log).
    IfParam(usize, &'static Text, &'static Text),
}

/// A placeholder's value: one of the literal's arguments, as it is or named
/// by one of the catalog's helpers.
#[derive(Clone, Copy)]
pub(crate) enum Arg {
    Param(usize),
    Helper(Helper, usize),
}

/// The nouns a host message names a thing by, each in the interface
/// language (the helpers of `host-errors-project.ts` and
/// `host-errors-setup.ts`).
#[derive(Clone, Copy)]
pub(crate) enum Helper {
    /// What Rust calls a path it has no name for (`file_name` and
    /// `display_name` in project/paths.rs).
    UnnamedPath,
    /// `Symbol::name` in project/symbols.rs.
    SymbolName,
    /// The checklist fields `set_submission_items` limits.
    ChecklistField,
    /// The parts of the built-in agent `SynaraRuntime::spawn` checks for.
    BundledPart,
}

impl Helper {
    fn apply(self, value: &str, lang: Lang) -> String {
        const FIELD: Option<&str> = Some("submission checklist field");
        let (context, id) = match (self, value) {
            (Self::UnnamedPath, "An imported image") => (None, "An imported image"),
            (Self::UnnamedPath, "A dropped file") => (None, "A dropped file"),
            (Self::UnnamedPath, "An imported source") => (None, "An imported source"),
            (Self::UnnamedPath, "An imported file") => (None, "An imported file"),
            (Self::UnnamedPath, "That item") => (None, "That item"),
            (Self::SymbolName, "label") => (None, "label"),
            (Self::SymbolName, "citation key") => (None, "citation key"),
            (Self::ChecklistField, "file path") => (FIELD, "file path"),
            (Self::ChecklistField, "checked date") => (FIELD, "checked date"),
            (Self::ChecklistField, "source") => (FIELD, "source"),
            (Self::ChecklistField, "owner") => (FIELD, "owner"),
            (Self::BundledPart, "JavaScript runtime") => (None, "JavaScript runtime"),
            (Self::BundledPart, "Synara service") => (None, "Synara service"),
            _ => return value.to_string(),
        };
        lang.word(context, id).to_string()
    }
}

/// The language a message is put in: passed down rather than read from
/// the process-wide locale at each step, so a test can ask for Chinese
/// without switching the app's language under other tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Lang {
    En,
    Zh,
}

impl Lang {
    fn current() -> Self {
        if lattice_i18n::locale().is_chinese() {
            Self::Zh
        } else {
            Self::En
        }
    }

    /// A catalog message in this language; the English when it has none.
    fn word(self, context: Option<&str>, id: &'static str) -> &'static str {
        match self {
            Self::En => id,
            Self::Zh => lattice_i18n::chinese(context, id).unwrap_or(id),
        }
    }
}

/// The `io::Error` text Rust appends to a failed file operation
/// ("Permission denied (os error 13)"), by macOS errno; other numbers keep
/// their English (`osErrorText`).
fn os_error_text(code: &str, lang: Lang) -> Option<&'static str> {
    let id = match code {
        "1" => "The operation is not permitted.",
        "2" => "No such file or folder.",
        "13" => "Permission denied.",
        "17" => "A file with that name already exists.",
        "18" => "Files cannot be moved across disks this way.",
        "20" => "A part of the path is not a folder.",
        "21" => "That is a folder.",
        "28" => "The disk is full.",
        "30" => "The disk is read-only.",
        "63" => "The file name is too long.",
        "66" => "The folder is not empty.",
        _ => return None,
    };
    Some(lang.word(None, id))
}

/// The standard library's own sentence, worded by hand (the catalog's
/// `STD_ERRORS_FILE` entry).
const OS_ERROR: &str = "{} (os error {})";

enum Rule {
    Catalog(&'static Entry),
    OsError,
}

struct Compiled {
    pattern: Regex,
    rule: Rule,
}

static COMPILED: LazyLock<Vec<Compiled>> = LazyLock::new(|| {
    let mut compiled: Vec<(usize, Compiled)> = catalog::ENTRIES
        .iter()
        .map(|entry| (entry.literal, Rule::Catalog(entry)))
        .chain([(OS_ERROR, Rule::OsError)])
        .map(|(literal, rule)| {
            let (pattern, specificity) = literal_pattern(literal);
            (specificity, Compiled { pattern, rule })
        })
        .collect();
    // The entry with the most fixed text wins, so "Could not read {}: {}"
    // never claims a message a more specific entry spells out.
    compiled.sort_by(|left, right| right.0.cmp(&left.0));
    compiled.into_iter().map(|(_, compiled)| compiled).collect()
});

/// A Rust `format!` literal as an anchored pattern capturing each argument,
/// and how much fixed text it has. `{{` and `}}` are literal braces; any
/// other `{…}` is an argument, named, positional or with a format spec.
fn literal_pattern(literal: &str) -> (Regex, usize) {
    let mut tokens = Vec::new();
    let bytes = literal.as_bytes();
    let mut ix = 0;
    while ix < bytes.len() {
        match bytes[ix] {
            b'{' | b'}' if bytes.get(ix + 1) == Some(&bytes[ix]) => {
                tokens.push((ix, ix + 2, true));
                ix += 2;
            }
            b'{' => match literal[ix + 1..].find(['{', '}']) {
                Some(close) if literal.as_bytes()[ix + 1 + close] == b'}' => {
                    tokens.push((ix, ix + close + 2, false));
                    ix += close + 2;
                }
                _ => ix += 1,
            },
            _ => ix += 1,
        }
    }
    let mut source = String::from("^");
    let mut fixed = 0;
    let mut last = 0;
    let count = tokens.len();
    for (index, (start, end, brace)) in tokens.into_iter().enumerate() {
        let before = &literal[last..start];
        source.push_str(&regex::escape(before));
        fixed += before.chars().count();
        if brace {
            source.push_str(&regex::escape(&literal[start..start + 1]));
            fixed += 1;
        } else if index == count - 1 && end == literal.len() {
            source.push_str("((?s:.*))");
        } else {
            source.push_str("((?s:.*?))");
        }
        last = end;
    }
    let rest = &literal[last..];
    source.push_str(&regex::escape(rest));
    fixed += rest.chars().count();
    source.push('$');
    (
        Regex::new(&source).expect("a host error literal makes a valid pattern"),
        fixed,
    )
}

fn render(text: &Text, params: &[String], lang: Lang) -> String {
    match text {
        Text::IfParam(param, then, otherwise) => {
            let chosen = if params.get(*param).is_some_and(|value| !value.is_empty()) {
                then
            } else {
                otherwise
            };
            render(chosen, params, lang)
        }
        Text::Message(id, args) => {
            let values: Vec<(&str, String)> = args
                .iter()
                .map(|(name, arg)| {
                    let value = match *arg {
                        Arg::Param(ix) => params.get(ix).cloned().unwrap_or_default(),
                        Arg::Helper(helper, ix) => {
                            helper.apply(params.get(ix).map_or("", String::as_str), lang)
                        }
                    };
                    (*name, value)
                })
                .collect();
            let values: Vec<(&str, &dyn std::fmt::Display)> = values
                .iter()
                .map(|(name, value)| (*name, value as &dyn std::fmt::Display))
                .collect();
            fill_named(lang.word(None, id), &values)
        }
    }
}

fn translate_line(line: &str, depth: usize, lang: Lang) -> String {
    for compiled in COMPILED.iter() {
        let Some(captures) = compiled.pattern.captures(line) else {
            continue;
        };
        let params: Vec<String> = captures
            .iter()
            .skip(1)
            .map(|capture| {
                let param = capture.map_or("", |capture| capture.as_str());
                if depth < 3 {
                    translate_line(param, depth + 1, lang)
                } else {
                    param.to_string()
                }
            })
            .collect();
        return match compiled.rule {
            Rule::Catalog(entry) => render(&entry.text, &params, lang),
            Rule::OsError => match os_error_text(&params[1], lang) {
                Some(text) => text.to_string(),
                None => format!("{} (os error {})", params[0], params[1]),
            },
        };
    }
    line.to_string()
}

/// `text` in the interface language when it is a host message Lattice
/// knows, else unchanged.
pub fn text(text: &str) -> String {
    let lang = Lang::current();
    if text.is_empty() || lang == Lang::En {
        return text.to_string();
    }
    // A notice is drawn every frame it moves, and each line is tried against
    // every entry: what a text became is kept, for the few texts on screen.
    let mut seen = SEEN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(shown) = seen.get(&(lang, text.to_string())) {
        return shown.clone();
    }
    if seen.len() >= SEEN_LIMIT {
        seen.clear();
    }
    let shown = translate(text, lang);
    seen.insert((lang, text.to_string()), shown.clone());
    shown
}

/// How many texts [`text`] remembers before it starts again.
const SEEN_LIMIT: usize = 256;

static SEEN: LazyLock<Mutex<HashMap<(Lang, String), String>>> = LazyLock::new(Default::default);

fn translate(text: &str, lang: Lang) -> String {
    if text.is_empty() || lang == Lang::En {
        return text.to_string();
    }
    let whole = translate_line(text, 0, lang);
    if whole != text || !text.contains('\n') {
        return whole;
    }
    // A detail of several lines is matched a line at a time.
    text.split('\n')
        .map(|line| translate_line(line, 0, lang))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Under the Chinese interface, as the Tauri app's
    /// `host-error-text.test.ts` runs its examples.
    fn zh(text: &str) -> String {
        translate(text, Lang::Zh)
    }

    #[test]
    fn a_literal_becomes_an_anchored_pattern_and_braces_stay_braces() {
        let (pattern, fixed) = literal_pattern("Could not read {}: {message}");
        let captures = pattern.captures("Could not read a.tex: b: c").unwrap();
        // Only the last argument takes the rest; the first stops at ": ".
        assert_eq!((&captures[1], &captures[2]), ("a.tex", "b: c"));
        assert_eq!(fixed, "Could not read : ".len());
        let (braces, _) = literal_pattern("Use {{curly}} {}");
        assert!(braces.is_match("Use {curly} x"));
        assert!(!pattern.is_match("Prefix Could not read a: b"));
    }

    // The English interface shows the host's text as it is.
    #[test]
    fn english_is_shown_as_written() {
        assert_eq!(
            translate("That file or folder no longer exists.", Lang::En),
            "That file or folder no longer exists."
        );
    }

    // Oracle: the zh-CN messages.po translations of the Tauri catalog's
    // messages (`host-errors-*.ts`).
    #[test]
    fn a_known_message_reads_in_chinese() {
        assert_eq!(
            zh("That file or folder no longer exists."),
            lattice_i18n::chinese(None, "That file or folder no longer exists.").unwrap()
        );
        assert_eq!(
            zh("Something only the host says."),
            "Something only the host says."
        );
    }

    // An argument that is another host message is translated in turn, and
    // the OS's own text is worded by errno.
    #[test]
    fn a_wrapped_os_error_is_translated_inside_its_sentence() {
        let expected = lattice_i18n::fill_named(
            lattice_i18n::chinese(None, "Could not read {path}: {error}").unwrap(),
            &[
                ("path", &"main.tex"),
                (
                    "error",
                    &lattice_i18n::chinese(None, "Permission denied.").unwrap(),
                ),
            ],
        );
        assert_eq!(
            zh("Could not read main.tex: Permission denied (os error 13)"),
            expected
        );
        // An errno the catalog doesn't word keeps the English.
        assert_eq!(
            zh("Something odd (os error 99)"),
            "Something odd (os error 99)"
        );
    }

    #[test]
    fn a_helper_names_the_thing_in_chinese() {
        let expected = lattice_i18n::fill_named(
            lattice_i18n::chinese(None, "Enter a {name} name.").unwrap(),
            &[("name", &lattice_i18n::chinese(None, "label").unwrap())],
        );
        assert_eq!(zh("Enter a label name."), expected);
    }

    #[test]
    fn a_detail_of_several_lines_is_matched_a_line_at_a_time() {
        let first = lattice_i18n::chinese(None, "Open a project first.").unwrap();
        assert_eq!(
            zh("Open a project first.\ntrace 1234"),
            format!("{first}\ntrace 1234")
        );
    }

    // Every message the catalog names has its Chinese in messages.po, as the
    // Tauri catalog test asks of the same entries.
    #[test]
    fn every_catalog_message_has_a_translation() {
        fn ids(text: &Text, out: &mut Vec<&'static str>) {
            match text {
                Text::Message(id, _) => out.push(id),
                Text::IfParam(_, then, otherwise) => {
                    ids(then, out);
                    ids(otherwise, out);
                }
            }
        }
        let mut missing = Vec::new();
        for entry in catalog::ENTRIES {
            let mut found = Vec::new();
            ids(&entry.text, &mut found);
            missing.extend(
                found
                    .into_iter()
                    .filter(|id| lattice_i18n::chinese(None, id).is_none()),
            );
        }
        assert!(missing.is_empty(), "no Chinese for {missing:?}");
    }
}
