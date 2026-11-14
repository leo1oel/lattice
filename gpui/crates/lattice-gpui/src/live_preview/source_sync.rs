//! Keeping rtex's copy of each project file in step with Lattice's
//! (`src/live-preview/rtex-source-sync.ts`, adapted there from
//! realtime-tex-vsc-plugin's `src/edits.ts`, MIT License, Copyright (c) 2026
//! Henry Yang; see THIRD_PARTY_NOTICES.md).
//!
//! Lattice hands over whole texts, not the editor's change list, so
//! `SourceSync` finds the changed range itself. rtex edits in UTF-8 byte
//! offsets, which a Rust string already is, so the Tauri app's UTF-16 offset
//! checkpoints have no counterpart here. Pure module.

use std::collections::HashMap;

use super::protocol::Command;

/// A rewrite of more than this many bytes, and of most of the file, is sent
/// whole rather than as an edit.
const WHOLE_FILE: usize = 4096;

/// The one change that turns `before` into `after`, as the byte range of
/// `before` it replaces and the text put there: their common start and end
/// set aside, never splitting a character. Typing changes one place, so this
/// is the keystroke itself; a paste or an outside rewrite is one wider
/// change.
pub fn text_change(before: &str, after: &str) -> Option<(usize, usize, String)> {
    if before == after {
        return None;
    }
    let (a, b) = (before.as_bytes(), after.as_bytes());
    let max = a.len().min(b.len());
    let mut start = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    while !before.is_char_boundary(start) || !after.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = a
        .iter()
        .rev()
        .zip(b.iter().rev())
        .take(max - start)
        .take_while(|(x, y)| x == y)
        .count();
    while !before.is_char_boundary(a.len() - end) || !after.is_char_boundary(b.len() - end) {
        end -= 1;
    }
    Some((start, a.len() - end, after[start..b.len() - end].to_string()))
}

/// rtex's copy of each file it has been sent, as commands that bring it to
/// a new text. A file rtex loaded itself is known by its text on disk, which
/// the caller supplies the first time it names the file.
#[derive(Default)]
pub struct SourceSync {
    shadows: HashMap<String, String>,
}

impl SourceSync {
    /// The commands that make rtex's `path` read `text`; `base` is its text
    /// when not yet known.
    pub fn update(&mut self, path: &str, text: &str, base: &str) -> Vec<Command> {
        let shadow = self
            .shadows
            .entry(path.to_string())
            .or_insert_with(|| base.to_string());
        let Some((start, end, replacement)) = text_change(shadow, text) else {
            return Vec::new();
        };
        let replaced = end - start;
        // A rewrite of most of the file is cheaper to send whole than to
        // diff in rtex.
        if replaced > WHOLE_FILE && replaced > shadow.len() / 2 {
            *shadow = text.to_string();
            return vec![Command::SetDocument {
                path: path.to_string(),
                text: text.to_string(),
            }];
        }
        *shadow = text.to_string();
        vec![Command::Edit {
            path: path.to_string(),
            start,
            end,
            text: replacement,
        }]
    }

    /// Record what rtex read of `path` from disk, unless its copy is
    /// already known.
    pub fn seed(&mut self, path: &str, text: String) {
        self.shadows.entry(path.to_string()).or_insert(text);
    }

    /// The command that replaces rtex's `path` with `text`, unless it
    /// already reads that.
    pub fn replace(&mut self, path: &str, text: &str) -> Option<Command> {
        if self.shadows.get(path).is_some_and(|shadow| shadow == text) {
            return None;
        }
        self.shadows.insert(path.to_string(), text.to_string());
        Some(Command::SetDocument {
            path: path.to_string(),
            text: text.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Apply a byte edit as rtex would.
    fn apply(text: &str, (start, end, replacement): (usize, usize, String)) -> String {
        format!("{}{}{}", &text[..start], replacement, &text[end..])
    }

    #[test]
    fn a_keystroke_is_one_small_edit() {
        let change = text_change("Hello world", "Hello, world").unwrap();
        assert_eq!(change, (5, 5, ",".into()));
        assert_eq!(text_change("same", "same"), None);
        let deleted = text_change("abcdef", "abef").unwrap();
        assert_eq!(deleted, (2, 4, String::new()));
    }

    #[test]
    fn changes_never_split_a_character() {
        for (before, after) in [
            ("é", "è"),
            ("aé b", "aè b"),
            ("中文", "中字"),
            ("x😀y", "x😁y"),
            ("😀", ""),
            ("", "日本"),
        ] {
            let change = text_change(before, after).unwrap();
            assert!(before.is_char_boundary(change.0) && before.is_char_boundary(change.1));
            assert_eq!(apply(before, change), after, "{before} → {after}");
        }
    }

    #[test]
    fn the_sync_sends_edits_against_rtexs_copy() {
        let mut sync = SourceSync::default();
        let first = sync.update("main.tex", "Hello there", "Hello");
        assert_eq!(
            first,
            vec![Command::Edit {
                path: "main.tex".into(),
                start: 5,
                end: 5,
                text: " there".into()
            }]
        );
        assert!(sync.update("main.tex", "Hello there", "ignored").is_empty());
        // A rewrite of most of a long file goes whole.
        let long = "a".repeat(10_000);
        sync.update("main.tex", &long, "");
        let rewrite = "b".repeat(9_000);
        let whole = sync.update("main.tex", &rewrite, "");
        assert!(matches!(&whole[..], [Command::SetDocument { .. }]));
        sync.seed("other.tex", "on disk".into());
        assert_eq!(sync.replace("other.tex", "on disk"), None);
        assert!(sync.replace("other.tex", "changed").is_some());
    }
}
