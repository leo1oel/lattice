//! Combining a file both sides changed since the last sync.
//!
//! A line merge alone is too coarse for LaTeX: a paragraph is one line, so two
//! people editing different sentences of it touch the same line and a line
//! merge has to call it a conflict (LATA-51). So a merge runs on segments, a
//! line each for code and data, a sentence each for prose, and only edits to
//! the same segment conflict. Overleaf's own editor goes further still (it
//! transforms single characters); a sentence is the smallest unit two
//! independent edits can both land in and still read as written.
//!
//! A conflict is written with standard markers, always on whole lines, so
//! every resolver (the inline one in each editor, the resolver dialog, Git)
//! reads it: the segments in conflict are widened to the lines that hold them,
//! the rest of those lines repeated on both sides.

pub(super) const OURS_LABEL: &str = "This Mac";
pub(super) const BASE_LABEL: &str = "Last sync";
pub(super) const THEIRS_LABEL: &str = "Overleaf";

/// What a merge of two edited copies came to.
#[derive(Debug, PartialEq)]
pub(super) enum TextMerge {
    /// Both sides' edits, combined.
    Clean(String),
    /// Overlapping edits, each spot marked with both sides.
    Conflicted(String),
}

/// Prose merges sentence by sentence; anything else line by line.
pub(super) fn is_prose(rel: &str) -> bool {
    const PROSE: &[&str] = &[".tex", ".ltx", ".md", ".markdown", ".txt", ".rmd", ".qmd"];
    let lower = rel.to_ascii_lowercase();
    PROSE.iter().any(|suffix| lower.ends_with(suffix))
}

/// Merge `ours` and `theirs` against `base`, the copy both grew from.
pub(super) fn merge_text(base: &str, ours: &str, theirs: &str, prose: bool) -> TextMerge {
    let encode = |text: &str| encode(&segments(text, prose));
    let mut options = diffy::MergeOptions::new();
    options.set_conflict_style(diffy::ConflictStyle::Diff3);
    match options.merge(&encode(base), &encode(ours), &encode(theirs)) {
        Ok(merged) => TextMerge::Clean(decode_all(&merged)),
        Err(conflicted) => match &parse(&conflicted)[..] {
            [Chunk::Common(text)] => TextMerge::Clean(text.clone()),
            chunks => TextMerge::Conflicted(render(chunks)),
        },
    }
}

/// Two copies with no common ancestor (a file new on both sides): whatever
/// they share at the start and the end stands, and the rest is one spot to
/// resolve, rather than a duplicate of the whole file.
pub(super) fn merge_without_base(ours: &str, theirs: &str) -> String {
    let (a, b) = (lines(ours), lines(theirs));
    let head = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let tail =
        (a[head..].iter().rev()).zip(b[head..].iter().rev()).take_while(|(x, y)| x == y).count();
    let common = |parts: &[&str]| parts.concat();
    let chunks = vec![
        Chunk::Common(common(&a[..head])),
        Chunk::Conflict {
            ours: common(&a[head..a.len() - tail]),
            base: None,
            theirs: common(&b[head..b.len() - tail]),
        },
        Chunk::Common(common(&a[a.len() - tail..])),
    ];
    render(&chunks)
}

fn lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

/// The units a merge compares: lines, or for prose the sentences of each line
/// (a sentence ends at `.`, `?` or `!` followed by spaces, which it keeps).
fn segments(text: &str, prose: bool) -> Vec<&str> {
    if !prose {
        return lines(text);
    }
    let mut parts = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0;
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        at += 1;
        if byte == b'\n' {
            parts.push(&text[start..at]);
            start = at;
        } else if matches!(byte, b'.' | b'?' | b'!') && bytes.get(at) == Some(&b' ') {
            while bytes.get(at) == Some(&b' ') {
                at += 1;
            }
            parts.push(&text[start..at]);
            start = at;
        }
    }
    if start < bytes.len() {
        parts.push(&text[start..]);
    }
    parts
}

