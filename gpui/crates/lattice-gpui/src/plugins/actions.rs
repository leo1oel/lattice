//! The text edits behind a plugin's bibliography actions, as the Tauri
//! app's (`src/plugins/plugin-bib.ts`, `appendBibEntry`): the palette
//! shows the entry (or the entry as it is now beside the plugin's) and
//! `shell/plugin_actions.rs` writes the change once the writer confirms,
//! worked out again on the file as it is then.

use lattice_core::bib_document;
use lattice_i18n::t;

/// The keys of the entries in `text`, as written.
fn keys(text: &str) -> Vec<String> {
    bib_document::parse(text)
        .map(|parsed| parsed.entries.into_iter().map(|entry| entry.key).collect())
        .unwrap_or_default()
}

/// Entry `key` (any case) as written in `source`, with where it is; an
/// error when the file can't be read as BibTeX.
pub fn find_entry(source: &str, key: &str) -> Result<Option<(String, usize, usize)>, String> {
    let parsed = bib_document::parse(source)
        .map_err(|_| t!("The bibliography can’t be read, so nothing was changed.").to_string())?;
    Ok(parsed
        .entries
        .iter()
        .find(|entry| entry.key.eq_ignore_ascii_case(key))
        .map(|entry| {
            (
                source[entry.from..entry.to].to_string(),
                entry.from,
                entry.to,
            )
        }))
}

/// `existing` with `entry` (one entry) appended after a blank line.
pub fn append_entry(existing: &str, entry: &str) -> Result<String, String> {
    let added = keys(entry);
    let [key] = added.as_slice() else {
        return Err(t!("Add exactly one bibliography entry at a time.").to_string());
    };
    if keys(existing)
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(key))
    {
        return Err(t!(
            "Citation key ''{key}'' already exists. Choose a different key or edit the existing reference.",
            key = key
        ));
    }
    let trimmed = existing.trim_end();
    let terminated = if entry.ends_with('\n') {
        entry.to_string()
    } else {
        format!("{entry}\n")
    };
    Ok(if trimmed.is_empty() {
        terminated
    } else {
        format!("{trimmed}\n\n{terminated}")
    })
}

/// `source` with entry `key` replaced by `bibtex`; an error when the entry
/// is gone.
pub fn replace_entry(source: &str, key: &str, bibtex: &str) -> Result<String, String> {
    let Some((_, from, to)) = find_entry(source, key)? else {
        return Err(t!(
            "There is no entry “{key}” to update any more.",
            key = key
        ));
    };
    Ok(format!(
        "{}{}{}",
        &source[..from],
        bibtex.trim(),
        &source[to..]
    ))
}
