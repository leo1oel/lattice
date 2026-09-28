//! Small text and hashing helpers shared across the host.

use sha2::{Digest, Sha256};

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
}