/// Each segment as one line diffy can compare, prefixed so no segment is
/// ever read as one of its markers.
fn encode(parts: &[&str]) -> String {
    let mut out = String::new();
    for part in parts {
        out.push('~');
        out.push_str(&part.replace('\\', "\\\\").replace('\n', "\\n"));
        out.push('\n');
    }
    out
}

fn decode(line: &str) -> String {
    let mut out = String::new();
    let mut chars = line.strip_prefix('~').unwrap_or(line).chars();
    while let Some(c) = chars.next() {
        match (c, c == '\\') {
            (_, true) => match chars.next() {
                Some('n') => out.push('\n'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            },
            (c, false) => out.push(c),
        }
    }
    out
}

fn decode_all(encoded: &str) -> String {
    encoded.lines().map(decode).collect()
}

#[derive(Debug, PartialEq)]
enum Chunk {
    Common(String),
    Conflict { ours: String, base: Option<String>, theirs: String },
}

/// diffy's marked-up output, back into text and spots. diffy, like diff3,
/// calls edits to neighbouring segments a conflict; edits that touch
/// different segments are combined here instead.
fn parse(conflicted: &str) -> Vec<Chunk> {
    let mut chunks: Vec<Chunk> = Vec::new();
    let push_common = |chunks: &mut Vec<Chunk>, text: String| match chunks.last_mut() {
        Some(Chunk::Common(common)) => common.push_str(&text),
        _ => chunks.push(Chunk::Common(text)),
    };
    // 0 common, 1 ours, 2 base, 3 theirs.
    let mut section = 0;
    let mut sides: [Vec<String>; 3] = Default::default();
    let mut has_base = false;
    let mut common = String::new();
    for line in conflicted.lines() {
        if line.starts_with('~') {
            match section {
                0 => common.push_str(&decode(line)),
                n => sides[n - 1].push(decode(line)),
            }
        } else if line.starts_with("<<<<<<<") {
            push_common(&mut chunks, std::mem::take(&mut common));
            section = 1;
        } else if line.starts_with("|||||||") {
            has_base = true;
            section = 2;
        } else if line.starts_with("=======") {
            section = 3;
        } else if line.starts_with(">>>>>>>") {
            let [ours, base, theirs] = std::mem::take(&mut sides);
            match has_base.then(|| combine_apart(&ours, &base, &theirs)).flatten() {
                Some(text) => push_common(&mut chunks, text),
                None => chunks.push(Chunk::Conflict {
                    ours: ours.concat(),
                    base: has_base.then(|| base.concat()),
                    theirs: theirs.concat(),
                }),
            }
            (section, has_base) = (0, false);
        }
    }
    push_common(&mut chunks, common);
    chunks
}

/// Both sides' edits to one stretch of the base, when each rewrote different
/// segments of it. Only rewrites combine: an insertion or a deletion next to
/// the other side's edit stays a conflict, since whether a sentence added at
/// the end of a paragraph still belongs once the other side deleted that
/// paragraph is the writers' call.
fn combine_apart(ours: &[String], base: &[String], theirs: &[String]) -> Option<String> {
    let changed = |side: &[String]| {
        let head = side.iter().zip(base).take_while(|(a, b)| a == b).count();
        let room = side.len().min(base.len()) - head;
        let tail = (side.iter().rev())
            .zip(base.iter().rev())
            .take(room)
            .take_while(|(a, b)| a == b)
            .count();
        (head, base.len() - tail, side.len() - tail)
    };
    let (o_from, o_to, o_end) = changed(ours);
    let (t_from, t_to, t_end) = changed(theirs);
    let rewrites = o_from < o_to && o_from < o_end && t_from < t_to && t_from < t_end;
    if !rewrites {
        return None;
    }
    let apart = |a_to: usize, b_from: usize| a_to <= b_from;
    let joined = |first: (&[String], usize, usize, usize),
                  second: (&[String], usize, usize, usize)| {
        let (a, a_from, a_to, a_end) = first;
        let (b, b_from, b_to, b_end) = second;
        [&base[..a_from], &a[a_from..a_end], &base[a_to..b_from], &b[b_from..b_end], &base[b_to..]]
            .concat()
            .concat()
    };
    if apart(o_to, t_from) {
        Some(joined((ours, o_from, o_to, o_end), (theirs, t_from, t_to, t_end)))
    } else if apart(t_to, o_from) {
        Some(joined((theirs, t_from, t_to, t_end), (ours, o_from, o_to, o_end)))
    } else {
        None
    }
}

/// Spots widened to whole lines, written with markers. Spots that share a
/// line become one.
fn render(chunks: &[Chunk]) -> String {
    let mut out = String::new();
    // An open spot: each side so far, base None when no side had one.
    let mut open: Option<(String, Option<String>, String)> = None;
    for chunk in chunks {
        match chunk {
            Chunk::Common(text) => {
                let line_done = |side: &String| side.is_empty() || side.ends_with('\n');
                if (open.as_ref()).is_some_and(|(ours, base, theirs)| {
                    line_done(ours) && line_done(theirs) && base.as_ref().is_none_or(line_done)
                }) {
                    write_spot(&mut out, open.take().unwrap());
                }
                let Some((ours, base, theirs)) = open.as_mut() else {
                    // Up to the last line break stands; the rest leads the next spot.
                    let split = text.rfind('\n').map_or(0, |at| at + 1);
                    out.push_str(&text[..split]);
                    if split < text.len() {
                        let lead = text[split..].to_string();
                        open = Some((lead.clone(), Some(lead.clone()), lead));
                    }
                    continue;
                };
                // The rest of the spot's last line joins it.
                let Some(at) = text.find('\n') else {
                    for side in [Some(ours), base.as_mut(), Some(theirs)].into_iter().flatten() {
                        side.push_str(text);
                    }
                    continue;
                };
                let (rest_of_line, after) = text.split_at(at + 1);
                for side in [Some(ours), base.as_mut(), Some(theirs)].into_iter().flatten() {
                    side.push_str(rest_of_line);
                }
                write_spot(&mut out, open.take().unwrap());
                let split = after.rfind('\n').map_or(0, |at| at + 1);
                out.push_str(&after[..split]);
                if split < after.len() {
                    let lead = after[split..].to_string();
                    open = Some((lead.clone(), Some(lead.clone()), lead));
                }
            }
            Chunk::Conflict { ours: o, base: b, theirs: t } => {
                let (ours, base, theirs) =
                    open.get_or_insert_with(|| (String::new(), Some(String::new()), String::new()));
                ours.push_str(o);
                theirs.push_str(t);
                match (base.as_mut(), b) {
                    (Some(base), Some(b)) => base.push_str(b),
                    _ => *base = None,
                }
            }
        }
    }
    if let Some(spot) = open {
        write_spot(&mut out, spot);
    }
    out
}

fn write_spot(out: &mut String, (ours, base, theirs): (String, Option<String>, String)) {
    // A spot whose sides came out alike after widening is no spot.
    if ours == theirs {
        out.push_str(&ours);
        return;
    }
    let side = |out: &mut String, text: &str| {
        out.push_str(text);
        if !text.is_empty() && !text.ends_with('\n') {
            out.push('\n');
        }
    };
    out.push_str(&format!("<<<<<<< {OURS_LABEL}\n"));
    side(out, &ours);
    if let Some(base) = base {
        out.push_str(&format!("||||||| {BASE_LABEL}\n"));
        side(out, &base);
    }
    out.push_str("=======\n");
    side(out, &theirs);
    out.push_str(&format!(">>>>>>> {THEIRS_LABEL}\n"));
}

#[cfg(test)]
mod tests;
