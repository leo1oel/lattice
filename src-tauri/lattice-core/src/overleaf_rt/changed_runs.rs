//! Where two versions of a document differ, as separate runs of pieces
//! (lines, or a line's characters): the Tauri app's
//! `src/overleaf/changed-runs.ts`, which the OT engine (`super::ot`) uses.
//!
//! Most edits are one contiguous change, and trimming the common prefix and
//! suffix finds it exactly. Some are not: a replace-all, a rename, an agent's
//! edit or a file changed on disk can touch distant places within one send.
//! Trimmed alone, that reads as rewriting everything from the first change to
//! the last, which sent as a suggestion proposes deleting and retyping every
//! paragraph in between. Matching the pieces in the middle (Myers' shortest
//! edit script) keeps each change to itself.

/// A run of `a`'s pieces `[a_from, a_to)` that became `b`'s `[b_from, b_to)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ChangedRun {
    pub a_from: usize,
    pub a_to: usize,
    pub b_from: usize,
    pub b_to: usize,
}

/// Lines of `text` (UTF-16 units), each keeping its own line break, so they
/// join back into it.
pub(super) fn split_lines(text: &[u16]) -> Vec<&[u16]> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, unit) in text.iter().enumerate() {
        if *unit == u16::from(b'\n') {
            lines.push(&text[start..=index]);
            start = index + 1;
        }
    }
    if start < text.len() {
        lines.push(&text[start..]);
    }
    lines
}

/// `text`'s code points, each one or two UTF-16 units, so no piece cuts a
/// character in half.
pub(super) fn code_points(text: &[u16]) -> Vec<&[u16]> {
    let mut points = Vec::new();
    let mut index = 0;
    while index < text.len() {
        let width = if is_high_surrogate(text[index])
            && text.get(index + 1).is_some_and(|unit| is_low_surrogate(*unit))
        {
            2
        } else {
            1
        };
        points.push(&text[index..index + width]);
        index += width;
    }
    points
}

pub(super) fn is_high_surrogate(unit: u16) -> bool {
    (0xd800..=0xdbff).contains(&unit)
}

pub(super) fn is_low_surrogate(unit: u16) -> bool {
    (0xdc00..=0xdfff).contains(&unit)
}

/// The runs where `a` and `b` differ, in order, or none when more than
/// `limit` pieces were added or removed: past that, matching costs more than
/// one broad change saves.
pub(super) fn changed_runs<T: PartialEq>(
    a: &[T], b: &[T], limit: usize,
) -> Option<Vec<ChangedRun>> {
    let (n, m) = (a.len() as i64, b.len() as i64);
    // rounds[d][k + d]: how far along `a` the furthest d-edit path on
    // diagonal k (= x - y) reaches, or -1 when no such path stays inside the
    // grid.
    let mut rounds: Vec<Vec<i64>> = Vec::new();
    for d in 0..=(limit as i64).min(n + m) {
        rounds.push(vec![-1; (2 * d + 1) as usize]);
        let mut k = -d;
        while k <= d {
            let x = if d == 0 {
                Some(0)
            } else {
                start(&rounds[(d - 1) as usize], d, k, n, m).map(|(x, _)| x)
            };
            if let Some(x) = x {
                let mut end = x;
                while end < n
                    && end - k >= 0
                    && end - k < m
                    && a[end as usize] == b[(end - k) as usize]
                {
                    end += 1;
                }
                rounds[d as usize][(k + d) as usize] = end;
                if end == n && end - k == m {
                    return Some(runs_of(&matches(&rounds, n, m), n, m));
                }
            }
            k += 2;
        }
    }
    None
}

/// Where a d-edit path on diagonal k begins its final stretch of matching
/// pieces: one further along `a` than the best (d-1)-path on diagonal k - 1
/// (a piece removed), or level with the one on k + 1 (a piece added). The
/// diagonal it came from goes with it.
fn start(previous: &[i64], d: i64, k: i64, n: i64, m: i64) -> Option<(i64, i64)> {
    let at = |diagonal: i64| {
        if diagonal.abs() < d {
            previous[(diagonal + d - 1) as usize]
        } else {
            -1
        }
    };
    let before = at(k - 1);
    let removed = if before >= 0 && before < n && before + 1 - k <= m { before + 1 } else { -1 };
    let after = at(k + 1);
    let added = if after >= 0 && after - k <= m && after - k >= 0 { after } else { -1 };
    if removed < 0 && added < 0 {
        return None;
    }
    Some(if removed > added { (removed, k - 1) } else { (added, k + 1) })
}

/// The matched pairs `(x, y)` along the path that reached `(n, m)`, in order.
fn matches(rounds: &[Vec<i64>], n: i64, m: i64) -> Vec<(i64, i64)> {
    let mut pairs = Vec::new();
    let (mut x, mut y) = (n, m);
    for d in (0..rounds.len() as i64).rev() {
        let k = x - y;
        let (from_x, from_diagonal) = if d == 0 {
            (0, 0)
        } else {
            start(&rounds[(d - 1) as usize], d, k, n, m)
                .expect("the path reached (n, m) through here")
        };
        while x > from_x {
            x -= 1;
            y -= 1;
            pairs.push((x, y));
        }
        if d == 0 {
            break;
        }
        x = rounds[(d - 1) as usize][(from_diagonal + d - 1) as usize];
        y = x - from_diagonal;
    }
    pairs.reverse();
    pairs
}

fn runs_of(pairs: &[(i64, i64)], n: i64, m: i64) -> Vec<ChangedRun> {
    let mut runs = Vec::new();
    let (mut x, mut y) = (0, 0);
    for &(mx, my) in pairs.iter().chain(std::iter::once(&(n, m))) {
        if mx > x || my > y {
            runs.push(ChangedRun {
                a_from: x as usize,
                a_to: mx as usize,
                b_from: y as usize,
                b_to: my as usize,
            });
        }
        x = mx + 1;
        y = my + 1;
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separate_changes_stay_separate_runs() {
        let a = ["one", "two", "three", "four", "five"];
        let b = ["ONE", "two", "three", "four", "FIVE"];
        let runs = changed_runs(&a, &b, 400).unwrap();
        assert_eq!(
            runs,
            vec![
                ChangedRun { a_from: 0, a_to: 1, b_from: 0, b_to: 1 },
                ChangedRun { a_from: 4, a_to: 5, b_from: 4, b_to: 5 },
            ]
        );
    }

    #[test]
    fn too_many_changes_give_no_runs() {
        let a: Vec<u32> = (0..10).collect();
        let b: Vec<u32> = (100..110).collect();
        assert_eq!(changed_runs(&a, &b, 3), None);
    }

    #[test]
    fn lines_keep_their_breaks_and_code_points_their_pairs() {
        let text: Vec<u16> = "a\nb\nc".encode_utf16().collect();
        let lines: Vec<String> =
            split_lines(&text).into_iter().map(String::from_utf16_lossy).collect();
        assert_eq!(lines, ["a\n", "b\n", "c"]);
        let emoji: Vec<u16> = "x\u{1F535}y".encode_utf16().collect();
        assert_eq!(code_points(&emoji).len(), 3);
    }
}
