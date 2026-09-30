//! Small text, hashing and filesystem helpers shared across the host.

use scraper::{Html, Selector};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::fs;
use std::io;
use std::path::Path;

/// Lowercase hex SHA-256 of `bytes`.
pub(crate) fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// `text` with every run of whitespace collapsed to one space and the ends
/// trimmed.
pub(crate) fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// At most `limit` characters, not bytes, with `…` appended when anything was
/// cut.
///
/// Slicing a `&str` at a byte offset panics when the offset lands inside a
/// character, and these strings are lines of someone's writing — an em dash
/// or an accent near the cut would take the whole command down.
pub(crate) fn truncate_chars(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((offset, _)) => format!("{}…", &text[..offset]),
        None => text.to_string(),
    }
}

/// Percent-encodes every byte that is not an unreserved URL character, for
/// opaque strings (ids, paths, file names) spliced into a URL.
pub(crate) fn url_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// `text` with its HTML character references (`&amp;`, `&#39;`, `&eacute;`)
/// decoded the way a browser decodes them in element text. Everything else,
/// including a `<` that is not written as a reference, is kept as it is.
pub(crate) fn decode_html_entities(text: &str) -> Cow<'_, str> {
    if !text.contains('&') {
        return Cow::Borrowed(text);
    }
    // `<textarea>` content is RCDATA: the parser decodes references in it but
    // reads no markup, and escaping every `<` keeps the text from closing it.
    // The parser drops one newline right after the start tag, hence the `\n`.
    let escaped = text.replace('<', "&lt;");
    let fragment = Html::parse_fragment(&format!("<textarea>\n{escaped}</textarea>"));
    Cow::Owned(fragment.root_element().text().collect())
}

/// `value`, the raw text of an attribute value, with its character references
/// decoded the way a browser decodes them in an attribute: a legacy named
/// reference without `;` stays as written when a letter, digit or `=` follows
/// it, so `?a=1&region=eu` keeps its query.
pub(crate) fn decode_html_attribute(value: &str) -> Cow<'_, str> {
    if !value.contains('&') {
        return Cow::Borrowed(value);
    }
    let escaped = value.replace('"', "&quot;");
    let fragment = Html::parse_fragment(&format!("<div title=\"{escaped}\"></div>"));
    let div = Selector::parse("div").expect("valid selector");
    let decoded = fragment.select(&div).next().and_then(|element| element.value().attr("title"));
    Cow::Owned(decoded.unwrap_or_default().to_string())
}

/// The step of [`swap_in_dir`] that failed, so each caller can word it.
#[derive(Debug)]
pub(crate) enum DirSwapError {
    /// `destination` could not be inspected.
    Inspect(io::Error),
    /// The existing `destination` could not be moved aside.
    Backup(io::Error),
    /// `staged` could not be moved into place; `restore` is the error from
    /// putting the previous copy back, if there was one and that failed too.
    Activate { error: io::Error, restore: Option<io::Error> },
    /// The new copy is in place, but the previous one could not be deleted.
    RemoveBackup(io::Error),
}

