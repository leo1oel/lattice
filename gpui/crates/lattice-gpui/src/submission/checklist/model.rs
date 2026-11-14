//! The submission checklist's rules, ported from the Tauri app's
//! `manuscript-checklist.tsx` and `submission-item-state.ts`: what each
//! automatic row says, how far a count sits from its limit, where the main
//! body ends (`findBodyEnd` in `latex-outline.ts`), and the verdict over
//! every result. A result that cannot be settled (no budget, an unmeasured
//! count, no build yet) never counts as a pass.

use std::{path::Path, sync::LazyLock};

use lattice_core::{latex::BodySpan, models::SubmissionItem};
use lattice_i18n::{format_count, space_mixed_script, t};
use regex::Regex;

/// Where the main body ends, before its appendix or references.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Body {
    /// Nothing ends the body early: the whole PDF is the body.
    None,
    /// A file the root document includes before the end could not be read.
    Unread,
    /// The end was found in the source but not placed in the PDF.
    Unresolved,
    Resolved {
        main_pages: u32,
    },
}

/// What ends the body: an appendix, or the references.
static BODY_END: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\\(?:appendix(?:[^A-Za-z@]|$)|begin\{appendices\}|bibliography\s*\{|printbibliography(?:[^A-Za-z@]|$)|begin\{thebibliography\})",
    )
    .expect("the body end pattern compiles")
});
static INCLUDE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\\(?:input|include)\s*\{([^}]*)\}").expect("the include pattern compiles")
});

/// The first place on `line` that ends the body, not after a backslash
/// (`\\appendix` is a line break, then a word).
fn body_end_in(line: &str) -> Option<usize> {
    BODY_END
        .find_iter(line)
        .map(|found| found.start())
        .find(|at| *at == 0 || line.as_bytes()[at - 1] != b'\\')
}

/// The source the body is read from (each file whole, the lines before the
/// end in the file holding it and in each file on the way there), `Unread`
/// when the walk met a file it could not read before the end, or `None`
/// when nothing ends the body early. `read` gives a project file's text.
pub enum BodyEnd {
    Spans(Vec<BodySpan>),
    Unread,
    None,
}

pub fn find_body_end(
    root: &Path,
    document: &str,
    read: &dyn Fn(&str) -> Option<String>,
) -> BodyEnd {
    #[allow(clippy::too_many_arguments)]
    fn walk(
        root: &Path,
        document: &str,
        path: &str,
        depth: usize,
        seen: &mut Vec<String>,
        unread: &mut bool,
        spans: &mut Vec<BodySpan>,
        read: &dyn Fn(&str) -> Option<String>,
    ) -> bool {
        if depth > 8 || seen.iter().any(|done| done == path) {
            return false;
        }
        seen.push(path.to_string());
        let Some(source) = read(path) else {
            *unread = true;
            return false;
        };
        let visible = crate::outline::visible_source(&source);
        for (index, line) in visible.split('\n').enumerate() {
            let end = body_end_in(line).unwrap_or(usize::MAX);
            // The line's includes before the end are read first, and may end
            // the body themselves.
            let ended = INCLUDE.captures_iter(line).any(|include| {
                let at = include.get(0).map_or(usize::MAX, |found| found.start());
                at < end
                    && crate::outline::resolve(root, document, include[1].trim()).is_some_and(
                        |included| {
                            walk(
                                root,
                                document,
                                &included,
                                depth + 1,
                                seen,
                                unread,
                                spans,
                                read,
                            )
                        },
                    )
            }) || end != usize::MAX;
            if ended {
                spans.push(BodySpan {
                    path: path.to_string(),
                    before: Some(index as u32 + 1),
                });
                return true;
            }
        }
        spans.push(BodySpan {
            path: path.to_string(),
            before: None,
        });
        false
    }
    let mut spans = Vec::new();
    let mut unread = false;
    let ended = walk(
        root,
        document,
        document,
        0,
        &mut Vec::new(),
        &mut unread,
        &mut spans,
        read,
    );
    if unread {
        BodyEnd::Unread
    } else if ended {
        BodyEnd::Spans(spans)
    } else {
        BodyEnd::None
    }
}

/// A blank or non-numeric budget clears the limit.
pub fn parse_budget(value: &str) -> Option<u32> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    value
        .parse::<f64>()
        .ok()
        .filter(|budget| budget.is_finite())
        .map(|budget| budget.max(0.).floor() as u32)
}

