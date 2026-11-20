//! The file names Overleaf refuses, as its own `SafePath` rules them
//! (services/web/app/src/Features/Project/SafePath.mjs, shared by its server
//! and its file tree): an upload of one answers HTTP 400 `invalid_filename`,
//! and a folder of one cannot be created. A sync leaves such a file on this
//! machine and names it, rather than failing on it with every other file.

use serde::{Deserialize, Serialize};

/// Overleaf's `MAX_PATH`, in UTF-16 code units as JavaScript counts a
/// string's length.
const MAX_NAME: usize = 1024;

/// JavaScript property names Overleaf will not take as a name at the
/// project's top level (`BLOCKEDFILE_RX`).
const RESERVED: &[&str] = &[
    "prototype",
    "constructor",
    "toString",
    "toLocaleString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "__defineGetter__",
    "__lookupGetter__",
    "__defineSetter__",
    "__lookupSetter__",
    "__proto__",
];

/// Why Overleaf refuses a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NameProblem {
    /// A `\` in a name (`BADCHAR_RX`), as a TeX macro left in one has.
    Backslash,
    /// A `*` in a name (`BADCHAR_RX`).
    Asterisk,
    /// A control character in a name (`BADCHAR_RX`: U+0000–U+001F, U+007F,
    /// U+0080–U+009F).
    ControlCharacter,
    /// A character outside the Basic Multilingual Plane, such as an emoji or
    /// a rare CJK ideograph (`BADCHAR_RX`'s U+D800–U+DFFF, matched without
    /// the `u` flag, so against each half of its UTF-16 surrogate pair).
    SupplementaryCharacter,
    /// A name that is `.` or `..`, or starts or ends with whitespace as
    /// JavaScript's `\s` counts it (`BADFILE_RX`).
    DotsOrSpaces,
    /// A top-level name JavaScript reserves (`BLOCKEDFILE_RX`).
    Reserved,
    /// A name longer than Overleaf's 1024 characters.
    TooLong,
}

/// A file a sync left on this machine because Overleaf would refuse its
/// name, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedName {
    pub path: String,
    pub problem: NameProblem,
}

/// Why Overleaf would refuse `path` (relative, `/`-separated), or `None`
/// when it takes it. Each folder and the file name are checked as Overleaf
/// checks them one by one.
pub fn name_problem(path: &str) -> Option<NameProblem> {
    if RESERVED.contains(&path) {
        return Some(NameProblem::Reserved);
    }
    path.split('/').filter(|name| !name.is_empty()).find_map(|name| {
        if name.contains('\\') {
            Some(NameProblem::Backslash)
        } else if name.contains('*') {
            Some(NameProblem::Asterisk)
        } else if name.chars().any(|c| c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c)) {
            Some(NameProblem::ControlCharacter)
        } else if name.chars().any(|c| c > '\u{ffff}') {
            Some(NameProblem::SupplementaryCharacter)
        } else if name == "."
            || name == ".."
            || name.starts_with(js_whitespace)
            || name.ends_with(js_whitespace)
        {
            Some(NameProblem::DotsOrSpaces)
        } else if name.encode_utf16().count() > MAX_NAME {
            Some(NameProblem::TooLong)
        } else {
            None
        }
    })
}

/// JavaScript's `\s`, which differs from Unicode's White_Space that
/// `char::is_whitespace` follows: it takes U+FEFF and leaves out U+0085.
fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

#[cfg(test)]
mod tests {
    use super::{name_problem, NameProblem};

    #[test]
    fn overleaf_takes_ordinary_names_in_any_script() {
        for path in ["main.tex", "cvpr/references.bib", "图/实验 结果.png", "a b/c-d_e.f(1).tex"]
        {
            assert_eq!(name_problem(path), None, "{path}");
        }
    }

    #[test]
    fn overleaf_refuses_what_its_safe_path_rules_out() {
        let cases = [
            (r"cvpr/\paperbib.bib", NameProblem::Backslash),
            (r"a\b/main.tex", NameProblem::Backslash),
            ("figs/*.png", NameProblem::Asterisk),
            ("notes\u{7}.txt", NameProblem::ControlCharacter),
            ("tab\u{85}.tex", NameProblem::ControlCharacter),
            ("fig-\u{1f600}.png", NameProblem::SupplementaryCharacter),
            ("\u{20000}.tex", NameProblem::SupplementaryCharacter),
            ("../escape.tex", NameProblem::DotsOrSpaces),
            ("\u{feff}main.tex", NameProblem::DotsOrSpaces),
            ("main.tex\u{3000}", NameProblem::DotsOrSpaces),
            (" lead.tex", NameProblem::DotsOrSpaces),
            ("folder /trail.tex", NameProblem::DotsOrSpaces),
            ("constructor", NameProblem::Reserved),
            ("__proto__", NameProblem::Reserved),
        ];
        for (path, problem) in cases {
            assert_eq!(name_problem(path), Some(problem), "{path:?}");
        }
        assert_eq!(name_problem(&"x".repeat(1025)), Some(NameProblem::TooLong));
        assert_eq!(name_problem(&"x".repeat(1024)), None);
        // Reserved only at the top level, where Overleaf checks it.
        assert_eq!(name_problem("src/constructor"), None);
    }
}
