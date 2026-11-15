//! The annotation itself, as the Tauri app's `editor-comment-data.ts` has
//! it: a note anchored on a passage of a source file by its offsets, its
//! quote and the 32 characters on either side, so it finds its passage again
//! after edits elsewhere. The stored shape is lattice-core's `EditorComment`
//! (`.research/annotations.json`), the file both apps read and write.
//!
//! Offsets are the Tauri app's: UTF-16 code units of the file's text, as
//! JavaScript strings count them. The GPUI editor counts bytes, so every
//! offset crossing between the two goes through [`Utf16`].

use chrono::{DateTime, Local, Utc};
use lattice_core::project::{EditorComment, EditorCommentReply};
use lattice_i18n::{Locale, t, tc};

/// How many characters of context a note keeps on either side of its quote.
pub const CONTEXT: usize = 32;

/// What the writer asks of the agent on a note, stored as these words
/// (`ANNOTATION_INTENTS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent {
    Rewrite,
    Shorten,
    Clarify,
    Cite,
    Fix,
}

impl Intent {
    pub const ALL: [Intent; 5] = [
        Intent::Rewrite,
        Intent::Shorten,
        Intent::Clarify,
        Intent::Cite,
        Intent::Fix,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Intent::Rewrite => "rewrite",
            Intent::Shorten => "shorten",
            Intent::Clarify => "clarify",
            Intent::Cite => "cite",
            Intent::Fix => "fix",
        }
    }

    pub fn parse(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|intent| intent.key() == key)
    }

    /// The chip's label (`useIntentLabels`).
    pub fn label(self) -> &'static str {
        match self {
            Intent::Rewrite => t!("Rewrite"),
            Intent::Shorten => t!("Shorten"),
            Intent::Clarify => t!("Clarify"),
            Intent::Cite => t!("Add a citation"),
            Intent::Fix => t!("Fix"),
        }
    }
}

/// Where an annotation stands, as its card and pin show it
/// (`annotationStatus`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Open,
    Proposed,
    Asked,
    Accepted,
    Rejected,
    Failed,
    Resolved,
}

impl Status {
    pub fn of(comment: &EditorComment) -> Self {
        let state = comment
            .revision
            .as_ref()
            .map(|revision| revision.state.as_str());
        if state == Some("accepted") {
            return Status::Accepted;
        }
        if comment.resolved {
            return Status::Resolved;
        }
        match state {
            Some("proposed") => Status::Proposed,
            Some("asked") => Status::Asked,
            Some("rejected") => Status::Rejected,
            Some("failed") => Status::Failed,
            _ => Status::Open,
        }
    }

    /// What the card's status chip says (the panel's `statusLabels`).
    pub fn label(self) -> &'static str {
        match self {
            Status::Open => tc!("annotation filter", "Open"),
            Status::Proposed => t!("Proposed"),
            Status::Asked => t!("Needs your answer"),
            Status::Accepted => t!("Accepted"),
            Status::Rejected => t!("Rejected"),
            Status::Failed => t!("Could not revise"),
            Status::Resolved => t!("Resolved"),
        }
    }
}

/// A local annotation, as opposed to an Overleaf thread or a citation reason:
/// it takes a pin.
pub fn is_note(comment: &EditorComment) -> bool {
    comment.citation.is_none()
}

/// The number the next annotation's pin takes.
pub fn next_number(annotations: &[EditorComment]) -> u32 {
    annotations
        .iter()
        .map(|annotation| annotation.number)
        .max()
        .unwrap_or(0)
        + 1
}

/// What a card says of a note: its words, else the intent it asks for
/// (`annotationNote`).
pub fn note_text(comment: &EditorComment) -> String {
    if !comment.body.is_empty() {
        return comment.body.clone();
    }
    comment
        .intent
        .as_deref()
        .and_then(Intent::parse)
        .map(|intent| intent.label().to_string())
        .unwrap_or_default()
}

/// The name a note is signed with: the stored "Anonymous" sentinel (or no
/// name) reads as the interface's word for it.
pub fn author_display(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "Anonymous" {
        t!("Anonymous").to_string()
    } else {
        trimmed.to_string()
    }
}

/// A text's UTF-16 and byte offsets, converted both ways.
pub struct Utf16<'a> {
    text: &'a str,
}

impl<'a> Utf16<'a> {
    pub fn new(text: &'a str) -> Self {
        Self { text }
    }

    /// The byte offset of UTF-16 offset `units`, or `None` past the end or
    /// inside a surrogate pair.
    pub fn to_byte(&self, units: usize) -> Option<usize> {
        let mut counted = 0;
        for (byte, ch) in self.text.char_indices() {
            if counted == units {
                return Some(byte);
            }
            counted += ch.len_utf16();
            if counted > units {
                return None;
            }
        }
        (counted == units).then_some(self.text.len())
    }

    /// The UTF-16 offset of byte `byte` (clamped to a character boundary
    /// before it).
    pub fn to_units(&self, byte: usize) -> usize {
        let mut byte = byte.min(self.text.len());
        while !self.text.is_char_boundary(byte) {
            byte -= 1;
        }
        self.text[..byte].encode_utf16().count()
    }
}

