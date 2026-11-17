//! What a plugin's bibliography actions change, worked out before the
//! writer is asked (`shell/plugin_actions.rs` asks and writes): the file's
//! next text, so the confirmation shows exactly what Save writes, and the
//! write is checked against the text it was worked out from.

use lattice_core::bib_document;
use lattice_i18n::t;

/// A plugin's proposed change to a bibliography.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BibChange {
    Add { bibtex: String },
    Replace { key: String, bibtex: String },
}

/// The change worked out: the entry's key, the file's text after it, and
/// the entry as it stands now (a replacement's `before`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BibPlan {
    pub key: String,
    pub after: String,
    pub replaced: Option<String>,
}

/// The key of the one entry `bibtex` holds (the host checked it holds one).
pub fn entry_key(bibtex: &str) -> Option<String> {
    let parsed = bib_document::parse(bibtex).ok()?;
    parsed.entries.first().map(|entry| entry.key.clone())
}

/// `change` applied to the bibliography's `text`, or why it cannot be.
pub fn plan(text: &str, change: &BibChange) -> Result<BibPlan, String> {
    let parsed = bib_document::parse(text)
        .map_err(|_| t!("The bibliography can’t be read, so nothing was changed.").to_string())?;
    let find = |key: &str| {
        parsed
            .entries
            .iter()
            .find(|entry| entry.key.eq_ignore_ascii_case(key))
    };
    match change {
        BibChange::Add { bibtex } => {
            let key = entry_key(bibtex)
                .ok_or_else(|| t!("The plugin’s entry can’t be read.").to_string())?;
            if find(&key).is_some() {
                return Err(t!("The bibliography already has an entry “{0}”.", key));
            }
            let entry = bibtex.trim();
            let after = if text.trim_end().is_empty() {
                format!("{entry}\n")
            } else {
                format!("{}\n\n{entry}\n", text.trim_end())
            };
            Ok(BibPlan {
                key,
                after,
                replaced: None,
            })
        }
        BibChange::Replace { key, bibtex } => {
            let entry = find(key).ok_or_else(|| t!("The bibliography has no entry “{0}”.", key))?;
            let before = &text[entry.from..entry.to];
            let after = format!(
                "{}{}{}",
                &text[..entry.from],
                bibtex.trim(),
                &text[entry.to..]
            );
            Ok(BibPlan {
                key: key.clone(),
                after,
                replaced: Some(before.to_string()),
            })
        }
    }
}

/// A replacement as lines the confirmation shows: removed lines with "−",
/// added ones with "+", the rest as they are.
pub fn diff_lines(before: &str, after: &str) -> String {
    let diff = similar::TextDiff::from_lines(before, after);
    let mut out = String::new();
    for change in diff.iter_all_changes() {
        let sign = match change.tag() {
            similar::ChangeTag::Delete => "− ",
            similar::ChangeTag::Insert => "+ ",
            similar::ChangeTag::Equal => "  ",
        };
        out.push_str(sign);
        out.push_str(change.value().trim_end_matches('\n'));
        out.push('\n');
    }
    out.trim_end().to_string()
}