pub fn word_distance(count: u32, limit: u32) -> String {
    let gap = count.abs_diff(limit);
    let amount = format_count(gap as i64);
    if gap == 0 {
        t!("At the limit").to_string()
    } else if count < limit {
        if gap == 1 {
            t!("1 word remaining").to_string()
        } else {
            space_mixed_script(&t!("{amount} words remaining", amount = amount))
        }
    } else if gap == 1 {
        t!("1 word over").to_string()
    } else {
        space_mixed_script(&t!("{amount} words over", amount = amount))
    }
}

pub fn page_distance(count: u32, limit: u32) -> String {
    let gap = count.abs_diff(limit);
    if gap == 0 {
        t!("At the limit").to_string()
    } else if count < limit {
        if gap == 1 {
            t!("1 page remaining").to_string()
        } else {
            t!("{gap} pages remaining", gap = gap)
        }
    } else if gap == 1 {
        t!("1 page over").to_string()
    } else {
        t!("{gap} pages over", gap = gap)
    }
}

/// A limit as the row's detail says it.
pub fn word_limit_note(limit: Option<u32>) -> Option<String> {
    limit.map(|limit| {
        if limit == 1 {
            t!("Limit 1 word").to_string()
        } else {
            space_mixed_script(&t!(
                "Limit {wordLimit} words",
                wordLimit = format_count(limit as i64)
            ))
        }
    })
}

pub fn page_limit_note(limit: Option<u32>) -> Option<String> {
    limit.map(|limit| {
        if limit == 1 {
            t!("Limit 1 page").to_string()
        } else {
            t!("Limit {pageLimit} pages", pageLimit = limit)
        }
    })
}

pub fn with_limit(detail: String, limit: Option<String>) -> String {
    match limit {
        Some(limit) => t!("{detail}. {limit}", detail = detail, limit = limit),
        None => detail,
    }
}

/// The pages the page budget counts: the main body's, the whole PDF's when
/// nothing ends the body early, none while that is not known.
pub fn counted_pages(total: Option<u32>, body: Body) -> Option<u32> {
    match (total, body) {
        (Some(total), Body::None) => Some(total),
        (Some(_), Body::Resolved { main_pages }) => Some(main_pages),
        _ => None,
    }
}

pub fn page_detail(total: Option<u32>, body: Body, limit: Option<u32>) -> Option<String> {
    let note = page_limit_note(limit);
    let Some(total) = total else { return note };
    match body {
        Body::Unread => Some(with_limit(
            t!(
                "{totalPages} total, included files not read",
                totalPages = total
            ),
            note,
        )),
        Body::Unresolved => Some(with_limit(
            t!(
                "{totalPages} total, end of the body not located in the PDF",
                totalPages = total
            ),
            note,
        )),
        Body::Resolved { main_pages } if main_pages != total => Some(t!(
            "{totalPages} total, body ends on p.{mainPages}",
            totalPages = total,
            mainPages = main_pages
        )),
        _ => None,
    }
}

/// Where a writer's item stands once its linked file is taken into account:
/// a file gone, or changed after the item was confirmed, asks to be looked
/// at again whatever the stored status says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemCondition {
    Todo,
    Review,
    Confirmed,
    Missing,
    Changed,
    /// A confirmed item whose file has not been read yet.
    Pending,
}

/// A linked file's disk state, as `stat_project_file` reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileStat {
    pub exists: bool,
    pub mtime_ms: u64,
}

pub fn item_condition(item: &SubmissionItem, stat: Option<FileStat>) -> ItemCondition {
    let stored = match item.status.as_str() {
        "confirmed" => ItemCondition::Confirmed,
        "review" => ItemCondition::Review,
        _ => ItemCondition::Todo,
    };
    if item.file.is_none() {
        return stored;
    }
    if stat.is_some_and(|stat| !stat.exists) {
        return ItemCondition::Missing;
    }
    if stored != ItemCondition::Confirmed {
        return stored;
    }
    match stat {
        None => ItemCondition::Pending,
        Some(stat) if Some(stat.mtime_ms) == item.confirmed_mtime_ms => ItemCondition::Confirmed,
        Some(_) => ItemCondition::Changed,
    }
}

/// The item's result for the verdict: only a confirmation that still holds passes.
pub fn item_passes(condition: ItemCondition) -> Option<bool> {
    match condition {
        ItemCondition::Confirmed => Some(true),
        ItemCondition::Pending => None,
        _ => Some(false),
    }
}

/// The verdict over every result, and the counts the track's end shows.
pub struct Verdict {
    pub text: String,
    pub passing: usize,
    pub total: usize,
}