/// The span of `text` a note quotes, as byte offsets, found again
/// (`resolveCommentAnchor`): at its stored offsets when the quote is still
/// there; else by its quote with the context around it, when that occurs
/// once; else by its quote alone, when that occurs once. A quote that
/// repeats without its context cannot be placed safely, so it is not.
pub fn resolve_anchor(
    text: &str,
    from: u32,
    to: u32,
    quote: &str,
    prefix: &str,
    suffix: &str,
) -> Option<std::ops::Range<usize>> {
    let units = Utf16::new(text);
    if to > from
        && let (Some(start), Some(end)) = (units.to_byte(from as usize), units.to_byte(to as usize))
        && text.get(start..end) == Some(quote)
    {
        return Some(start..end);
    }
    if quote.is_empty() {
        return None;
    }
    if !prefix.is_empty() || !suffix.is_empty() {
        let needle = format!("{prefix}{quote}{suffix}");
        if let Some(at) = text.find(&needle) {
            if occurs_after(text, &needle, at) {
                return None;
            }
            let start = at + prefix.len();
            return Some(start..start + quote.len());
        }
    }
    let at = text.find(quote)?;
    // Without its context, a repeated quote could land on unrelated text.
    if occurs_after(text, quote, at) {
        return None;
    }
    Some(at..at + quote.len())
}

/// Whether `needle` occurs again in `text` after its occurrence at byte `at`
/// (`indexOf(needle, at + 1)`).
fn occurs_after(text: &str, needle: &str, at: usize) -> bool {
    let step = text[at..].chars().next().map_or(1, char::len_utf8);
    text[at + step..].contains(needle)
}

/// A comment's span in `text`, found again.
pub fn anchor_of(text: &str, comment: &EditorComment) -> Option<std::ops::Range<usize>> {
    // A citation reason is placed nowhere by its quote: the panel lists only
    // those whose cite is gone, and its stale context could name some other
    // cite (`annotationAnchor`).
    if comment.citation.is_some() {
        return None;
    }
    resolve_anchor(
        text,
        comment.from,
        comment.to,
        &comment.quote,
        &comment.prefix,
        &comment.suffix,
    )
}

/// The `CONTEXT` characters before byte `start` and after byte `end`.
pub fn context(text: &str, start: usize, end: usize) -> (String, String) {
    let prefix: String = {
        let before: Vec<char> = text[..start].chars().rev().take(CONTEXT).collect();
        before.into_iter().rev().collect()
    };
    let suffix: String = text[end..].chars().take(CONTEXT).collect();
    (prefix, suffix)
}

/// Who writes a note.
#[derive(Clone, Debug)]
pub struct Author {
    pub id: String,
    pub name: String,
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// A new note on bytes `start..end` of `text` in `path`
/// (`createEditorComment`); `None` for an empty or blank passage.
pub fn new_note(
    path: &str,
    text: &str,
    start: usize,
    end: usize,
    body: &str,
    intent: Option<Intent>,
    author: &Author,
) -> Option<EditorComment> {
    let (start, end) = (start.min(end), end.max(start).min(text.len()));
    let quote = text.get(start..end)?;
    if quote.trim().is_empty() {
        return None;
    }
    let (prefix, suffix) = context(text, start, end);
    let units = Utf16::new(text);
    let at = now();
    Some(EditorComment {
        id: uuid::Uuid::new_v4().to_string(),
        number: 0,
        path: path.replace('\\', "/"),
        from: units.to_units(start) as u32,
        to: units.to_units(end) as u32,
        quote: quote.to_string(),
        prefix,
        suffix,
        body: body.trim().to_string(),
        intent: intent.map(|intent| intent.key().to_string()),
        pdf: None,
        revision: None,
        citation: None,
        author_id: author.id.clone(),
        author_name: signed(&author.name),
        resolved: false,
        replies: Vec::new(),
        created_at: at.clone(),
        updated_at: at,
    })
}

/// A reply, or `None` for a blank one (`createEditorCommentReply`).
pub fn new_reply(body: &str, author: &Author) -> Option<EditorCommentReply> {
    let body = body.trim();
    (!body.is_empty()).then(|| EditorCommentReply {
        id: uuid::Uuid::new_v4().to_string(),
        author_id: author.id.clone(),
        author_name: signed(&author.name),
        body: body.to_string(),
        created_at: now(),
    })
}

/// The stored sentinel for a writer without a name.
fn signed(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        "Anonymous".into()
    } else {
        name.into()
    }
}

/// Mark `comment` as changed now.
pub fn touch(comment: &mut EditorComment) {
    comment.updated_at = now();
}

/// "3 minutes ago", or "3 min. ago" in the short style, as
/// `Intl.RelativeTimeFormat` with `numeric: "auto"` says it
/// (`formatCommentTimestamp`); past a week, the date.
pub fn relative_time(iso: &str, short: bool) -> String {
    let Ok(then) = DateTime::parse_from_rfc3339(iso) else {
        return iso.to_string();
    };
    relative_time_at(
        then.with_timezone(&Utc),
        Utc::now(),
        short,
        lattice_i18n::locale(),
    )
}

