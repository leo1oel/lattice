//! chemnum compounds, as the Tauri app's `compound-keys.ts` reads them for
//! the PDF's compound hover (`pdf-compound-key-hover.tsx`) and the source's
//! compound completion: the keys a source line names in `\cmpd` and its
//! relatives, the number the last
//! build gave each (its `.aux`), and whether a run of PDF text reads as a
//! compound's number.
//!
//! Keys are data: sources are untrusted and a key is written to the
//! clipboard, so nothing in one may be LaTeX. Rust's regexes run in linear
//! time, so a crafted source or `.aux` cannot make these quadratic.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::LazyLock,
};

use regex::Regex;

static COMPOUND_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(?:cmpd\*?|refcmpd|labelcmpd)(?:\[[^\]\[{}]*\])?\{([^{}]*)\}").unwrap()
});
static MARK_COMMAND: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\rcmpd\{([^{}]*)\}").unwrap());
static COMPOUND_AUX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"\\chemnum@cmpd\s*\{([^{}]*)\}\{([^{}]*)\}\{([^{}]*)\}",
        r"\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\{[^{}]*\}\{([^{}]*)\}",
    ))
    .unwrap()
});
static SUB_AUX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\chemnum@subcmpd\s*\{([^{}]*)\}\{([^{}]*)\}\{([^{}]*)\}\{([^{}]*)\}").unwrap()
});
static SERIES_AUX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\cmpdser@aux\s*\{([AaIi])\}\{([^{}]*)\}\{([^{}]*)\}").unwrap());
static AUX_INPUT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\@input\{([^}]+\.aux)\}").unwrap());
static MACRO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\[A-Za-z@]+\s*").unwrap());
static THE_COUNTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\the[a-z]+").unwrap());
/// A printed counter and its separator in front of a number: the `1-` of `1-2a`.
static COUNTER_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:\d+|[ivxlc]+|[IVXLC]+|[A-Z])[-.]").unwrap());

/// The most keys a key's characters may run to (`SAFE_KEY`).
const MAX_KEY_CHARS: usize = 200;
/// A longer `.aux` is not read, nor more than this many of its inputs.
const MAX_AUX_BYTES: u64 = 4_000_000;
const MAX_AUX_INPUTS: usize = 300;

/// What chemnum numbered: each key's printed number, and the keys whose
/// `pre-label-code` prints a counter (such as `\thechapter-`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CompoundNumbers {
    pub numbers: HashMap<String, String>,
    pub counter_prefixed: HashSet<String>,
}

impl CompoundNumbers {
    pub fn is_empty(&self) -> bool {
        self.numbers.is_empty()
    }

    /// Whether `text` (a run of PDF text) is a number the build gave some
    /// compound, the hover's first test before any SyncTeX lookup.
    pub fn prints(&self, text: &str) -> bool {
        let number = printed_number(text);
        let bare = without_counter_prefix(text, self);
        self.numbers
            .values()
            .any(|assigned| assigned == number || (!bare.is_empty() && *assigned == bare))
    }
}

pub(crate) fn is_safe_key(key: &str) -> bool {
    let count = key.chars().count();
    (1..=MAX_KEY_CHARS).contains(&count)
        && !key.chars().any(|ch| {
            matches!(
                ch,
                '\\' | '{' | '}' | '%' | '#' | '$' | '&' | '^' | '~' | '\r' | '\n'
            )
        })
}

/// The key chemnum records a number under: `key.sub.num` is written,
/// `key.sub` recorded; a format suffix counts only after a key and a sub.
pub fn numbered_key(key: &str) -> &str {
    let parts: Vec<&str> = key.split('.').collect();
    match parts[..] {
        [head, sub, "num" | "dash" | "letter"] if !head.is_empty() && !sub.is_empty() => {
            &key[..head.len() + 1 + sub.len()]
        }
        _ => key,
    }
}

/// A run of PDF text as the number it may be: `(2a),` reads `2a`.
pub fn printed_number(text: &str) -> &str {
    text.trim()
        .trim_start_matches(['(', '['])
        .trim_end_matches([')', ']', ',', '.', ';', ':'])
}

/// A run of PDF text without the counter in front, when the build gave some
/// compound such a prefix (which the `.aux` holds only as a macro); else "".
pub fn without_counter_prefix(text: &str, numbers: &CompoundNumbers) -> String {
    if numbers.counter_prefixed.is_empty() {
        return String::new();
    }
    let number = printed_number(text);
    let bare = COUNTER_PREFIX.replace(number, "");
    if bare == number {
        String::new()
    } else {
        bare.into_owned()
    }
}

/// Of the keys a source line names, those the last build numbered as the
/// PDF text reads: SyncTeX gives only the line, which also typesets citation
/// numbers, references and years.
pub fn keys_numbered(text: &str, keys: &[String], numbers: &CompoundNumbers) -> Vec<String> {
    let number = printed_number(text);
    if number.is_empty() {
        return Vec::new();
    }
    let bare = without_counter_prefix(text, numbers);
    keys.iter()
        .filter(|key| {
            let recorded = numbered_key(key);
            let assigned = numbers.numbers.get(recorded);
            assigned.is_some_and(|assigned| assigned == number)
                || (!bare.is_empty()
                    && assigned.is_some_and(|assigned| *assigned == bare)
                    && numbers.counter_prefixed.contains(recorded))
        })
        .cloned()
        .collect()
}

