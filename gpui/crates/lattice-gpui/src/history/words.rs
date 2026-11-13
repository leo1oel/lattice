//! The changes between two texts as the phrases a writer would name, ported
//! from the Tauri app's `src/agent/proofread-edits.ts` (`tokenHunks`,
//! `logicalGroups`, `joinHunks`, `trimSharedSpace`, `phraseHunks`): an opened
//! version, a comparison and the conflict resolver all read their edits from
//! these.
//!
//! The texts are split into words, LaTeX control sequences, runs of spaces,
//! line breaks and single other characters; Myers' shortest edit script
//! finds the tokens the two share; the changes between them are joined into
//! the edits a proofread would offer (`one.` → `.` is one deletion, `state of
//! the art` → `state-of-the-art` one edit). Offsets are byte offsets into the
//! original, where the Tauri app's are UTF-16 code units: each side of the
//! port is consistent with itself.

use std::sync::LazyLock;

use regex::Regex;

/// One change: replace `[from, to)` of the original with `insert`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

/// Words, LaTeX control sequences, runs of spaces, line breaks, and single other characters.
static TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)\\(?:[A-Za-z@]+|.)|[\p{L}\p{N}\p{M}]+|[^\S\n]+|\n|.")
        .expect("the token pattern compiles")
});

/// Past this many token edits a change is a rewrite; it is read as one change.
const MAX_DIFF_DISTANCE: usize = 1_500;

struct Token<'a> {
    text: &'a str,
    from: usize,
}

fn tokenize(text: &str) -> Vec<Token<'_>> {
    TOKEN
        .find_iter(text)
        .map(|found| Token {
            text: found.as_str(),
            from: found.start(),
        })
        .collect()
}

/// Index pairs of the tokens `a` and `b` share, in order (Myers' shortest
/// edit script). None when the two differ by more than `MAX_DIFF_DISTANCE`.
/// Each round keeps only the diagonals it could reach, so memory is the
/// square of the edit distance rather than of the text length.
fn common_tokens(a: &[&str], b: &[&str]) -> Option<Vec<(usize, usize)>> {
    let n = a.len() as isize;
    let m = b.len() as isize;
    let offset = n + m + 1;
    let mut frontier = vec![0isize; (2 * offset + 1) as usize];
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let most = (n + m).min(MAX_DIFF_DISTANCE as isize);
    let mut distance = 0isize;
    while distance <= most {
        let low = (offset - distance) as usize;
        let high = (offset + distance + 1) as usize;
        trace.push(frontier[low..high].to_vec());
        let mut diagonal = -distance;
        while diagonal <= distance {
            let at = |k: isize| frontier[(offset + k) as usize];
            let down = diagonal == -distance
                || (diagonal != distance && at(diagonal - 1) < at(diagonal + 1));
            let mut x = if down {
                at(diagonal + 1)
            } else {
                at(diagonal - 1) + 1
            };
            let mut y = x - diagonal;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            frontier[(offset + diagonal) as usize] = x;
            if x >= n && y >= m {
                return Some(backtrack(&trace, distance, n, m));
            }
            diagonal += 2;
        }
        distance += 1;
    }
    None
}

fn backtrack(trace: &[Vec<isize>], distance: isize, n: isize, m: isize) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    let (mut x, mut y) = (n, m);
    let mut round = distance;
    while round > 0 {
        // The frontier before `round`, indexed from diagonal -round.
        let frontier = &trace[round as usize];
        let at = |diagonal: isize| frontier[(diagonal + round) as usize];
        let diagonal = x - y;
        let down = diagonal == -round || (diagonal != round && at(diagonal - 1) < at(diagonal + 1));
        let previous = if down { diagonal + 1 } else { diagonal - 1 };
        let previous_x = at(previous);
        let previous_y = previous_x - previous;
        let start_x = if down { previous_x } else { previous_x + 1 };
        while x > start_x {
            x -= 1;
            y -= 1;
            pairs.push((x as usize, y as usize));
        }
        x = previous_x;
        y = previous_y;
        round -= 1;
    }
    while x > 0 && y > 0 {
        x -= 1;
        y -= 1;
        pairs.push((x as usize, y as usize));
    }
    pairs.reverse();
    pairs
}

/// The token-level changes from `original` to `revised`, in original offsets.
pub fn token_hunks(original: &str, revised: &str) -> Vec<Hunk> {
    let a = tokenize(original);
    let b = tokenize(revised);
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start].text == b[start].text {
        start += 1;
    }
    let (mut end_a, mut end_b) = (a.len(), b.len());
    while end_a > start && end_b > start && a[end_a - 1].text == b[end_b - 1].text {
        end_a -= 1;
        end_b -= 1;
    }
    let offset_of = |index: usize| a.get(index).map_or(original.len(), |token| token.from);
    let text_of = |from: usize, to: usize| {
        b[from..to]
            .iter()
            .map(|token| token.text)
            .collect::<String>()
    };
    let middle_a: Vec<&str> = a[start..end_a].iter().map(|token| token.text).collect();
    let middle_b: Vec<&str> = b[start..end_b].iter().map(|token| token.text).collect();
    let pairs = common_tokens(&middle_a, &middle_b).unwrap_or_default();
    let mut hunks = Vec::new();
    let (mut i, mut j) = (start, start);
    let ends = pairs
        .into_iter()
        .map(|(x, y)| (x + start, y + start))
        .chain(std::iter::once((end_a, end_b)));
    for (x, y) in ends {
        if x > i || y > j {
            hunks.push(Hunk {
                from: offset_of(i),
                to: offset_of(x),
                insert: text_of(j, y),
            });
        }
        i = x + 1;
        j = y + 1;
    }
    hunks
}