/// Replace `destination` with the finished `staged` directory. The previous
/// copy is moved aside to `destination` with `backup_extension` until the new
/// one is in, and moved back if the swap fails, so a failure never leaves
/// neither. A symlink at `destination` counts as a previous copy.
pub(crate) fn swap_in_dir(
    staged: &Path, destination: &Path, backup_extension: &str,
) -> Result<(), DirSwapError> {
    let backup = match fs::symlink_metadata(destination) {
        Ok(_) => {
            let backup = destination.with_extension(backup_extension);
            fs::rename(destination, &backup).map_err(DirSwapError::Backup)?;
            Some(backup)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(DirSwapError::Inspect(error)),
    };
    if let Err(error) = fs::rename(staged, destination) {
        let restore = backup.and_then(|backup| fs::rename(backup, destination).err());
        return Err(DirSwapError::Activate { error, restore });
    }
    match backup {
        Some(backup) => fs::remove_dir_all(backup).map_err(DirSwapError::RemoveBackup),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers_handle_multibyte_text() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(truncate_chars("naïve — café", 5), "naïve…");
        assert_eq!(truncate_chars("short", 5), "short");
        assert_eq!(url_encode("my paper/é~x"), "my%20paper%2F%C3%A9~x");
        assert_eq!(collapse_whitespace("  a\u{a0}\tb\n\nc "), "a b c");
    }

    #[test]
    fn swap_in_dir_replaces_the_destination_or_restores_it() {
        let root = crate::test_support::TempDir::new("util-swap");
        let staged = root.join("staged");
        let destination = root.join("dest");
        let entries = |dir: &Path| {
            let mut names = fs::read_dir(dir)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                .collect::<Vec<_>>();
            names.sort();
            names
        };

        // Nothing there yet: the staged copy simply moves in.
        root.write("staged/new.txt", "one");
        swap_in_dir(&staged, &destination, "old-1").unwrap();
        assert_eq!(fs::read_to_string(destination.join("new.txt")).unwrap(), "one");

        // An existing copy is replaced, and its backup is gone afterwards.
        root.write("staged/new.txt", "two");
        swap_in_dir(&staged, &destination, "old-2").unwrap();
        assert_eq!(fs::read_to_string(destination.join("new.txt")).unwrap(), "two");
        assert_eq!(entries(&root), ["dest"]);

        // A staged copy that is missing fails the swap and puts the previous
        // copy back where it was.
        let failed = swap_in_dir(&staged, &destination, "old-3");
        assert!(matches!(failed, Err(DirSwapError::Activate { restore: None, .. })), "{failed:?}");
        assert_eq!(fs::read_to_string(destination.join("new.txt")).unwrap(), "two");
        assert_eq!(entries(&root), ["dest"]);
    }

    #[test]
    fn decode_html_entities_decodes_references_like_a_browser() {
        let cases = [
            ("plain", "plain"),
            ("a &lt;b&gt; &amp; &quot;c&quot;", "a <b> & \"c\""),
            ("Fran&ccedil;ois &#39;x&#x27; &#128512;", "François 'x' 😀"),
            ("&nbsp;&mdash;&hellip;", "\u{a0}—…"),
            ("AT&T &unknown; a & b", "AT&T &unknown; a & b"),
            ("a < b </textarea> &lt;/textarea&gt;", "a < b </textarea> </textarea>"),
            ("\nlead\ttab", "\nlead\ttab"),
            ("&amp;lt;", "&lt;"),
            // Malformed references resolve as HTML specifies: legacy names
            // without `;`, and code points that are not characters.
            ("&copy 2020 &notit;", "© 2020 ¬it;"),
            ("&#0; &#x110000;", "\u{fffd} \u{fffd}"),
        ];
        for (html, text) in cases {
            assert_eq!(decode_html_entities(html), text, "{html:?}");
        }
        assert!(matches!(decode_html_entities("no references"), Cow::Borrowed(_)));
    }

    #[test]
    fn decode_html_attribute_decodes_references_like_a_browser() {
        let cases = [
            ("plain", "plain"),
            ("/favicon.ico?v=2&region=eu", "/favicon.ico?v=2&region=eu"),
            ("?a=1&notify=x&times=2&copy=3&para&sect9", "?a=1&notify=x&times=2&copy=3¶&sect9"),
            ("a &lt;b&gt; &amp; &quot;c&quot; \"d\" 'e' <f>", "a <b> & \"c\" \"d\" 'e' <f>"),
            ("Fran&ccedil;ois &#39;x&#x27; &#128512; &copy 2020", "François 'x' 😀 © 2020"),
            ("AT&T &unknown; a & b &amp;lt;", "AT&T &unknown; a & b &lt;"),
            ("\nlead\ttab", "\nlead\ttab"),
        ];
        for (html, text) in cases {
            assert_eq!(decode_html_attribute(html), text, "{html:?}");
        }
        assert!(matches!(decode_html_attribute("no references"), Cow::Borrowed(_)));
    }
}