fn relative_time_at(
    then: DateTime<Utc>,
    now: DateTime<Utc>,
    short: bool,
    locale: Locale,
) -> String {
    let chinese = locale.is_chinese();
    let seconds = (now - then).num_seconds();
    let elapsed = (seconds as f64).round() as i64;
    if elapsed < 45 {
        return if chinese { "现在" } else { "now" }.into();
    }
    let minutes = (elapsed as f64 / 60.).round() as i64;
    if minutes < 60 {
        return match (chinese, short, minutes) {
            (true, _, n) => format!("{n}分钟前"),
            (false, true, n) => format!("{n} min. ago"),
            (false, false, 1) => "1 minute ago".into(),
            (false, false, n) => format!("{n} minutes ago"),
        };
    }
    let hours = (minutes as f64 / 60.).round() as i64;
    if hours < 24 {
        return match (chinese, short, hours) {
            (true, _, n) => format!("{n}小时前"),
            (false, true, n) => format!("{n} hr. ago"),
            (false, false, 1) => "1 hour ago".into(),
            (false, false, n) => format!("{n} hours ago"),
        };
    }
    let days = (hours as f64 / 24.).round() as i64;
    if days < 7 {
        return match (chinese, days) {
            (true, 1) => "昨天".into(),
            (true, n) => format!("{n}天前"),
            (false, 1) => "yesterday".into(),
            (false, n) => format!("{n} days ago"),
        };
    }
    let local = then.with_timezone(&Local);
    if chinese {
        local.format("%Y/%-m/%-d").to_string()
    } else {
        local.format("%-m/%-d/%Y").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(text: &str, quote: &str) -> EditorComment {
        let at = text.find(quote).unwrap();
        new_note(
            "main.tex",
            text,
            at,
            at + quote.len(),
            "Tighten this",
            None,
            &Author {
                id: "me".into(),
                name: " ".into(),
            },
        )
        .unwrap()
    }

    #[test]
    fn a_note_counts_its_offsets_in_utf16_units() {
        let text = "Ünïcode 𝒳 then the claim follows.";
        let comment = note(text, "the claim");
        let units = Utf16::new(text);
        assert_eq!(units.to_byte(comment.from as usize), text.find("the claim"));
        assert_eq!(comment.to - comment.from, 9);
        assert_eq!(comment.author_name, "Anonymous");
        assert_eq!(
            anchor_of(text, &comment),
            text.find("the claim").map(|at| at..at + 9)
        );
    }

    #[test]
    fn a_note_finds_its_passage_after_an_edit_before_it() {
        let text = "Intro. The claim follows. Outro.";
        let comment = note(text, "claim");
        let edited = "A longer intro sentence. The claim follows. Outro.";
        let at = edited.find("claim").unwrap();
        assert_eq!(anchor_of(edited, &comment), Some(at..at + 5));
    }

    #[test]
    fn a_repeated_quote_without_its_context_is_not_placed() {
        let text = "alpha beta alpha";
        let mut comment = note(text, "beta");
        comment.quote = "alpha".into();
        comment.prefix.clear();
        comment.suffix.clear();
        comment.from = 100;
        assert_eq!(anchor_of(text, &comment), None);
        comment.quote = "beta".into();
        assert_eq!(anchor_of(text, &comment), Some(6..10));
    }

    #[test]
    fn a_blank_passage_takes_no_note() {
        let author = Author {
            id: "me".into(),
            name: "Ada".into(),
        };
        assert!(new_note("a.tex", "a   b", 1, 4, "x", None, &author).is_none());
    }

    #[test]
    fn statuses_follow_the_revision_and_resolution() {
        let mut comment = note("one two", "two");
        assert_eq!(Status::of(&comment), Status::Open);
        comment.resolved = true;
        assert_eq!(Status::of(&comment), Status::Resolved);
        comment.revision = Some(lattice_core::project::AnnotationRevision {
            round: 1,
            state: "accepted".into(),
            original: None,
            text: None,
            reason: None,
            question: None,
            answer: None,
            error: None,
        });
        assert_eq!(Status::of(&comment), Status::Accepted);
    }

    #[test]
    fn times_read_as_the_relative_time_format_says_them() {
        let now = Utc::now();
        let ago = |seconds: i64| now - chrono::Duration::seconds(seconds);
        assert_eq!(relative_time_at(ago(10), now, true, Locale::En), "now");
        assert_eq!(
            relative_time_at(ago(180), now, true, Locale::En),
            "3 min. ago"
        );
        assert_eq!(
            relative_time_at(ago(180), now, false, Locale::En),
            "3 minutes ago"
        );
        assert_eq!(
            relative_time_at(ago(7200), now, true, Locale::En),
            "2 hr. ago"
        );
        assert_eq!(
            relative_time_at(ago(86_400), now, true, Locale::En),
            "yesterday"
        );
        assert_eq!(
            relative_time_at(ago(180), now, true, Locale::ZhCn),
            "3分钟前"
        );
    }
}