pub fn verdict(checks: &[Option<bool>]) -> Verdict {
    let failing = checks.iter().filter(|check| **check == Some(false)).count();
    let passing = checks.iter().filter(|check| **check == Some(true)).count();
    let unsettled = checks.len() - passing - failing;
    let text = if failing > 0 {
        if failing == 1 {
            t!("1 check needs attention").to_string()
        } else {
            t!("{failing} checks need attention", failing = failing)
        }
    } else if unsettled > 0 {
        t!("Nothing blocks submission").to_string()
    } else {
        t!("Ready to submit").to_string()
    };
    Verdict {
        text,
        passing,
        total: checks.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn spans(end: BodyEnd) -> Vec<(String, Option<u32>)> {
        match end {
            BodyEnd::Spans(spans) => spans
                .into_iter()
                .map(|span| (span.path, span.before))
                .collect(),
            BodyEnd::Unread => vec![("unread".into(), None)],
            BodyEnd::None => vec![],
        }
    }

    #[test]
    fn the_body_ends_at_the_appendix_or_the_references_through_includes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("sec")).unwrap();
        let files = HashMap::from([
            (
                "main.tex",
                "\\begin{document}\n\\input{sec/intro}\n\\input{sec/end}\nmore\n",
            ),
            ("sec/intro.tex", "Intro.\n% \\appendix in a comment\n"),
            ("sec/end.tex", "Results.\n\\appendix\nProofs.\n"),
        ]);
        for (path, text) in &files {
            std::fs::write(root.join(path), text).unwrap();
        }
        let read = |path: &str| files.get(path).map(|text| text.to_string());
        assert_eq!(
            spans(find_body_end(root, "main.tex", &read)),
            [
                ("sec/intro.tex".to_string(), None),
                ("sec/end.tex".to_string(), Some(2)),
                ("main.tex".to_string(), Some(3)),
            ]
        );
        // A line break before the word is no appendix; nothing ends the body.
        let plain = |_: &str| Some("text \\\\appendix here\n".to_string());
        assert!(matches!(
            find_body_end(root, "main.tex", &plain),
            BodyEnd::None
        ));
        let missing = |path: &str| (path == "main.tex").then(|| "\\input{sec/intro}\n".to_string());
        assert!(matches!(
            find_body_end(root, "main.tex", &missing),
            BodyEnd::Unread
        ));
    }

    #[test]
    fn budgets_and_distances_read_as_the_tauri_app_writes_them() {
        assert_eq!(parse_budget(" 8000 "), Some(8000));
        assert_eq!(parse_budget("12.7"), Some(12));
        assert_eq!(parse_budget(""), None);
        assert_eq!(parse_budget("lots"), None);
        assert_eq!(word_distance(7_400, 8_000), "600 words remaining");
        assert_eq!(word_distance(8_001, 8_000), "1 word over");
        assert_eq!(page_distance(9, 9), "At the limit");
        assert_eq!(page_distance(11, 9), "2 pages over");
        assert_eq!(
            counted_pages(Some(12), Body::Resolved { main_pages: 9 }),
            Some(9)
        );
        assert_eq!(counted_pages(Some(12), Body::Unread), None);
        assert_eq!(
            page_detail(Some(12), Body::Resolved { main_pages: 9 }, Some(9)).as_deref(),
            Some("12 total, body ends on p.9")
        );
    }

    #[test]
    fn only_a_confirmation_that_still_holds_passes() {
        let item = |status: &str, file: Option<&str>, confirmed: Option<u64>| SubmissionItem {
            id: "a".into(),
            title: "Supplement".into(),
            status: status.into(),
            file: file.map(String::from),
            source: None,
            source_checked: None,
            owner: None,
            confirmed_mtime_ms: confirmed,
        };
        let stat = |exists, mtime_ms| Some(FileStat { exists, mtime_ms });
        let signed = item("confirmed", Some("supp.pdf"), Some(5));
        assert_eq!(
            item_condition(&signed, stat(true, 5)),
            ItemCondition::Confirmed
        );
        assert_eq!(
            item_condition(&signed, stat(true, 6)),
            ItemCondition::Changed
        );
        assert_eq!(
            item_condition(&signed, stat(false, 0)),
            ItemCondition::Missing
        );
        assert_eq!(item_condition(&signed, None), ItemCondition::Pending);
        assert_eq!(
            item_condition(&item("review", None, None), None),
            ItemCondition::Review
        );
        assert_eq!(item_passes(ItemCondition::Pending), None);
        let ready = verdict(&[Some(true), Some(true)]);
        assert_eq!(
            (ready.text.as_str(), ready.passing, ready.total),
            ("Ready to submit", 2, 2)
        );
        assert_eq!(
            verdict(&[Some(true), None]).text,
            "Nothing blocks submission"
        );
        assert_eq!(
            verdict(&[Some(false), Some(false), None]).text,
            "2 checks need attention"
        );
    }
}
