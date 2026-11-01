//! Chinese, Japanese or Korean text in a document set up for neither.
//!
//! A plain `article` has no CJK fonts. LuaLaTeX and XeLaTeX drop every such
//! character with only a `Missing character` line in the log and still call
//! the build a success, so the PDF came out blank where the text was and the
//! interface said nothing. pdfLaTeX stops with one `Unicode character` error
//! per character instead. Either way the fix is the same: load ctex, which
//! BasicTeX does not ship, and build with a Unicode engine.

use super::build_log::advice;
use crate::models::Diagnostic;
use regex::Regex;
use std::collections::HashSet;

/// Lattice's advice when the fonts had no glyph for the text (LuaLaTeX, XeLaTeX).
pub(super) const GLYPHS_MISSING: &str = "cjk-glyphs-missing";
/// Lattice's advice when pdfLaTeX refused the text outright.
pub(super) const NEEDS_UNICODE_ENGINE: &str = "cjk-needs-unicode-engine";
/// The file whose absence means ctex is not installed. The interface hands it
/// to the missing-package installer, whose `tlmgr install ctex` also brings
/// xeCJK, luatexja and the Fandol fonts as ctex's dependencies.
const CTEX_FILE: &str = "ctex.sty";

/// How many of the characters the advice quotes.
const SAMPLE: usize = 5;

/// Add one piece of advice for the CJK text `log` (the last typeset pass)
/// shows the build could not set, and keep only the first of pdfLaTeX's
/// per-character errors on each line: twenty errors for one sentence buried
/// everything else.
pub(super) fn explain_cjk_text(log: &str, diagnostics: &mut Vec<Diagnostic>) {
    let missing =
        Regex::new(r"(?m)^Missing character: There is no (\S+) \(U\+[0-9A-Fa-f]+\)").unwrap();
    let dropped = distinct_cjk(missing.captures_iter(log).map(|capture| capture[1].to_string()));
    if !dropped.is_empty() {
        let script = script_of(&dropped);
        let (count, sample) = (dropped.len().to_string(), sample(&dropped));
        let message = format!(
            "The PDF is missing {count} {} ({sample}): this document's fonts have none. Add \\usepackage{{ctex}} to the preamble, or start from the Chinese article template.",
            script_noun(script)
        );
        diagnostics.push(advice(
            "warning",
            GLYPHS_MISSING,
            &[("count", &count), ("sample", &sample), ("script", script)],
            message,
        ));
    }

    let unicode = Regex::new(r"Unicode character (\S+) \(U\+[0-9A-Fa-f]+\)").unwrap();
    let refused = |diagnostic: &Diagnostic| {
        unicode
            .captures(&diagnostic.message)
            .and_then(|capture| capture[1].chars().next())
            .filter(|character| is_cjk(*character))
    };
    let mut lines = HashSet::new();
    let mut characters = Vec::new();
    diagnostics.retain(|diagnostic| match refused(diagnostic) {
        Some(character) => {
            characters.push(character.to_string());
            lines.insert((diagnostic.file.clone(), diagnostic.line))
        }
        None => true,
    });
    let refused = distinct_cjk(characters.into_iter());
    if !refused.is_empty() {
        let (script, sample) = (script_of(&refused), sample(&refused));
        let message = format!(
            "pdfLaTeX cannot typeset {} ({sample}). Add \\usepackage{{ctex}} to the preamble and switch the project to XeLaTeX, or start from the Chinese article template.",
            script_noun(script)
        );
        diagnostics.push(advice(
            "error",
            NEEDS_UNICODE_ENGINE,
            &[("sample", &sample), ("script", script)],
            message,
        ));
    }
}

/// Name ctex on the CJK advice as the missing file when TeX cannot find it,
/// so the interface offers the install only when it would help. `installed`
/// looks a TeX file up, and is asked only when there is advice to mark.
pub(super) fn mark_ctex_missing(
    diagnostics: &mut [Diagnostic], installed: impl FnOnce(&str) -> bool,
) {
    let mut advice = diagnostics
        .iter_mut()
        .filter(|diagnostic| matches!(diagnostic.code, Some(GLYPHS_MISSING | NEEDS_UNICODE_ENGINE)))
        .peekable();
    if advice.peek().is_none() || installed(CTEX_FILE) {
        return;
    }
    for diagnostic in advice {
        diagnostic.params.insert("missingFile", CTEX_FILE.to_string());
    }
}

/// The distinct CJK characters among `characters`, in first-seen order.
fn distinct_cjk(characters: impl Iterator<Item = String>) -> Vec<char> {
    let mut seen = Vec::new();
    for character in characters.filter_map(|text| text.chars().next()) {
        if is_cjk(character) && !seen.contains(&character) {
            seen.push(character);
        }
    }
    seen
}

fn sample(characters: &[char]) -> String {
    let mut sample = characters.iter().take(SAMPLE).map(char::to_string).collect::<Vec<_>>();
    if characters.len() > SAMPLE {
        sample.push("…".to_string());
    }
    sample.join(" ")
}

/// `chinese` when every character is a Han character or CJK punctuation,
/// which is what a Chinese document drops; `cjk` once kana or Hangul show the
/// text is Japanese or Korean.
fn script_of(characters: &[char]) -> &'static str {
    if characters.iter().all(|character| is_han_or_punctuation(*character)) {
        "chinese"
    } else {
        "cjk"
    }
}