/// `line` up to its first unescaped `%`.
fn without_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    for (ix, byte) in bytes.iter().enumerate() {
        if *byte == b'%' && (ix == 0 || bytes[ix - 1] != b'\\') {
            return &line[..ix];
        }
    }
    line
}

/// What `\rcmpd` names on `line`: the text of a drawing's `[[…]]` marks.
pub fn compound_marks_on_line(line: &str) -> Vec<String> {
    MARK_COMMAND
        .captures_iter(without_comment(line))
        .map(|found| found[1].trim().to_string())
        .filter(|key| is_safe_key(key))
        .collect()
}

/// The distinct compound keys named on `line`, in order; a sub-compound
/// keeps its `key.sub` form.
pub fn compound_keys_on_line(line: &str) -> Vec<String> {
    let source = without_comment(line);
    let mut keys: Vec<String> = Vec::new();
    let named = COMPOUND_COMMAND
        .captures_iter(source)
        .flat_map(|found| {
            found[1]
                .split(',')
                .map(|key| key.trim().to_string())
                .collect::<Vec<_>>()
        })
        .chain(compound_marks_on_line(source));
    for key in named {
        if is_safe_key(&key) && !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

/// The LaTeX that cites a compound in the text.
pub fn compound_command(key: &str, is_mark: bool) -> String {
    let mut chars = key.chars();
    let series = matches!(
        (chars.next(), chars.next()),
        (Some('A' | 'a' | 'I' | 'i'), Some(':'))
    );
    if is_mark || series {
        format!("\\rcmpd{{{key}}}")
    } else {
        format!("\\cmpd{{{key}}}")
    }
}

fn plain_number(value: &str) -> String {
    MACRO
        .replace_all(value, "")
        .replace(['{', '}'], "")
        .trim()
        .to_string()
}

/// A label part chemnum wrote; one left as a macro is known only while
/// typesetting.
fn label_part(value: &str) -> String {
    if value.contains('\\') {
        String::new()
    } else {
        plain_number(value)
    }
}

/// What chemnum wrote to an `.aux`: each key's label as printed, with its
/// prefix and suffix, and `key.sub` with the sub's letter after the number.
pub fn parse_compound_numbers(aux: &str) -> CompoundNumbers {
    let mut found = CompoundNumbers::default();
    let mut parents: HashMap<String, (String, String, String)> = HashMap::new();
    for caps in COMPOUND_AUX.captures_iter(aux) {
        let (key, counter, shown, pre, post, separator) =
            (&caps[1], &caps[2], &caps[3], &caps[4], &caps[5], &caps[6]);
        let shown = plain_number(shown);
        let head = label_part(pre)
            + if shown.is_empty() {
                plain_number(counter)
            } else {
                shown
            }
            .as_str();
        if THE_COUNTER.is_match(pre) {
            found.counter_prefixed.insert(key.to_string());
        }
        let post = label_part(post);
        found
            .numbers
            .insert(key.to_string(), format!("{head}{post}"));
        parents.insert(key.to_string(), (head, label_part(separator), post));
    }
    for caps in SUB_AUX.captures_iter(aux) {
        let (key, sub, letter) = (&caps[1], &caps[2], &caps[4]);
        let Some((head, separator, post)) = parents.get(key) else {
            continue;
        };
        let sub_key = format!("{key}.{sub}");
        found.numbers.insert(
            sub_key.clone(),
            format!("{head}{separator}{}{post}", plain_number(letter)),
        );
        if found.counter_prefixed.contains(key) {
            found.counter_prefixed.insert(sub_key);
        }
    }
    for caps in SERIES_AUX.captures_iter(aux) {
        found
            .numbers
            .insert(format!("{}:{}", &caps[1], &caps[2]), plain_number(&caps[3]));
    }
    found
}

/// What chemnum numbered in a build of `root_document`, its `.aux` files in
/// `aux_folder` (the document's folder when empty): the main `.aux` and the
/// ones it `\@input`s. Empty for a project that does not use chemnum, which
/// is how the PDF knows to look for no compound at all.
pub fn read_compound_numbers(
    root: &Path,
    root_document: &str,
    aux_folder: &str,
) -> CompoundNumbers {
    let folder = if aux_folder.is_empty() {
        Path::new(root_document)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default()
    } else {
        Path::new(aux_folder).to_path_buf()
    };
    let read = |relative: &Path| -> String {
        let path = root.join(&folder).join(relative);
        // Only files inside the project, and not too large.
        if !path.starts_with(root)
            || std::fs::metadata(&path).map_or(true, |meta| meta.len() > MAX_AUX_BYTES)
        {
            return String::new();
        }
        std::fs::read_to_string(path).unwrap_or_default()
    };
    let Some(name) = Path::new(root_document).file_stem() else {
        return CompoundNumbers::default();
    };
    let main = read(&Path::new(name).with_extension("aux"));
    let mut texts = vec![main.clone()];
    for input in AUX_INPUT.captures_iter(&main).take(MAX_AUX_INPUTS) {
        let input = &input[1];
        if input.split('/').any(|part| part == "..") || input.starts_with('/') {
            continue;
        }
        texts.push(read(Path::new(input)));
    }
    parse_compound_numbers(&texts.join("\n"))
}

#[cfg(test)]
mod tests;
