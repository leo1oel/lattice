//! The ranking the keyboard pickers share (`src/components/ui/picker-ranking.ts`)
//! and the marks quick open draws under the typed characters
//! (`markMatch` in `src/project/quick-open-dialog.tsx`).

use std::ops::Range;

/// Whether `hay[at]` starts a word: the first character, or one after a
/// space or separator.
fn word_start(hay: &[char], at: usize) -> bool {
    at == 0
        || matches!(
            hay[at - 1],
            ' ' | '\t' | '\n' | '/' | '.' | '_' | '-' | '·' | '('
        )
}

/// `needle`'s characters (spaces dropped) in order in `hay`, each step
/// scoring higher the closer it follows the previous one; zero when they do
/// not all appear. With `runs`, each character must follow the previous one
/// directly or begin a word, so "sp" finds Show Panel and letters scattered
/// inside words are no match.
fn subsequence_score(hay: &str, needle: &str, runs: bool) -> i64 {
    let hay: Vec<char> = hay.chars().collect();
    let mut score = 0;
    let mut index = 0;
    for character in needle.chars().filter(|c| !c.is_whitespace()) {
        let find = |from: usize| (from..hay.len()).find(|&at| hay[at] == character);
        let mut next = find(index);
        if runs {
            while let Some(at) = next
                && at > index
                && !word_start(&hay, at)
            {
                next = find(at + 1);
            }
        }
        let Some(at) = next else {
            return 0;
        };
        score += 10 - (at - index).min(9) as i64;
        index = at + 1;
    }
    score
}

/// How well a project path matches `query`: its whole, its file name, a run
/// of it, then its characters in order. Zero for no match.
pub fn score_path(path: &str, query: &str) -> i64 {
    let hay = path.to_lowercase();
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return 1;
    }
    if hay == needle {
        return 1000;
    }
    if hay.ends_with(&format!("/{needle}")) {
        return 900;
    }
    if let Some(at) = hay.find(&needle) {
        return 500 - hay[..at].chars().count() as i64;
    }
    subsequence_score(&hay, &needle, false)
}

/// What a picker row says, as far as ranking goes.
pub struct RankedRow<'a> {
    pub label: &'a str,
    pub detail: &'a str,
    pub group: &'a str,
}

/// How well a row matches `query`, zero for no match. The label leads
/// (whole, then its start), then a run of the query anywhere in what the
/// row says, higher at a word's start; then every spaced part of the query
/// somewhere, then runs of it at word starts.
pub fn score_item(item: &RankedRow, query: &str) -> i64 {
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return 1;
    }
    let label = item.label.to_lowercase();
    if label == needle {
        return 1000;
    }
    if label.starts_with(&needle) {
        return 950;
    }
    let hay = format!("{label} {} {}", item.detail, item.group).to_lowercase();
    if let Some(at) = hay.find(&needle) {
        let chars: Vec<char> = hay.chars().collect();
        let at = hay[..at].chars().count();
        return if word_start(&chars, at) { 700 } else { 500 } - at.min(200) as i64;
    }
    let terms: Vec<&str> = needle.split_whitespace().collect();
    if terms.len() > 1 && terms.iter().all(|term| hay.contains(term)) {
        return 280;
    }
    subsequence_score(&hay, &needle, true).min(250)
}

/// The indices of `items` that score above zero, best first, `tie_break`
/// deciding between equals, at most `limit`.
pub fn rank<T>(
    items: &[T],
    score: impl Fn(&T) -> i64,
    tie_break: impl Fn(&T, &T) -> std::cmp::Ordering,
    limit: usize,
) -> Vec<usize> {
    let mut scored: Vec<(i64, usize)> = items
        .iter()
        .enumerate()
        .filter_map(|(ix, item)| {
            let score = score(item);
            (score > 0).then_some((score, ix))
        })
        .collect();
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| tie_break(&items[a.1], &items[b.1]))
    });
    scored.into_iter().take(limit).map(|(_, ix)| ix).collect()
}

/// The byte ranges of `text` to mark for `query`: a run of the query where
/// there is one, else each character in order, the way the ranking found
/// them. A query the text does not hold in order (it matched the folder)
/// marks nothing. Adjacent characters merge into one range.
pub fn match_ranges(text: &str, query: &str) -> Vec<Range<usize>> {
    let needle: Vec<char> = query
        .chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect();
    if needle.is_empty() {
        return Vec::new();
    }
    // Lowercase per character, keeping each one's byte range in `text`.
    let chars: Vec<(Range<usize>, char)> = text
        .char_indices()
        .map(|(at, c)| (at..at + c.len_utf8(), c.to_lowercase().next().unwrap_or(c)))
        .collect();
    let mut hits: Vec<usize> = Vec::new();
    let run = (0..chars.len()).find(|&start| {
        start + needle.len() <= chars.len()
            && needle
                .iter()
                .enumerate()
                .all(|(offset, c)| chars[start + offset].1 == *c)
    });
    if let Some(start) = run {
        hits.extend(start..start + needle.len());
    } else {
        let mut from = 0;
        for c in &needle {
            let Some(at) = (from..chars.len()).find(|&at| chars[at].1 == *c) else {
                return Vec::new();
            };
            hits.push(at);
            from = at + 1;
        }
    }
    let mut ranges: Vec<Range<usize>> = Vec::new();
    for hit in hits {
        let range = chars[hit].0.clone();
        match ranges.last_mut() {
            Some(last) if last.end == range.start => last.end = range.end,
            _ => ranges.push(range),
        }
    }
    ranges
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_ranks_its_whole_then_its_name_then_a_run_then_letters() {
        assert_eq!(score_path("main.tex", "main.tex"), 1000);
        assert_eq!(score_path("chapters/intro.tex", "intro.tex"), 900);
        assert!(
            score_path("chapters/intro.tex", "intro") > score_path("chapters/intro.tex", "cit")
        );
        assert!(score_path("chapters/intro.tex", "cit") > 0);
        assert_eq!(score_path("main.tex", "zz"), 0);
    }

    #[test]
    fn spaces_only_separate_the_parts() {
        assert!(score_path("notes/note-012.md", "note 12") > 0);
    }

    #[test]
    fn an_item_needs_runs_at_word_starts() {
        let row = |label| RankedRow {
            label,
            detail: "",
            group: "",
        };
        assert!(score_item(&row("Show Panel"), "sp") > 0);
        assert_eq!(score_item(&row("Import Overleaf"), "proof"), 0);
        assert_eq!(score_item(&row("Introduction"), "introduction"), 1000);
        assert_eq!(score_item(&row("Introduction"), "intro"), 950);
    }

    #[test]
    fn rank_keeps_the_best_and_breaks_ties_by_order() {
        let paths = ["b.tex", "a.tex", "zz.png"];
        let ranked = rank(&paths, |path| score_path(path, "tex"), |a, b| a.cmp(b), 10);
        assert_eq!(ranked, vec![1, 0]);
    }

    #[test]
    fn a_run_marks_together_and_scattered_letters_each() {
        assert_eq!(match_ranges("introduction.tex", "duct"), vec![5..9]);
        assert_eq!(match_ranges("main.tex", "mtx"), vec![0..1, 5..6, 7..8]);
        assert!(match_ranges("main.tex", "zz").is_empty());
        // Case does not matter, and a multibyte name keeps its byte ranges.
        assert_eq!(match_ranges("Été.tex", "té"), vec![2..5]);
    }
}