fn script_noun(script: &str) -> &'static str {
    match script {
        "chinese" => "Chinese characters",
        _ => "Chinese, Japanese or Korean characters",
    }
}

fn is_han_or_punctuation(character: char) -> bool {
    matches!(
        character as u32,
        0x3000..=0x303F // CJK symbols and punctuation: 。、「」
            | 0x3400..=0x4DBF // Extension A
            | 0x4E00..=0x9FFF // Unified ideographs
            | 0xF900..=0xFAFF // Compatibility ideographs
            | 0xFF00..=0xFFEF // Full-width forms: ，（）
            | 0x20000..=0x3134F // Extensions B–G
    )
}

fn is_cjk(character: char) -> bool {
    is_han_or_punctuation(character)
        || matches!(
            character as u32,
            0x1100..=0x11FF // Hangul jamo
                | 0x3040..=0x30FF // Hiragana, katakana
                | 0x3130..=0x318F // Hangul compatibility jamo
                | 0xAC00..=0xD7AF // Hangul syllables
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::latex::build_log::parse_diagnostics;

    // Real latexmk output for a blank `article` holding a Chinese title and
    // sentence (`\title{我的论文}` and `本文提出了一种新的注意力机制。`),
    // built on BasicTeX 2026 without ctex.
    const LUALATEX: &str = include_str!("../../tests/fixtures/cjk-article-lualatex.txt");
    const XELATEX: &str = include_str!("../../tests/fixtures/cjk-article-xelatex.txt");
    const PDFLATEX: &str = include_str!("../../tests/fixtures/cjk-article-pdflatex.txt");

    fn coded<'a>(diagnostics: &'a [Diagnostic], code: &str) -> Vec<&'a Diagnostic> {
        diagnostics.iter().filter(|diagnostic| diagnostic.code == Some(code)).collect()
    }

    #[test]
    fn unicode_engines_that_drop_chinese_text_say_so() {
        for log in [LUALATEX, XELATEX] {
            let diagnostics = parse_diagnostics(log);
            let advice = coded(&diagnostics, GLYPHS_MISSING);
            assert_eq!(advice.len(), 1, "{diagnostics:#?}");
            let advice = advice[0];
            assert_eq!(advice.level, "warning");
            assert_eq!(advice.file, None);
            // 4 in 我的论文 and 13 more in the sentence, which repeats 文 and 的.
            assert_eq!(advice.params["count"], "17");
            assert_eq!(advice.params["sample"], "我 的 论 文 本 …");
            assert_eq!(advice.params["script"], "chinese");
            assert!(advice.message.contains("\\usepackage{ctex}"), "{}", advice.message);
            assert!(!advice.params.contains_key("missingFile"));
        }
    }

    #[test]
    fn pdflatex_unicode_errors_become_one_error_per_line_and_advice() {
        let diagnostics = parse_diagnostics(PDFLATEX);
        let located = diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.message.contains("Unicode character"))
            .map(|diagnostic| (diagnostic.line, diagnostic.message.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            located,
            [
                (Some(4), "LaTeX Error: Unicode character 我 (U+6211)"),
                (Some(6), "LaTeX Error: Unicode character 本 (U+672C)"),
            ]
        );
        let advice = coded(&diagnostics, NEEDS_UNICODE_ENGINE);
        assert_eq!(advice.len(), 1, "{diagnostics:#?}");
        assert_eq!(advice[0].level, "error");
        assert_eq!(advice[0].params["sample"], "我 的 论 文 本 …");
        assert!(advice[0].message.contains("switch the project to XeLaTeX"));
        assert!(coded(&diagnostics, GLYPHS_MISSING).is_empty());
    }

    #[test]
    fn other_missing_characters_and_unicode_errors_are_left_alone() {
        let log = "Running 'lualatex'\nMissing character: There is no ☃ (U+2603) in font [lmroman10-regular]:+tlig;!\n./main.tex:3: LaTeX Error: Unicode character ☃ (U+2603)\n";
        let diagnostics = parse_diagnostics(log);
        assert!(diagnostics.iter().all(|diagnostic| diagnostic.code.is_none()), "{diagnostics:#?}");
        assert_eq!(diagnostics.len(), 1);
    }

    #[test]
    fn kana_or_hangul_widen_the_script() {
        let log = "Missing character: There is no あ (U+3042) in font x!\nMissing character: There is no 漢 (U+6F22) in font x!\n";
        let diagnostics = parse_diagnostics(log);
        let advice = coded(&diagnostics, GLYPHS_MISSING);
        assert_eq!(advice[0].params["script"], "cjk");
        assert_eq!(advice[0].params["sample"], "あ 漢");
        assert!(advice[0].message.contains("Chinese, Japanese or Korean characters"));
    }

    #[test]
    fn the_install_is_offered_only_when_ctex_is_missing() {
        let mut diagnostics = parse_diagnostics(XELATEX);
        mark_ctex_missing(&mut diagnostics, |_| true);
        assert!(diagnostics
            .iter()
            .all(|diagnostic| !diagnostic.params.contains_key("missingFile")));
        mark_ctex_missing(&mut diagnostics, |file| file != CTEX_FILE);
        assert_eq!(coded(&diagnostics, GLYPHS_MISSING)[0].params["missingFile"], CTEX_FILE);

        // A build with nothing to mark never looks for ctex.
        let mut plain = parse_diagnostics("LaTeX Warning: Reference `x' undefined.\n");
        mark_ctex_missing(&mut plain, |_| panic!("asked for no reason"));
    }
}
