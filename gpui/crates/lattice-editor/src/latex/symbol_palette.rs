//! What the math symbol palette (⌥⌘M) lists and writes, as the Tauri app's
//! `symbol-palette.ts` does: every maths command of the vocabulary once,
//! found by its name, its meaning or the symbol itself, and written at the
//! caret, in `$…$` outside maths, with the caret in its first argument.
//! The palette itself (its search, grid and KaTeX cells) is `lattice-gpui`'s
//! `editor_panel/symbol_palette.rs`.

use std::{ops::Range, sync::LazyLock};

use lattice_i18n::tr;

use super::{symbol_glyphs::GLYPHS, syntax::math_region_at, vocabulary::COMMANDS};

/// One of the palette's symbols.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaletteSymbol {
    /// The command, `\alpha`.
    pub name: &'static str,
    /// What a pick writes: its template (`\frac{}{}`), else its name.
    pub insert: &'static str,
    /// What it means, untranslated (the vocabulary's message).
    detail: &'static str,
    /// The text of KaTeX's drawing of it; empty where KaTeX cannot set it.
    pub glyph: &'static str,
}

impl PaletteSymbol {
    /// What it means, in the interface language.
    pub fn detail(&self) -> String {
        tr(self.detail).to_string()
    }

    /// What KaTeX draws in its cell: the insert, with an empty box where an
    /// argument goes (`paletteSymbols`).
    pub fn tex(&self) -> String {
        self.insert.replace("{}", "{\\square}")
    }

    /// Its cell's tip and accessible name, "\alpha (Greek small letter
    /// alpha)".
    pub fn title(&self) -> String {
        format!("{} ({})", self.name, self.detail())
    }
}

/// Every maths command once, in the vocabulary's order.
pub fn symbols() -> &'static [PaletteSymbol] {
    static SYMBOLS: LazyLock<Vec<PaletteSymbol>> = LazyLock::new(|| {
        let mut seen = std::collections::HashSet::new();
        COMMANDS
            .iter()
            .filter(|entry| entry.math && seen.insert(entry.name))
            .map(|entry| PaletteSymbol {
                name: entry.name,
                insert: entry.template.unwrap_or(entry.name),
                detail: entry.detail,
                glyph: GLYPHS
                    .iter()
                    .find(|(name, _)| *name == entry.name)
                    .map_or("", |(_, glyph)| glyph),
            })
            .collect()
    });
    &SYMBOLS
}

/// The symbols whose command, meaning or drawn glyph holds `query`
/// (`matchSymbols`): the name without its `\` and the meaning in any case,
/// the glyph exactly; every symbol for an empty query.
pub fn match_symbols(query: &str) -> Vec<&'static PaletteSymbol> {
    let trimmed = query.trim();
    let needle = trimmed.to_lowercase();
    let needle = needle.strip_prefix('\\').unwrap_or(&needle);
    if needle.is_empty() {
        return symbols().iter().collect();
    }
    symbols()
        .iter()
        .filter(|symbol| {
            symbol.name[1..].to_lowercase().contains(needle)
                || symbol.detail().to_lowercase().contains(needle)
                || (!symbol.glyph.is_empty() && symbol.glyph == trimmed)
        })
        .collect()
}

/// What writing `symbol` over `selection` of `text` does (`insertSymbol`):
/// the text to put there and where the caret goes, a byte offset into it.
/// In maths the command goes in as it is, a space after it when a letter
/// follows that would run on into its name; outside maths it goes in `$…$`.
/// The caret goes into its first `{}`, else after it (inside the `$`).
pub fn insertion(text: &str, selection: Range<usize>, symbol: &PaletteSymbol) -> (String, usize) {
    let in_math = math_region_at(text, selection.start).is_some();
    let letter_after = text[selection.end..]
        .chars()
        .next()
        .is_some_and(|next| next.is_ascii_alphabetic());
    let ends_in_letter = symbol
        .insert
        .chars()
        .last()
        .is_some_and(|last| last.is_ascii_alphabetic());
    let spaced = if ends_in_letter && letter_after {
        " "
    } else {
        ""
    };
    let insert = if in_math {
        format!("{}{spaced}", symbol.insert)
    } else {
        format!("${}$", symbol.insert)
    };
    let caret = match insert.find("{}") {
        Some(group) => group + 1,
        None if in_math => symbol.insert.len(),
        None => insert.len() - 1,
    };
    (insert, caret)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(query: &str) -> Vec<&'static str> {
        match_symbols(query)
            .iter()
            .map(|symbol| symbol.name)
            .collect()
    }

    fn symbol(name: &str) -> &'static PaletteSymbol {
        symbols()
            .iter()
            .find(|symbol| symbol.name == name)
            .expect("in the palette")
    }

    /// `symbol-palette.test.ts`: by command name (with or without its `\`),
    /// by the symbol itself, by meaning; everything for nothing typed.
    #[test]
    fn finds_a_symbol_by_command_name_meaning_or_the_symbol_itself() {
        assert_eq!(names("alpha"), ["\\alpha"]);
        assert_eq!(names("\\varepsilon"), ["\\varepsilon"]);
        assert_eq!(names("α"), ["\\alpha"]);
        assert_eq!(names("summation"), ["\\sum"]);
        assert!(names("").contains(&"\\frac"));
        assert_eq!(names("").len(), symbols().len());
        assert!(names("no such symbol").is_empty());
    }

    #[test]
    fn every_maths_command_is_listed_once_with_its_glyph() {
        let all = symbols();
        assert_eq!(all.len(), GLYPHS.len());
        let mut seen = std::collections::HashSet::new();
        assert!(all.iter().all(|symbol| seen.insert(symbol.name)));
        assert_eq!(symbol("\\alpha").glyph, "α");
        assert_eq!(symbol("\\frac").insert, "\\frac{}{}");
        assert_eq!(symbol("\\frac").tex(), "\\frac{\\square}{\\square}");
    }

    /// The test's two writes: `\leq` inside `$x = $` as it is, and `\frac`
    /// after the text in `$…$` with the caret in its first braces.
    #[test]
    fn writes_the_symbol_in_dollars_outside_maths_with_the_caret_in_its_first_argument() {
        let text = "Let $x = $ and ";
        let (insert, caret) = insertion(text, 9..9, symbol("\\leq"));
        assert_eq!(insert, "\\leq");
        assert_eq!(caret, insert.len());
        let text = "Let $x = \\leq$ and ";
        let end = text.len();
        let (insert, caret) = insertion(text, end..end, symbol("\\frac"));
        assert_eq!(insert, "$\\frac{}{}$");
        assert_eq!(caret, "$\\frac{".len());
        // Outside maths with no argument, the caret goes before the closing `$`.
        let (insert, caret) = insertion("x", 1..1, symbol("\\alpha"));
        assert_eq!((insert.as_str(), caret), ("$\\alpha$", "$\\alpha".len()));
    }

    #[test]
    fn a_letter_after_the_caret_in_maths_is_kept_apart() {
        let text = "$ab$";
        let (insert, caret) = insertion(text, 1..1, symbol("\\alpha"));
        assert_eq!(insert, "\\alpha ");
        assert_eq!(caret, "\\alpha".len());
        // A selection is replaced; what follows it decides.
        let (insert, _) = insertion("$x+y$", 1..2, symbol("\\beta"));
        assert_eq!(insert, "\\beta");
    }
}