fn has_space(text: &str) -> bool {
    text.chars().any(char::is_whitespace)
}

/// A change that swaps one word for another, as a spelling or agreement fix does.
fn swaps_word(original: &str, hunk: &Hunk) -> bool {
    let deleted = &original[hunk.from..hunk.to];
    !deleted.is_empty()
        && !hunk.insert.is_empty()
        && !has_space(deleted)
        && !has_space(&hunk.insert)
}

/// Spaces and tabs only, no line break.
fn is_inline_space(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_whitespace() && c != '\n')
}

/// Token changes joined into the edits a writer would name. Changes touching
/// the same run of non-space characters belong together; across a single
/// space, two word swaps stay separate (`teh` and `wich` are two fixes), but
/// a word added or dropped joins its neighbour: `In this` → `This` is one
/// rewording.
fn logical_groups(original: &str, hunks: Vec<Hunk>) -> Vec<Vec<Hunk>> {
    let mut groups: Vec<Vec<Hunk>> = Vec::new();
    for hunk in hunks {
        let joins = groups
            .last()
            .and_then(|group| group.last())
            .is_some_and(|last| {
                let gap = &original[last.to..hunk.from];
                !has_space(gap)
                    || (is_inline_space(gap)
                        && !(swaps_word(original, last) && swaps_word(original, &hunk)))
            });
        match groups.last_mut() {
            Some(group) if joins => group.push(hunk),
            _ => groups.push(vec![hunk]),
        }
    }
    groups
}

fn join_hunks(original: &str, hunks: &[Hunk]) -> Hunk {
    let mut insert = String::new();
    for (index, hunk) in hunks.iter().enumerate() {
        if index > 0 {
            insert.push_str(&original[hunks[index - 1].to..hunk.from]);
        }
        insert.push_str(&hunk.insert);
    }
    Hunk {
        from: hunks[0].from,
        to: hunks[hunks.len() - 1].to,
        insert,
    }
}

/// `hunk` without the spaces it deletes and inserts alike at either end (`In this␠` → `This␠`).
fn trim_shared_space(original: &str, hunk: Hunk) -> Hunk {
    let Hunk {
        mut from,
        mut to,
        mut insert,
    } = hunk;
    while to > from {
        let Some(last) = insert.chars().last() else {
            break;
        };
        let deleted = original[from..to].chars().last();
        if !last.is_whitespace() || deleted != Some(last) {
            break;
        }
        to -= last.len_utf8();
        insert.pop();
    }
    while to > from {
        let Some(first) = insert.chars().next() else {
            break;
        };
        let deleted = original[from..to].chars().next();
        if !first.is_whitespace() || deleted != Some(first) {
            break;
        }
        from += first.len_utf8();
        insert.remove(0);
    }
    Hunk { from, to, insert }
}

/// The changes from `original` to `revised` as the phrases a writer would
/// name, the way a proofread offers them.
pub fn phrase_hunks(original: &str, revised: &str) -> Vec<Hunk> {
    logical_groups(original, token_hunks(original, revised))
        .iter()
        .map(|group| trim_shared_space(original, join_hunks(original, group)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(original: &str, hunks: &[Hunk]) -> String {
        let mut out = String::new();
        let mut cursor = 0;
        for hunk in hunks {
            out.push_str(&original[cursor..hunk.from]);
            out.push_str(&hunk.insert);
            cursor = hunk.to;
        }
        out.push_str(&original[cursor..]);
        out
    }

    fn read(original: &str, hunks: &[Hunk]) -> Vec<(String, String)> {
        hunks
            .iter()
            .map(|hunk| {
                (
                    original[hunk.from..hunk.to].to_string(),
                    hunk.insert.clone(),
                )
            })
            .collect()
    }

    #[test]
    fn edits_apply_back_to_the_revision() {
        for (a, b) in [
            ("The cat sat on the mat.", "The dog sat on a mat."),
            ("", "New text."),
            ("Old text.", ""),
            ("我们提出了一种新的方法。", "我们提出了一种更好的方法。"),
            (
                "\\section{Intro}\nText here.\n",
                "\\section{Introduction}\nText there.\n",
            ),
        ] {
            assert_eq!(apply(a, &phrase_hunks(a, b)), b, "{a:?} → {b:?}");
        }
    }

    #[test]
    fn word_swaps_across_a_space_stay_two_fixes() {
        let original = "teh wich one";
        assert_eq!(
            read(original, &phrase_hunks(original, "the which one")),
            vec![
                ("teh".into(), "the".into()),
                ("wich".into(), "which".into())
            ]
        );
    }

    #[test]
    fn a_word_dropped_joins_its_neighbour() {
        let original = "In this paper we";
        assert_eq!(
            read(original, &phrase_hunks(original, "This paper we")),
            vec![("In this".into(), "This".into())]
        );
    }

    #[test]
    fn a_hyphenated_phrase_is_one_edit() {
        let original = "state of the art";
        assert_eq!(phrase_hunks(original, "state-of-the-art").len(), 1);
    }
}
